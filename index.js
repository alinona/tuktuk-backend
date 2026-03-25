const express=require('express'),cors=require('cors'),{Pool}=require('pg'),jwt=require('jsonwebtoken'),{Vonage}=require('@vonage/server-sdk'),{createServer}=require('http'),{Server}=require('socket.io'),path=require('path'),fs=require('fs');
require('dotenv').config();

const app=express();
const httpServer=createServer(app);
const io=new Server(httpServer,{cors:{origin:'*'}});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.DATABASE_URL&&process.env.DATABASE_URL.includes('railway')?false:{rejectUnauthorized:false},
  max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:10000
});

const vonage=new Vonage({apiKey:process.env.VONAGE_API_KEY,apiSecret:process.env.VONAGE_API_SECRET});
const otpStore=new Map();
const driverSockets=new Map();
const userSockets=new Map();

const e5=(res,e,m='خطأ')=>{console.error(m,e.message);res.status(500).json({success:false,error:m});};
const genOTP=()=>Math.floor(100000+Math.random()*900000).toString();
const iraqPhone=(p)=>/^\+9647[0-9]{9}$/.test(p);
const ADMIN_PHONE=process.env.ADMIN_PHONE||'+9647823210125';

function calcPrice(km,fast=false){
  const r=Math.round(km*2)/2;
  let p=500+(r*500);
  if(fast)p+=1000;
  const h=new Date().getHours();
  let surge=0,label=null;
  if(h>=0&&h<6){surge=500;label='ليل';}
  else if((h>=6&&h<10)||(h>=16&&h<20)){surge=250;label='ذروة';}
  p+=surge;
  return{distance_km:r,base_price:500+(r*500),fast_extra:fast?1000:0,surge_amount:surge,surge_type:label,total_price:p,commission:250,driver_net:p-250};
}

const auth=(req,res,next)=>{
  const t=req.headers.authorization?.split(' ')[1];
  if(!t)return res.status(401).json({success:false,error:'سجل دخولك'});
  try{req.user=jwt.verify(t,process.env.JWT_SECRET);next();}
  catch{res.status(401).json({success:false,error:'جلسة منتهية'});}
};
const driverOnly=(req,res,next)=>req.user.type==='driver'?next():res.status(403).json({success:false,error:'للسائقين فقط'});
const userOnly=(req,res,next)=>req.user.type==='user'?next():res.status(403).json({success:false,error:'للزبائن فقط'});
const adminOnly=(req,res,next)=>req.user.type==='admin'?next():res.status(403).json({success:false,error:'للإدارة فقط'});

// ══════════════════════════════════════════════════════════
// قاعدة البيانات
// ══════════════════════════════════════════════════════════
async function migrate(){
  const c=await pool.connect();
  try{
    await c.query(`
      CREATE TABLE IF NOT EXISTS zones(id SERIAL PRIMARY KEY,name VARCHAR(100) NOT NULL,city VARCHAR(100) DEFAULT 'البصرة',is_active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,phone VARCHAR(20) UNIQUE NOT NULL,name VARCHAR(100),first_ride_used BOOLEAN DEFAULT false,free_rides INTEGER DEFAULT 0,discount_percent INTEGER DEFAULT 0,reward_points INTEGER DEFAULT 0,is_active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS driver_requests(id SERIAL PRIMARY KEY,phone VARCHAR(20) UNIQUE NOT NULL,name VARCHAR(100) NOT NULL,vehicle_type VARCHAR(50) DEFAULT 'تكتك عادي',status VARCHAR(20) DEFAULT 'pending',rejection_reason TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS drivers(id SERIAL PRIMARY KEY,phone VARCHAR(20) UNIQUE NOT NULL,name VARCHAR(100) NOT NULL,vehicle_type VARCHAR(50) DEFAULT 'تكتك عادي',plate VARCHAR(30),status VARCHAR(20) DEFAULT 'offline',rating NUMERIC(3,2) DEFAULT 5.00,wallet_balance INTEGER DEFAULT 0,wallet_id VARCHAR(20) UNIQUE,zone_id INTEGER REFERENCES zones(id),docs_verified BOOLEAN DEFAULT false,is_active BOOLEAN DEFAULT true,last_lat NUMERIC(10,7),last_lng NUMERIC(10,7),last_seen TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS wallets(id SERIAL PRIMARY KEY,driver_id INTEGER UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,wallet_code VARCHAR(20) UNIQUE NOT NULL,balance INTEGER DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS trips(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id),driver_id INTEGER REFERENCES drivers(id),status VARCHAR(30) DEFAULT 'searching',payment_method VARCHAR(20) DEFAULT 'cash',pickup_lat NUMERIC(10,7),pickup_lng NUMERIC(10,7),pickup_addr TEXT,dropoff_lat NUMERIC(10,7),dropoff_lng NUMERIC(10,7),dropoff_addr TEXT,distance_km NUMERIC(6,2),vehicle_type VARCHAR(50),price INTEGER,commission INTEGER DEFAULT 250,driver_net INTEGER,surge_type VARCHAR(20),started_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS transactions(id SERIAL PRIMARY KEY,driver_id INTEGER REFERENCES drivers(id),trip_id INTEGER REFERENCES trips(id),type VARCHAR(30) NOT NULL,amount INTEGER NOT NULL,direction VARCHAR(5) CHECK(direction IN('+','-')),balance_after INTEGER,note TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS notifications(id SERIAL PRIMARY KEY,target_type VARCHAR(20) NOT NULL,target_id INTEGER,message TEXT NOT NULL,title VARCHAR(100),is_read BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS gps_logs(id SERIAL PRIMARY KEY,driver_id INTEGER REFERENCES drivers(id),lat NUMERIC(10,7),lng NUMERIC(10,7),timestamp TIMESTAMPTZ DEFAULT NOW());
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
// SOCKET.IO
// ══════════════════════════════════════════════════════════
io.use((socket,next)=>{
  const token=socket.handshake.auth?.token;
  if(!token)return next(new Error('مطلوب token'));
  try{socket.user=jwt.verify(token,process.env.JWT_SECRET);next();}
  catch{next(new Error('token غير صحيح'));}
});

io.on('connection',(socket)=>{
  const{id,type}=socket.user;
  if(type==='driver'){driverSockets.set(id,socket.id);socket.join(`driver_${id}`);}
  if(type==='user'){userSockets.set(id,socket.id);socket.join(`user_${id}`);}
  if(type==='admin'){socket.join('admin_room');}

  socket.on('driver:location',async({lat,lng,trip_id})=>{
    if(type!=='driver')return;
    try{
      await pool.query('UPDATE drivers SET last_lat=$1,last_lng=$2,last_seen=NOW() WHERE id=$3',[lat,lng,id]);
      await pool.query('INSERT INTO gps_logs(driver_id,lat,lng) VALUES($1,$2,$3)',[id,lat,lng]);
      if(trip_id){
        const trip=await pool.query('SELECT user_id FROM trips WHERE id=$1 AND driver_id=$2',[trip_id,id]);
        if(trip.rowCount) io.to(`user_${trip.rows[0].user_id}`).emit('trip:driver_moved',{lat,lng});
      }
      io.to('admin_room').emit('admin:driver_location',{driver_id:id,lat,lng});
    }catch(e){}
  });

  socket.on('trip:sos',({trip_id,lat,lng})=>{
    io.to('admin_room').emit('sos:alert',{trip_id,reporter_id:id,type,lat,lng,time:new Date()});
  });

  socket.on('disconnect',()=>{
    driverSockets.delete(id);userSockets.delete(id);
    if(type==='driver') pool.query("UPDATE drivers SET status='offline' WHERE id=$1 AND status='online'",[id]).catch(()=>{});
  });
});

function pushNotif(targetType,targetId,title,message){
  pool.query('INSERT INTO notifications(target_type,target_id,title,message) VALUES($1,$2,$3,$4)',[targetType,targetId,title,message]).catch(()=>{});
  if(targetType==='driver'&&driverSockets.has(targetId))
    io.to(`driver_${targetId}`).emit('notification',{title,message});
  if(targetType==='user'&&userSockets.has(targetId))
    io.to(`user_${targetId}`).emit('notification',{title,message});
}

// ══════════════════════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════════════════════
app.get('/health',async(req,res)=>{
  try{await pool.query('SELECT 1');res.json({success:true,db:'connected',drivers_online:driverSockets.size});}
  catch(e){res.status(500).json({success:false,db:'disconnected'});}
});

app.get('/api',(req,res)=>res.json({success:true,message:'تكتك API v5',version:'5.0.0'}));

// ══════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════
app.post('/api/auth/send-otp',async(req,res)=>{
  try{
    const{phone}=req.body;
    if(!phone||!iraqPhone(phone))return res.status(400).json({success:false,error:'رقم عراقي يبدأ بـ +9647'});
    const otp=genOTP();
    otpStore.set(phone,{otp,expires:Date.now()+5*60*1000});
    await vonage.sms.send({to:phone.replace('+',''),from:'TukTuk',text:`كودك في تِكتِك: ${otp}\nصالح 5 دقائق`});
    console.log(`OTP ${phone}: ${otp}`);
    res.json({success:true,message:'تم إرسال الكود'});
  }catch(e){e5(res,e,'فشل OTP');}
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

    // الإدارة
    if(phone===ADMIN_PHONE||phone==='+9647823210125'){
      const token=jwt.sign({id:0,phone,type:'admin'},process.env.JWT_SECRET,{expiresIn:'30d'});
      return res.json({success:true,token,user_type:'admin',user:{id:0,phone,name:'الإدارة'}});
    }

    const dr=await pool.query('SELECT * FROM drivers WHERE phone=$1',[phone]);
    const ur=await pool.query('SELECT * FROM users WHERE phone=$1',[phone]);
    let id,type,data;
    if(dr.rowCount>0){data=dr.rows[0];id=data.id;type='driver';}
    else if(ur.rowCount>0){data=ur.rows[0];id=data.id;type='user';}
    else{const n=await pool.query('INSERT INTO users(phone) VALUES($1) RETURNING *',[phone]);data=n.rows[0];id=data.id;type='user';}
    const token=jwt.sign({id,phone,type},process.env.JWT_SECRET,{expiresIn:'30d'});
    res.json({success:true,token,user_type:type,user:{id:data.id,phone:data.phone,name:data.name||null,docs_verified:data.docs_verified||false}});
  }catch(e){e5(res,e,'فشل verify');}
});

app.get('/api/auth/me',auth,async(req,res)=>{
  try{
    const{id,type}=req.user;
    if(type==='admin') return res.json({success:true,user_type:'admin',data:{phone:req.user.phone,name:'الإدارة'}});
    const r=type==='driver'
      ?await pool.query('SELECT d.*,w.balance as wallet_balance FROM drivers d LEFT JOIN wallets w ON w.driver_id=d.id WHERE d.id=$1',[id])
      :await pool.query('SELECT * FROM users WHERE id=$1',[id]);
    if(!r.rowCount)return res.status(404).json({success:false,error:'غير موجود'});
    res.json({success:true,user_type:type,data:r.rows[0]});
  }catch(e){e5(res,e,'فشل me');}
});

// ══════════════════════════════════════════════════════════
// DRIVER REGISTRATION REQUEST
// ══════════════════════════════════════════════════════════
app.post('/api/driver-requests',async(req,res)=>{
  try{
    const{phone,name,vehicle_type}=req.body;
    if(!phone||!name)return res.status(400).json({success:false,error:'بيانات ناقصة'});
    if(!iraqPhone(phone))return res.status(400).json({success:false,error:'رقم غير صحيح'});

    // فحص إذا موجود مسبقاً
    const ex=await pool.query('SELECT id,status FROM driver_requests WHERE phone=$1',[phone]);
    if(ex.rowCount>0){
      if(ex.rows[0].status==='pending')
        return res.status(409).json({success:false,error:'طلبك قيد المراجعة بالفعل'});
      if(ex.rows[0].status==='approved')
        return res.status(409).json({success:false,error:'تم قبولك مسبقاً'});
      // مرفوض — يمكن إعادة التقديم
      await pool.query('UPDATE driver_requests SET name=$1,vehicle_type=$2,status=$3,rejection_reason=NULL WHERE phone=$4',
        [name,vehicle_type||'تكتك عادي','pending',phone]);
      return res.json({success:true,message:'تم إعادة إرسال طلبك للمراجعة'});
    }

    await pool.query('INSERT INTO driver_requests(phone,name,vehicle_type) VALUES($1,$2,$3)',
      [phone,name,vehicle_type||'تكتك عادي']);

    // إشعار الإدارة
    io.to('admin_room').emit('admin:new_driver_request',{phone,name,vehicle_type});

    res.status(201).json({success:true,message:'تم إرسال طلبك، انتظر الموافقة'});
  }catch(e){e5(res,e,'فشل إرسال الطلب');}
});

app.get('/api/driver-requests/status/:phone',async(req,res)=>{
  try{
    const r=await pool.query('SELECT status,rejection_reason FROM driver_requests WHERE phone=$1',[req.params.phone]);
    if(!r.rowCount)return res.json({success:true,status:'not_found'});
    res.json({success:true,status:r.rows[0].status,rejection_reason:r.rows[0].rejection_reason});
  }catch(e){e5(res,e,'فشل جلب الحالة');}
});

// ══════════════════════════════════════════════════════════
// ADMIN — FULL CONTROL
// ══════════════════════════════════════════════════════════

// جلب كل طلبات التسجيل
app.get('/api/admin/driver-requests',auth,adminOnly,async(req,res)=>{
  try{
    const r=await pool.query('SELECT * FROM driver_requests ORDER BY created_at DESC');
    res.json({success:true,data:r.rows,count:r.rowCount});
  }catch(e){e5(res,e,'فشل جلب الطلبات');}
});

// قبول طلب سائق
app.post('/api/admin/driver-requests/:id/approve',auth,adminOnly,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const req_r=await c.query('SELECT * FROM driver_requests WHERE id=$1',[req.params.id]);
    if(!req_r.rowCount){await c.query('ROLLBACK');return res.status(404).json({success:false,error:'الطلب غير موجود'});}
    const drReq=req_r.rows[0];

    // إنشاء حساب السائق
    const cnt=await c.query('SELECT COUNT(*) FROM drivers');
    const wid=`TK-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
    const driver=await c.query(
      `INSERT INTO drivers(phone,name,vehicle_type,wallet_id,docs_verified,status)
       VALUES($1,$2,$3,$4,true,'offline') RETURNING *`,
      [drReq.phone,drReq.name,drReq.vehicle_type,wid]
    );
    await c.query('INSERT INTO wallets(driver_id,wallet_code,balance) VALUES($1,$2,0)',[driver.rows[0].id,wid]);
    await c.query("UPDATE driver_requests SET status='approved' WHERE id=$1",[req.params.id]);
    await c.query('COMMIT');

    // إشعار السائق
    const otp=genOTP();
    const dPhone=drReq.phone;
    otpStore.set(dPhone,{otp,expires:Date.now()+24*60*60*1000});
    try{
      await vonage.sms.send({to:dPhone.replace('+',''),from:'TukTuk',text:`مبروك! تم قبولك كسائق في تِكتِك. سجّل دخولك الآن بالرابط: https://tuktuk-backend-production-678d.up.railway.app`});
    }catch(e){}

    res.json({success:true,message:'تم قبول السائق وإرسال إشعار له',driver:driver.rows[0]});
  }catch(e){await c.query('ROLLBACK');e5(res,e,'فشل القبول');}
  finally{c.release();}
});

// رفض طلب سائق
app.post('/api/admin/driver-requests/:id/reject',auth,adminOnly,async(req,res)=>{
  try{
    const{reason}=req.body;
    const r=await pool.query("UPDATE driver_requests SET status='rejected',rejection_reason=$1 WHERE id=$2 RETURNING *",
      [reason||'لم تستوفِ الشروط',req.params.id]);
    if(!r.rowCount)return res.status(404).json({success:false,error:'الطلب غير موجود'});
    try{
      await vonage.sms.send({to:r.rows[0].phone.replace('+',''),from:'TukTuk',
        text:`عذراً، تم رفض طلبك للانضمام كسائق في تِكتِك. السبب: ${reason||'لم تستوفِ الشروط'}. يمكنك التقديم مجدداً.`});
    }catch(e){}
    res.json({success:true,message:'تم رفض الطلب'});
  }catch(e){e5(res,e,'فشل الرفض');}
});

// جلب كل السائقين
app.get('/api/admin/drivers',auth,adminOnly,async(req,res)=>{
  try{
    const r=await pool.query('SELECT d.*,w.balance as wallet_balance FROM drivers d LEFT JOIN wallets w ON w.driver_id=d.id ORDER BY d.created_at DESC');
    res.json({success:true,data:r.rows,count:r.rowCount});
  }catch(e){e5(res,e,'فشل جلب السائقين');}
});

// تفعيل/إيقاف سائق
app.post('/api/admin/drivers/:id/toggle',auth,adminOnly,async(req,res)=>{
  try{
    const d=await pool.query('SELECT is_active FROM drivers WHERE id=$1',[req.params.id]);
    if(!d.rowCount)return res.status(404).json({success:false,error:'غير موجود'});
    const newStatus=!d.rows[0].is_active;
    await pool.query('UPDATE drivers SET is_active=$1 WHERE id=$2',[newStatus,req.params.id]);
    res.json({success:true,message:newStatus?'تم تفعيل السائق':'تم إيقاف السائق',is_active:newStatus});
  }catch(e){e5(res,e,'فشل تغيير حالة السائق');}
});

// شحن/خصم رصيد سائق
app.post('/api/admin/drivers/:id/wallet',auth,adminOnly,async(req,res)=>{
  const c=await pool.connect();
  try{
    const{amount,direction,note}=req.body;
    if(!amount||!direction)return res.status(400).json({success:false,error:'أرسل المبلغ والاتجاه'});
    await c.query('BEGIN');
    const w=await c.query('SELECT balance FROM wallets WHERE driver_id=$1',[req.params.id]);
    if(!w.rowCount){await c.query('ROLLBACK');return res.status(404).json({success:false,error:'السائق غير موجود'});}
    const cur=w.rows[0].balance;
    const newBal=direction==='+'?cur+parseInt(amount):cur-parseInt(amount);
    await c.query('UPDATE wallets SET balance=$1,updated_at=NOW() WHERE driver_id=$2',[newBal,req.params.id]);
    await c.query('UPDATE drivers SET wallet_balance=$1 WHERE id=$2',[newBal,req.params.id]);
    await c.query('INSERT INTO transactions(driver_id,type,amount,direction,balance_after,note) VALUES($1,$2,$3,$4,$5,$6)',
      [req.params.id,direction==='+'?'bonus':'deduction',parseInt(amount),direction,newBal,note||'من الإدارة']);
    await c.query('COMMIT');
    pushNotif('driver',parseInt(req.params.id),
      direction==='+'?'تم إضافة رصيد':'تم خصم رصيد',
      note||`${direction==='+'?'أضافت':'خصمت'} الإدارة ${amount} دينار ${direction==='+'?'لمحفظتك':'من محفظتك'}`
    );
    res.json({success:true,message:`تم ${direction==='+'?'شحن':'خصم'} الرصيد`,new_balance:newBal});
  }catch(e){await c.query('ROLLBACK');e5(res,e,'فشل العملية');}
  finally{c.release();}
});

// جلب كل الزبائن
app.get('/api/admin/users',auth,adminOnly,async(req,res)=>{
  try{
    const r=await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json({success:true,data:r.rows,count:r.rowCount});
  }catch(e){e5(res,e,'فشل جلب الزبائن');}
});

// مكافأة زبون
app.post('/api/admin/users/:id/reward',auth,adminOnly,async(req,res)=>{
  try{
    const{type,value,message}=req.body;
    if(!type||!value)return res.status(400).json({success:false,error:'أرسل نوع المكافأة والقيمة'});
    if(type==='free_rides'){
      await pool.query('UPDATE users SET free_rides=free_rides+$1 WHERE id=$2',[parseInt(value),req.params.id]);
    } else if(type==='discount'){
      await pool.query('UPDATE users SET discount_percent=$1 WHERE id=$2',[parseInt(value),req.params.id]);
    } else if(type==='points'){
      await pool.query('UPDATE users SET reward_points=reward_points+$1 WHERE id=$2',[parseInt(value),req.params.id]);
    }
    pushNotif('user',parseInt(req.params.id),'هدية من تِكتِك',message||`حصلت على ${value} ${type==='free_rides'?'رحلة مجانية':type==='discount'?'% خصم':'نقطة رصيد'}`);
    res.json({success:true,message:'تم إرسال المكافأة والإشعار'});
  }catch(e){e5(res,e,'فشل المكافأة');}
});

// تفعيل/إيقاف زبون
app.post('/api/admin/users/:id/toggle',auth,adminOnly,async(req,res)=>{
  try{
    const u=await pool.query('SELECT is_active FROM users WHERE id=$1',[req.params.id]);
    if(!u.rowCount)return res.status(404).json({success:false,error:'غير موجود'});
    const ns=!u.rows[0].is_active;
    await pool.query('UPDATE users SET is_active=$1 WHERE id=$2',[ns,req.params.id]);
    res.json({success:true,message:ns?'تم تفعيل الزبون':'تم إيقاف الزبون',is_active:ns});
  }catch(e){e5(res,e,'فشل تغيير الحالة');}
});

// إرسال إشعار جماعي أو فردي
app.post('/api/admin/notify',auth,adminOnly,async(req,res)=>{
  try{
    const{target,target_id,title,message}=req.body;
    if(!message)return res.status(400).json({success:false,error:'أرسل نص الإشعار'});
    if(target==='all_users'){
      const users=await pool.query('SELECT id FROM users WHERE is_active=true');
      users.rows.forEach(u=>pushNotif('user',u.id,title||'إشعار من تِكتِك',message));
      await pool.query('INSERT INTO notifications(target_type,target_id,title,message) VALUES($1,NULL,$2,$3)',['all_users',title||'إشعار',message]);
    } else if(target==='all_drivers'){
      const drivers=await pool.query('SELECT id FROM drivers WHERE is_active=true');
      drivers.rows.forEach(d=>pushNotif('driver',d.id,title||'إشعار من تِكتِك',message));
      await pool.query('INSERT INTO notifications(target_type,target_id,title,message) VALUES($1,NULL,$2,$3)',['all_drivers',title||'إشعار',message]);
    } else if(target==='user'&&target_id){
      pushNotif('user',parseInt(target_id),title||'إشعار من تِكتِك',message);
    } else if(target==='driver'&&target_id){
      pushNotif('driver',parseInt(target_id),title||'إشعار من تِكتِك',message);
    }
    res.json({success:true,message:'تم إرسال الإشعار'});
  }catch(e){e5(res,e,'فشل الإشعار');}
});

// إحصائيات الإدارة
app.get('/api/admin/stats',auth,adminOnly,async(req,res)=>{
  try{
    const[dr,us,tr,ea,req_p]=await Promise.all([
      pool.query('SELECT COUNT(*) FROM drivers WHERE is_active=true'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_active=true'),
      pool.query(`SELECT COUNT(*) FROM trips WHERE status IN('searching','accepted','ongoing')`),
      pool.query(`SELECT COALESCE(SUM(commission),0) as total FROM trips WHERE status='completed'`),
      pool.query(`SELECT COUNT(*) FROM driver_requests WHERE status='pending'`),
    ]);
    const today=new Date().toISOString().slice(0,10);
    const today_trips=await pool.query(`SELECT COUNT(*) FROM trips WHERE DATE(created_at)=$1`,[today]);
    res.json({success:true,data:{
      active_drivers:parseInt(dr.rows[0].count),
      active_users:parseInt(us.rows[0].count),
      active_trips:parseInt(tr.rows[0].count),
      total_earnings:parseInt(ea.rows[0].total),
      pending_requests:parseInt(req_p.rows[0].count),
      today_trips:parseInt(today_trips.rows[0].count),
      drivers_online:driverSockets.size,
    }});
  }catch(e){e5(res,e,'فشل الإحصائيات');}
});

// جلب الرحلات
app.get('/api/admin/trips',auth,adminOnly,async(req,res)=>{
  try{
    const{status}=req.query;
    let q=`SELECT t.*,u.name as user_name,u.phone as user_phone,d.name as driver_name FROM trips t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN drivers d ON d.id=t.driver_id`;
    const params=[];
    if(status){q+=` WHERE t.status=$1`;params.push(status);}
    q+=` ORDER BY t.created_at DESC LIMIT 50`;
    const r=await pool.query(q,params);
    res.json({success:true,data:r.rows,count:r.rowCount});
  }catch(e){e5(res,e,'فشل جلب الرحلات');}
});

// ══════════════════════════════════════════════════════════
// TRIPS
// ══════════════════════════════════════════════════════════
app.post('/api/trips',auth,userOnly,async(req,res)=>{
  try{
    const{pickup_lat,pickup_lng,pickup_addr,dropoff_lat,dropoff_lng,dropoff_addr,distance_km,vehicle_type,payment_method}=req.body;
    if(!pickup_lat||!pickup_lng||!dropoff_lat||!dropoff_lng||!distance_km)
      return res.status(400).json({success:false,error:'بيانات ناقصة'});
    const fast=vehicle_type==='تكتك سريع';
    const p=calcPrice(parseFloat(distance_km),fast);
    const u=await pool.query('SELECT first_ride_used,free_rides FROM users WHERE id=$1',[req.user.id]);
    const userData=u.rows[0];
    let finalPrice=p.total_price,isFree=false;
    if(!userData.first_ride_used){isFree=true;finalPrice=0;}
    else if(userData.free_rides>0){isFree=true;finalPrice=0;}
    const t=await pool.query(
      `INSERT INTO trips(user_id,status,payment_method,pickup_lat,pickup_lng,pickup_addr,dropoff_lat,dropoff_lng,dropoff_addr,distance_km,vehicle_type,price,commission,driver_net,surge_type)
       VALUES($1,'searching',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.id,payment_method||'cash',pickup_lat,pickup_lng,pickup_addr||'',dropoff_lat,dropoff_lng,dropoff_addr||'',p.distance_km,vehicle_type||'تكتك عادي',isFree?0:p.total_price,isFree?0:p.commission,isFree?0:p.driver_net,p.surge_type]
    );
    if(isFree&&userData.free_rides>0)
      await pool.query('UPDATE users SET free_rides=free_rides-1 WHERE id=$1',[req.user.id]);
    const drivers=await pool.query(`SELECT id FROM drivers WHERE status='online' AND is_active=true AND docs_verified=true ORDER BY rating DESC LIMIT 1`);
    if(drivers.rowCount>0){
      const driverId=drivers.rows[0].id;
      io.to(`driver_${driverId}`).emit('trip:new_request',{trip_id:t.rows[0].id,pickup_addr,dropoff_addr,price:isFree?0:p.total_price,distance_km:p.distance_km,timer_seconds:60});
    }
    res.status(201).json({success:true,trip:t.rows[0],price_info:p,is_free:isFree,message:isFree?'🎉 رحلتك مجانية!':'نبحث عن سائق...'});
  }catch(e){e5(res,e,'فشل الرحلة');}
});

app.get('/api/trips/:id',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT t.*,u.name as user_name,u.phone as user_phone,d.name as driver_name,d.phone as driver_phone,d.rating as driver_rating FROM trips t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN drivers d ON d.id=t.driver_id WHERE t.id=$1`,[req.params.id]);
    if(!r.rowCount)return res.status(404).json({success:false,error:'غير موجودة'});
    res.json({success:true,data:r.rows[0]});
  }catch(e){e5(res,e,'فشل جلب الرحلة');}
});

app.post('/api/trips/:id/accept',auth,driverOnly,async(req,res)=>{
  try{
    const t=await pool.query('SELECT * FROM trips WHERE id=$1',[req.params.id]);
    if(!t.rowCount||t.rows[0].status!=='searching')return res.status(400).json({success:false,error:'الرحلة غير متاحة'});
    const w=await pool.query('SELECT balance FROM wallets WHERE driver_id=$1',[req.user.id]);
    if((w.rows[0]?.balance||0)<0)return res.status(400).json({success:false,error:'رصيدك سالب'});
    const u=await pool.query(`UPDATE trips SET status='accepted',driver_id=$1 WHERE id=$2 AND status='searching' RETURNING *`,[req.user.id,req.params.id]);
    if(!u.rowCount)return res.status(400).json({success:false,error:'قُبلت من سائق آخر'});
    io.to(`user_${t.rows[0].user_id}`).emit('trip:accepted',{trip_id:req.params.id,driver_id:req.user.id});
    res.json({success:true,message:'قبلت الرحلة',trip:u.rows[0]});
  }catch(e){e5(res,e,'فشل القبول');}
});

app.post('/api/trips/:id/start',auth,driverOnly,async(req,res)=>{
  try{
    const u=await pool.query(`UPDATE trips SET status='ongoing',started_at=NOW() WHERE id=$1 AND driver_id=$2 AND status='accepted' RETURNING *`,[req.params.id,req.user.id]);
    if(!u.rowCount)return res.status(400).json({success:false,error:'لا يمكن البدء'});
    io.to(`user_${u.rows[0].user_id}`).emit('trip:started',{trip_id:req.params.id});
    res.json({success:true,message:'بدأت الرحلة',trip:u.rows[0]});
  }catch(e){e5(res,e,'فشل البدء');}
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
      await c.query(`INSERT INTO transactions(driver_id,trip_id,type,amount,direction,balance_after,note) VALUES($1,$2,'commission',$3,'-',$4,'عمولة رحلة')`,[req.user.id,trip.id,trip.commission,newBal]);
      if(newBal<0)await c.query(`UPDATE drivers SET status='suspended' WHERE id=$1`,[req.user.id]);
    }
    await c.query('UPDATE users SET first_ride_used=true WHERE id=$1 AND first_ride_used=false',[trip.user_id]);
    await c.query('COMMIT');
    io.to(`user_${trip.user_id}`).emit('trip:completed',{trip_id:trip.id,price:trip.price});
    res.json({success:true,message:'اكتملت الرحلة',price:trip.price,commission:trip.commission,driver_net:trip.driver_net,new_balance:newBal});
  }catch(e){await c.query('ROLLBACK');e5(res,e,'فشل الإكمال');}
  finally{c.release();}
});

app.post('/api/trips/:id/cancel',auth,async(req,res)=>{
  try{
    const t=await pool.query('SELECT * FROM trips WHERE id=$1',[req.params.id]);
    if(!t.rowCount)return res.status(404).json({success:false,error:'غير موجودة'});
    if(['completed','cancelled'].includes(t.rows[0].status))return res.status(400).json({success:false,error:'لا يمكن الإلغاء'});
    await pool.query(`UPDATE trips SET status='cancelled' WHERE id=$1`,[req.params.id]);
    if(t.rows[0].driver_id)io.to(`driver_${t.rows[0].driver_id}`).emit('trip:cancelled',{trip_id:req.params.id});
    io.to(`user_${t.rows[0].user_id}`).emit('trip:cancelled',{trip_id:req.params.id});
    res.json({success:true,message:'تم الإلغاء'});
  }catch(e){e5(res,e,'فشل الإلغاء');}
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
    res.json({success:true,message:'شكراً على تقييمك',new_rating:newR.toFixed(2)});
  }catch(e){e5(res,e,'فشل التقييم');}
});

app.get('/api/my-trips',auth,async(req,res)=>{
  try{
    const{id,type}=req.user;
    const r=type==='user'
      ?await pool.query(`SELECT t.*,d.name as driver_name FROM trips t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN drivers d ON d.id=t.driver_id WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 20`,[id])
      :await pool.query(`SELECT t.*,u.name as user_name FROM trips t LEFT JOIN users u ON u.id=t.user_id WHERE t.driver_id=$1 ORDER BY t.created_at DESC LIMIT 20`,[id]);
    res.json({success:true,data:r.rows,count:r.rowCount});
  }catch(e){e5(res,e,'فشل الرحلات');}
});

// ══════════════════════════════════════════════════════════
// WALLET & DRIVER STATUS
// ══════════════════════════════════════════════════════════
app.get('/api/driver/wallet',auth,driverOnly,async(req,res)=>{
  try{
    const w=await pool.query('SELECT * FROM wallets WHERE driver_id=$1',[req.user.id]);
    const t=await pool.query('SELECT * FROM transactions WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id]);
    res.json({success:true,wallet:w.rows[0],transactions:t.rows});
  }catch(e){e5(res,e,'فشل المحفظة');}
});

app.post('/api/driver/status',auth,driverOnly,async(req,res)=>{
  try{
    const{status}=req.body;
    if(!['online','offline'].includes(status))return res.status(400).json({success:false,error:'online أو offline'});
    await pool.query('UPDATE drivers SET status=$1 WHERE id=$2',[status,req.user.id]);
    res.json({success:true,message:`أنت ${status==='online'?'متصل':'غير متصل'}`,status});
  }catch(e){e5(res,e,'فشل الحالة');}
});

// الإشعارات
app.get('/api/notifications',auth,async(req,res)=>{
  try{
    const{id,type}=req.user;
    const r=await pool.query(
      `SELECT * FROM notifications WHERE (target_type=$1 AND target_id=$2) OR target_type=$3 ORDER BY created_at DESC LIMIT 20`,
      [type,id,`all_${type}s`]
    );
    res.json({success:true,data:r.rows});
  }catch(e){e5(res,e,'فشل الإشعارات');}
});

// ══════════════════════════════════════════════════════════
// GENERAL
// ══════════════════════════════════════════════════════════
app.get('/api/zones',async(req,res)=>{try{const r=await pool.query('SELECT * FROM zones WHERE is_active=true ORDER BY name');res.json({success:true,data:r.rows});}catch(e){e5(res,e,'فشل المناطق');}});
app.get('/api/drivers/available',async(req,res)=>{try{const r=await pool.query(`SELECT id,name,vehicle_type,rating,last_lat,last_lng FROM drivers WHERE status='online' AND is_active=true ORDER BY rating DESC`);res.json({success:true,data:r.rows,count:r.rowCount,online:driverSockets.size});}catch(e){e5(res,e,'فشل السائقين');}});
app.post('/api/price/calculate',(req,res)=>{const{distance_km,vehicle_type}=req.body;if(!distance_km||distance_km<=0)return res.status(400).json({success:false,error:'distance_km مطلوب'});res.json({success:true,data:calcPrice(parseFloat(distance_km),vehicle_type==='تكتك سريع')});});

// Serve frontend
app.get('*',(req,res)=>{
  const f=path.join(__dirname,'public','index.html');
  if(fs.existsSync(f))res.sendFile(f);
  else res.status(404).json({success:false,error:'غير موجود'});
});

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════
const PORT=process.env.PORT||3000;
httpServer.listen(PORT,async()=>{
  console.log(`🛺 تكتك v5 على المنفذ ${PORT}`);
  await migrate();
});
