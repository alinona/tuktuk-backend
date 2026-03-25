const express=require('express'),cors=require('cors'),{Pool}=require('pg'),jwt=require('jsonwebtoken'),{Vonage}=require('@vonage/server-sdk'),{createServer}=require('http'),{Server}=require('socket.io');
require('dotenv').config();

const app=express();
const httpServer=createServer(app);
const io=new Server(httpServer,{cors:{origin:'*'}});

app.use(cors());
app.use(express.json());

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.DATABASE_URL&&process.env.DATABASE_URL.includes('railway')?false:{rejectUnauthorized:false},
  max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:10000
});

const vonage=new Vonage({apiKey:process.env.VONAGE_API_KEY,apiSecret:process.env.VONAGE_API_SECRET});
const otpStore=new Map();
const driverSockets=new Map(); // driver_id → socket_id
const tripTimers=new Map();    // trip_id → timer

const err500=(res,e,m='خطأ')=>{console.error(m,e.message);res.status(500).json({success:false,error:m});};
const genOTP=()=>Math.floor(100000+Math.random()*900000).toString();
const iraqPhone=(p)=>/^\+9647[0-9]{9}$/.test(p);

function calcPrice(km,covered=false){
  const r=Math.round(km*2)/2;
  let p=500+(r*500);
  if(covered)p+=500;
  const h=new Date().getHours();
  let surge=0,label=null;
  if(h>=0&&h<6){surge=500;label='ليل';}
  else if((h>=6&&h<10)||(h>=16&&h<20)){surge=250;label='ذروة';}
  p+=surge;
  return{distance_km:r,base_price:500+(r*500),covered_extra:covered?500:0,surge_amount:surge,surge_type:label,total_price:p,commission:250,driver_net:p-250};
}

const auth=(req,res,next)=>{
  const t=req.headers.authorization?.split(' ')[1];
  if(!t)return res.status(401).json({success:false,error:'سجل دخولك'});
  try{req.user=jwt.verify(t,process.env.JWT_SECRET);next();}
  catch{res.status(401).json({success:false,error:'جلسة منتهية'});}
};
const driverOnly=(req,res,next)=>req.user.type==='driver'?next():res.status(403).json({success:false,error:'للسائقين فقط'});
const userOnly=(req,res,next)=>req.user.type==='user'?next():res.status(403).json({success:false,error:'للزبائن فقط'});

async function migrate(){
  const c=await pool.connect();
  try{
    await c.query(`
      CREATE TABLE IF NOT EXISTS zones(id SERIAL PRIMARY KEY,name VARCHAR(100) NOT NULL,city VARCHAR(100) DEFAULT 'البصرة',is_active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,phone VARCHAR(20) UNIQUE NOT NULL,name VARCHAR(100),first_ride_used BOOLEAN DEFAULT false,is_active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS drivers(id SERIAL PRIMARY KEY,phone VARCHAR(20) UNIQUE NOT NULL,name VARCHAR(100) NOT NULL,vehicle_type VARCHAR(50) DEFAULT 'تكتك مكشوف',plate VARCHAR(30),status VARCHAR(20) DEFAULT 'offline',rating NUMERIC(3,2) DEFAULT 5.00,wallet_balance INTEGER DEFAULT 0,wallet_id VARCHAR(20) UNIQUE,zone_id INTEGER REFERENCES zones(id),docs_verified BOOLEAN DEFAULT false,is_active BOOLEAN DEFAULT true,last_lat NUMERIC(10,7),last_lng NUMERIC(10,7),last_seen TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS wallets(id SERIAL PRIMARY KEY,driver_id INTEGER UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,wallet_code VARCHAR(20) UNIQUE NOT NULL,balance INTEGER DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS trips(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id),driver_id INTEGER REFERENCES drivers(id),status VARCHAR(30) DEFAULT 'searching',payment_method VARCHAR(20) DEFAULT 'cash',pickup_lat NUMERIC(10,7),pickup_lng NUMERIC(10,7),pickup_addr TEXT,dropoff_lat NUMERIC(10,7),dropoff_lng NUMERIC(10,7),dropoff_addr TEXT,distance_km NUMERIC(6,2),vehicle_type VARCHAR(50),price INTEGER,commission INTEGER DEFAULT 250,driver_net INTEGER,surge_type VARCHAR(20),started_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS transactions(id SERIAL PRIMARY KEY,driver_id INTEGER REFERENCES drivers(id),trip_id INTEGER REFERENCES trips(id),type VARCHAR(30) NOT NULL,amount INTEGER NOT NULL,direction VARCHAR(5) CHECK(direction IN('+','-')),balance_after INTEGER,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS gps_logs(id SERIAL PRIMARY KEY,driver_id INTEGER REFERENCES drivers(id),lat NUMERIC(10,7),lng NUMERIC(10,7),timestamp TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS disputes(id SERIAL PRIMARY KEY,trip_id INTEGER REFERENCES trips(id),reporter_id INTEGER,type VARCHAR(50),status VARCHAR(30) DEFAULT 'open',decision TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS promo_codes(id SERIAL PRIMARY KEY,code VARCHAR(50) UNIQUE NOT NULL,type VARCHAR(30),value INTEGER,uses_count INTEGER DEFAULT 0,max_uses INTEGER,expires_at TIMESTAMPTZ,is_active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT NOW());
    `);
    const z=await c.query('SELECT COUNT(*) FROM zones');
    if(parseInt(z.rows[0].count)===0){
      await c.query(`INSERT INTO zones(name,city) VALUES('البصرة المركز','البصرة'),('الزبير','البصرة'),('أبو الخصيب','البصرة'),('شط العرب','البصرة'),('القرنة','البصرة')`);
    }
    console.log('✅ الجداول جاهزة');
  }catch(e){console.error('❌',e.message);}
  finally{c.release();}
}

// ══════════════════════════════════════════════════════════
// 📡 SOCKET.IO — PART 4: GPS والتتبع المباشر
// ══════════════════════════════════════════════════════════
io.use((socket,next)=>{
  const token=socket.handshake.auth?.token;
  if(!token)return next(new Error('مطلوب token'));
  try{
    socket.user=jwt.verify(token,process.env.JWT_SECRET);
    next();
  }catch{next(new Error('token غير صحيح'));}
});

io.on('connection',(socket)=>{
  const{id,type}=socket.user;
  console.log(`🔌 اتصل: ${type} ${id}`);

  // السائق يسجل وجوده
  if(type==='driver'){
    driverSockets.set(id,socket.id);
    socket.join(`driver_${id}`);
  }
  if(type==='user'){
    socket.join(`user_${id}`);
  }

  // السائق يرسل موقعه كل 5 ثواني — RULE GPS
  socket.on('driver:location',async({lat,lng,trip_id})=>{
    if(type!=='driver')return;
    try{
      // حفظ آخر موقع
      await pool.query('UPDATE drivers SET last_lat=$1,last_lng=$2,last_seen=NOW() WHERE id=$3',[lat,lng,id]);
      // حفظ في gps_logs
      await pool.query('INSERT INTO gps_logs(driver_id,lat,lng) VALUES($1,$2,$3)',[id,lat,lng]);

      // إذا في رحلة — أرسل الموقع للزبون
      if(trip_id){
        const trip=await pool.query('SELECT user_id FROM trips WHERE id=$1 AND driver_id=$2',[trip_id,id]);
        if(trip.rowCount){
          io.to(`user_${trip.rows[0].user_id}`).emit('trip:driver_moved',{lat,lng,driver_id:id});
        }
      }
      // أرسل لداشبورد الإدارة
      io.to('admin_room').emit('admin:driver_location',{driver_id:id,lat,lng});
    }catch(e){console.error('GPS error:',e.message);}
  });

  // إشعار SOS — طوارئ
  socket.on('trip:sos',async({trip_id,lat,lng})=>{
    try{
      io.to('admin_room').emit('sos:alert',{trip_id,reporter_id:id,type,lat,lng,time:new Date()});
      console.log(`🚨 SOS من ${type} ${id} في رحلة ${trip_id}`);
    }catch(e){console.error('SOS error:',e.message);}
  });

  // الإدارة تنضم لغرفة خاصة
  socket.on('admin:join',()=>{
    if(type==='admin')socket.join('admin_room');
  });

  socket.on('disconnect',()=>{
    if(type==='driver'){
      driverSockets.delete(id);
      pool.query("UPDATE drivers SET status='offline' WHERE id=$1 AND status='online'",[id]).catch(()=>{});
    }
    console.log(`❌ انقطع: ${type} ${id}`);
  });
});

// دالة إرسال طلب رحلة للسائق (60 ثانية) — RULE_6
async function sendTripRequest(tripId,driverId){
  const socketId=driverSockets.get(driverId);
  if(!socketId)return false;

  const trip=await pool.query('SELECT * FROM trips WHERE id=$1',[tripId]);
  if(!trip.rowCount)return false;

  io.to(`driver_${driverId}`).emit('trip:new_request',{
    trip_id:tripId,
    pickup_addr:trip.rows[0].pickup_addr,
    dropoff_addr:trip.rows[0].dropoff_addr,
    price:trip.rows[0].price,
    distance_km:trip.rows[0].distance_km,
    timer_seconds:60
  });

  // 60 ثانية للرد — RULE_6
  const timer=setTimeout(async()=>{
    const current=await pool.query('SELECT status FROM trips WHERE id=$1',[tripId]);
    if(current.rows[0]?.status==='searching'){
      console.log(`⏰ السائق ${driverId} لم يرد على رحلة ${tripId}`);
      // يمكن إضافة منطق البحث عن سائق آخر هنا
    }
    tripTimers.delete(tripId);
  },60000);

  tripTimers.set(tripId,timer);
  return true;
}

// ══════════════════════════════════════════════════════════
// 🏠 HEALTH
// ══════════════════════════════════════════════════════════
app.use(express.static('public'));
app.get('/',(req,res)=>{
  const path=require('path');
  const fs=require('fs');
  const f=path.join(__dirname,'public','index.html');
  if(fs.existsSync(f)) res.sendFile(f);
  else res.json({success:true,message:'تكتك 🛺',version:'4.0.0'});
});
app.get('/health',async(req,res)=>{
  try{
    await pool.query('SELECT 1');
    res.json({success:true,db:'connected',server:'running',drivers_online:driverSockets.size});
  }catch(e){res.status(500).json({success:false,db:'disconnected'});}
});

// موقع السائقين المتصلين (للإدارة)
app.get('/api/drivers/locations',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,name,vehicle_type,rating,last_lat,last_lng,last_seen FROM drivers WHERE status='online' AND last_lat IS NOT NULL`);
    res.json({success:true,data:r.rows,online_count:driverSockets.size});
  }catch(e){err500(res,e,'فشل المواقع');}
});

// ══════════════════════════════════════════════════════════
// 🔐 AUTH
// ══════════════════════════════════════════════════════════
app.post('/api/auth/send-otp',async(req,res)=>{
  try{
    const{phone}=req.body;
    if(!phone||!iraqPhone(phone))return res.status(400).json({success:false,error:'رقم عراقي يبدأ بـ +9647'});
    const otp=genOTP();
    otpStore.set(phone,{otp,expires:Date.now()+5*60*1000});
    await vonage.sms.send({to:phone.replace('+',''),from:'TukTuk',text:`كودك: ${otp} — صالح 5 دقائق`});
    console.log(`OTP ${phone}: ${otp}`);
    res.json({success:true,message:'تم إرسال الكود'});
  }catch(e){err500(res,e,'فشل OTP');}
});

app.post('/api/auth/verify-otp',async(req,res)=>{
  try{
    const{phone,otp}=req.body;
    if(!phone||!otp)return res.status(400).json({success:false,error:'أرسل الهاتف والكود'});
    const s=otpStore.get(phone);
    if(!s)return res.status(400).json({success:false,error:'لا يوجد كود'});
    if(Date.now()>s.expires){otpStore.delete(phone);return res.status(400).json({success:false,error:'انتهى الكود'});}
    if(s.otp!==otp)return res.status(400).json({success:false,error:'كود خاطئ'});
    otpStore.delete(phone);
    const dr=await pool.query('SELECT * FROM drivers WHERE phone=$1',[phone]);
    const ur=await pool.query('SELECT * FROM users WHERE phone=$1',[phone]);
    let id,type,data;
    if(dr.rowCount>0){data=dr.rows[0];id=data.id;type='driver';}
    else if(ur.rowCount>0){data=ur.rows[0];id=data.id;type='user';}
    else{const n=await pool.query('INSERT INTO users(phone) VALUES($1) RETURNING *',[phone]);data=n.rows[0];id=data.id;type='user';}
    const token=jwt.sign({id,phone,type},process.env.JWT_SECRET,{expiresIn:'30d'});
    res.json({success:true,token,user_type:type,user:{id:data.id,phone:data.phone,name:data.name||null}});
  }catch(e){err500(res,e,'فشل verify');}
});

app.post('/api/auth/register-driver',async(req,res)=>{
  try{
    const{phone,name,vehicle_type,plate,zone_id}=req.body;
    if(!phone||!name||!vehicle_type||!plate)return res.status(400).json({success:false,error:'بيانات ناقصة'});
    if(!iraqPhone(phone))return res.status(400).json({success:false,error:'رقم غير صحيح'});
    const ex=await pool.query('SELECT id FROM drivers WHERE phone=$1',[phone]);
    if(ex.rowCount>0)return res.status(409).json({success:false,error:'الرقم مسجل'});
    const cnt=await pool.query('SELECT COUNT(*) FROM drivers');
    const wid=`TK-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
    const d=await pool.query(`INSERT INTO drivers(phone,name,vehicle_type,plate,zone_id,wallet_id,status) VALUES($1,$2,$3,$4,$5,$6,'offline') RETURNING id,phone,name,vehicle_type,plate,wallet_id,status`,[phone,name,vehicle_type,plate,zone_id||1,wid]);
    await pool.query('INSERT INTO wallets(driver_id,wallet_code,balance) VALUES($1,$2,0)',[d.rows[0].id,wid]);
    res.status(201).json({success:true,message:'تم التسجيل، انتظر الموافقة',driver:d.rows[0]});
  }catch(e){err500(res,e,'فشل تسجيل السائق');}
});

app.get('/api/auth/me',auth,async(req,res)=>{
  try{
    const{id,type}=req.user;
    const r=type==='driver'
      ?await pool.query('SELECT d.*,w.balance as wallet_balance FROM drivers d LEFT JOIN wallets w ON w.driver_id=d.id WHERE d.id=$1',[id])
      :await pool.query('SELECT * FROM users WHERE id=$1',[id]);
    if(r.rowCount===0)return res.status(404).json({success:false,error:'غير موجود'});
    res.json({success:true,user_type:type,data:r.rows[0]});
  }catch(e){err500(res,e,'فشل me');}
});

// ══════════════════════════════════════════════════════════
// 🚗 TRIPS - PART 3
// ══════════════════════════════════════════════════════════
app.post('/api/trips',auth,userOnly,async(req,res)=>{
  try{
    const{pickup_lat,pickup_lng,pickup_addr,dropoff_lat,dropoff_lng,dropoff_addr,distance_km,vehicle_type,payment_method}=req.body;
    if(!pickup_lat||!pickup_lng||!dropoff_lat||!dropoff_lng||!distance_km)
      return res.status(400).json({success:false,error:'بيانات ناقصة'});
    const p=calcPrice(parseFloat(distance_km),vehicle_type==='تكتك مسقوف');
    const u=await pool.query('SELECT first_ride_used FROM users WHERE id=$1',[req.user.id]);
    const free=!u.rows[0].first_ride_used;
    const t=await pool.query(
      `INSERT INTO trips(user_id,status,payment_method,pickup_lat,pickup_lng,pickup_addr,dropoff_lat,dropoff_lng,dropoff_addr,distance_km,vehicle_type,price,commission,driver_net,surge_type)
       VALUES($1,'searching',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.id,payment_method||'cash',pickup_lat,pickup_lng,pickup_addr||'',dropoff_lat,dropoff_lng,dropoff_addr||'',p.distance_km,vehicle_type||'تكتك مكشوف',free?0:p.total_price,free?0:p.commission,free?0:p.driver_net,p.surge_type]
    );

    // ابحث عن أقرب سائق متصل وأرسل له الطلب — RULE_6
    const drivers=await pool.query(`SELECT id FROM drivers WHERE status='online' AND is_active=true AND docs_verified=true ORDER BY rating DESC LIMIT 1`);
    if(drivers.rowCount>0){
      await sendTripRequest(t.rows[0].id,drivers.rows[0].id);
    }

    res.status(201).json({success:true,trip:t.rows[0],price_info:p,is_free:free,message:free?'🎉 رحلتك الأولى مجانية!':'نبحث عن سائق...'});
  }catch(e){err500(res,e,'فشل الرحلة');}
});

app.get('/api/trips/:id',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT t.*,u.name as user_name,u.phone as user_phone,d.name as driver_name,d.phone as driver_phone,d.rating as driver_rating FROM trips t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN drivers d ON d.id=t.driver_id WHERE t.id=$1`,[req.params.id]);
    if(r.rowCount===0)return res.status(404).json({success:false,error:'غير موجودة'});
    res.json({success:true,data:r.rows[0]});
  }catch(e){err500(res,e,'فشل جلب الرحلة');}
});

app.post('/api/trips/:id/accept',auth,driverOnly,async(req,res)=>{
  try{
    const t=await pool.query('SELECT * FROM trips WHERE id=$1',[req.params.id]);
    if(!t.rowCount||t.rows[0].status!=='searching')return res.status(400).json({success:false,error:'الرحلة غير متاحة'});
    const w=await pool.query('SELECT balance FROM wallets WHERE driver_id=$1',[req.user.id]);
    if((w.rows[0]?.balance||0)<0)return res.status(400).json({success:false,error:'رصيدك سالب'});
    const u=await pool.query(`UPDATE trips SET status='accepted',driver_id=$1 WHERE id=$2 AND status='searching' RETURNING *`,[req.user.id,req.params.id]);
    if(!u.rowCount)return res.status(400).json({success:false,error:'قُبلت من سائق آخر'});

    // إلغاء المؤقت
    if(tripTimers.has(parseInt(req.params.id))){
      clearTimeout(tripTimers.get(parseInt(req.params.id)));
      tripTimers.delete(parseInt(req.params.id));
    }

    // إشعار الزبون
    io.to(`user_${t.rows[0].user_id}`).emit('trip:accepted',{trip_id:req.params.id,driver_id:req.user.id});

    res.json({success:true,message:'قبلت الرحلة ✅',trip:u.rows[0]});
  }catch(e){err500(res,e,'فشل القبول');}
});

app.post('/api/trips/:id/start',auth,driverOnly,async(req,res)=>{
  try{
    const u=await pool.query(`UPDATE trips SET status='ongoing',started_at=NOW() WHERE id=$1 AND driver_id=$2 AND status='accepted' RETURNING *`,[req.params.id,req.user.id]);
    if(!u.rowCount)return res.status(400).json({success:false,error:'لا يمكن البدء'});
    io.to(`user_${u.rows[0].user_id}`).emit('trip:started',{trip_id:req.params.id});
    res.json({success:true,message:'بدأت الرحلة 🚀',trip:u.rows[0]});
  }catch(e){err500(res,e,'فشل البدء');}
});

app.post('/api/trips/:id/complete',auth,driverOnly,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const tr=await c.query('SELECT * FROM trips WHERE id=$1 AND driver_id=$2',[req.params.id,req.user.id]);
    if(!tr.rowCount||tr.rows[0].status!=='ongoing'){await c.query('ROLLBACK');return res.status(400).json({success:false,error:'الرحلة ليست جارية'});}
    const trip=tr.rows[0];
    await c.query(`UPDATE trips SET status='completed',completed_at=NOW() WHERE id=$1`,[trip.id]);
    let newBal=0;
    if(trip.commission>0){
      const wb=await c.query('SELECT balance FROM wallets WHERE driver_id=$1',[req.user.id]);
      newBal=(wb.rows[0]?.balance||0)-trip.commission;
      await c.query('UPDATE wallets SET balance=$1,updated_at=NOW() WHERE driver_id=$2',[newBal,req.user.id]);
      await c.query('UPDATE drivers SET wallet_balance=$1 WHERE id=$2',[newBal,req.user.id]);
      await c.query(`INSERT INTO transactions(driver_id,trip_id,type,amount,direction,balance_after) VALUES($1,$2,'commission',$3,'-',$4)`,[req.user.id,trip.id,trip.commission,newBal]);
      if(newBal<0)await c.query(`UPDATE drivers SET status='suspended' WHERE id=$1`,[req.user.id]);
    }
    await c.query('UPDATE users SET first_ride_used=true WHERE id=$1',[trip.user_id]);
    await c.query('COMMIT');

    // إشعار الزبون بالإكمال
    io.to(`user_${trip.user_id}`).emit('trip:completed',{trip_id:trip.id,price:trip.price});

    res.json({success:true,message:'اكتملت الرحلة ✅',price:trip.price,commission:trip.commission,driver_net:trip.driver_net,new_balance:newBal});
  }catch(e){await c.query('ROLLBACK');err500(res,e,'فشل الإكمال');}
  finally{c.release();}
});

app.post('/api/trips/:id/cancel',auth,async(req,res)=>{
  try{
    const t=await pool.query('SELECT * FROM trips WHERE id=$1',[req.params.id]);
    if(!t.rowCount)return res.status(404).json({success:false,error:'غير موجودة'});
    if(['completed','cancelled'].includes(t.rows[0].status))return res.status(400).json({success:false,error:'لا يمكن الإلغاء'});
    await pool.query(`UPDATE trips SET status='cancelled' WHERE id=$1`,[req.params.id]);

    // إشعار الطرف الآخر
    if(t.rows[0].driver_id)io.to(`driver_${t.rows[0].driver_id}`).emit('trip:cancelled',{trip_id:req.params.id});
    io.to(`user_${t.rows[0].user_id}`).emit('trip:cancelled',{trip_id:req.params.id});

    res.json({success:true,message:'تم الإلغاء'});
  }catch(e){err500(res,e,'فشل الإلغاء');}
});

app.post('/api/trips/:id/rating',auth,userOnly,async(req,res)=>{
  try{
    const{score}=req.body;
    if(!score||score<1||score>5)return res.status(400).json({success:false,error:'التقييم 1-5'});
    const t=await pool.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
    if(!t.rowCount||t.rows[0].status!=='completed')return res.status(400).json({success:false,error:'لا يمكن التقييم'});
    const dr=await pool.query('SELECT rating FROM drivers WHERE id=$1',[t.rows[0].driver_id]);
    const newR=Math.min(5,Math.max(1,(parseFloat(dr.rows[0].rating)*0.8)+(score*0.2)));
    await pool.query('UPDATE drivers SET rating=$1 WHERE id=$2',[newR.toFixed(2),t.rows[0].driver_id]);
    res.json({success:true,message:'شكراً على تقييمك ⭐',new_rating:newR.toFixed(2)});
  }catch(e){err500(res,e,'فشل التقييم');}
});

app.get('/api/my-trips',auth,async(req,res)=>{
  try{
    const{id,type}=req.user;
    const r=type==='user'
      ?await pool.query(`SELECT t.*,d.name as driver_name FROM trips t LEFT JOIN drivers d ON d.id=t.driver_id WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 20`,[id])
      :await pool.query(`SELECT t.*,u.name as user_name FROM trips t LEFT JOIN users u ON u.id=t.user_id WHERE t.driver_id=$1 ORDER BY t.created_at DESC LIMIT 20`,[id]);
    res.json({success:true,data:r.rows,count:r.rowCount});
  }catch(e){err500(res,e,'فشل الرحلات');}
});

// ══════════════════════════════════════════════════════════
// 💰 WALLET
// ══════════════════════════════════════════════════════════
app.get('/api/driver/wallet',auth,driverOnly,async(req,res)=>{
  try{
    const w=await pool.query('SELECT * FROM wallets WHERE driver_id=$1',[req.user.id]);
    const t=await pool.query('SELECT * FROM transactions WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id]);
    res.json({success:true,wallet:w.rows[0],transactions:t.rows});
  }catch(e){err500(res,e,'فشل المحفظة');}
});

app.post('/api/driver/status',auth,driverOnly,async(req,res)=>{
  try{
    const{status}=req.body;
    if(!['online','offline'].includes(status))return res.status(400).json({success:false,error:'online أو offline'});
    await pool.query('UPDATE drivers SET status=$1 WHERE id=$2',[status,req.user.id]);
    res.json({success:true,message:`أنت ${status==='online'?'متصل 🟢':'غير متصل 🔴'}`,status});
  }catch(e){err500(res,e,'فشل الحالة');}
});

// ══════════════════════════════════════════════════════════
// 🗺️ GENERAL
// ══════════════════════════════════════════════════════════
app.get('/api/zones',async(req,res)=>{try{const r=await pool.query('SELECT * FROM zones WHERE is_active=true ORDER BY name ASC');res.json({success:true,data:r.rows});}catch(e){err500(res,e,'فشل المناطق');}});
app.get('/api/drivers/available',async(req,res)=>{try{const r=await pool.query(`SELECT id,name,vehicle_type,rating,zone_id,last_lat,last_lng FROM drivers WHERE status='online' AND is_active=true ORDER BY rating DESC`);res.json({success:true,data:r.rows,count:r.rowCount});}catch(e){err500(res,e,'فشل السائقين');}});
app.post('/api/price/calculate',(req,res)=>{const{distance_km,is_covered}=req.body;if(!distance_km||distance_km<=0)return res.status(400).json({success:false,error:'distance_km مطلوب'});res.json({success:true,data:calcPrice(parseFloat(distance_km),!!is_covered)});});
app.get('/api/stats',async(req,res)=>{try{const[d,t,z,e]=await Promise.all([pool.query('SELECT COUNT(*) FROM drivers WHERE is_active=true'),pool.query(`SELECT COUNT(*) FROM trips WHERE status IN('searching','accepted','ongoing')`),pool.query('SELECT COUNT(*) FROM zones WHERE is_active=true'),pool.query(`SELECT COALESCE(SUM(commission),0) AS total FROM trips WHERE status='completed'`)]);res.json({success:true,data:{active_drivers:parseInt(d.rows[0].count),active_trips:parseInt(t.rows[0].count),active_zones:parseInt(z.rows[0].count),total_earnings:parseInt(e.rows[0].total),drivers_online:driverSockets.size}});}catch(e){err500(res,e,'فشل الإحصائيات');}});

app.use((req,res)=>res.status(404).json({success:false,error:`${req.path} غير موجود`}));

const PORT=process.env.PORT||3000;
httpServer.listen(PORT,async()=>{
  console.log(`🛺 تكتك v4 على المنفذ ${PORT}`);
  await migrate();
});
