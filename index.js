const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const jwt      = require('jsonwebtoken');
const { Vonage } = require('@vonage/server-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── قاعدة البيانات ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// ─── إنشاء الجداول تلقائياً ──────────────────────────────
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS zones (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        city       VARCHAR(100) NOT NULL DEFAULT 'البصرة',
        is_active  BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        phone           VARCHAR(20) UNIQUE NOT NULL,
        name            VARCHAR(100),
        first_ride_used BOOLEAN DEFAULT false,
        is_active       BOOLEAN DEFAULT true,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS drivers (
        id             SERIAL PRIMARY KEY,
        phone          VARCHAR(20) UNIQUE NOT NULL,
        name           VARCHAR(100) NOT NULL,
        vehicle_type   VARCHAR(50) NOT NULL DEFAULT 'تكتك مكشوف',
        plate          VARCHAR(30),
        status         VARCHAR(20) NOT NULL DEFAULT 'offline',
        rating         NUMERIC(3,2) DEFAULT 5.00,
        wallet_balance INTEGER DEFAULT 0,
        wallet_id      VARCHAR(20) UNIQUE,
        zone_id        INTEGER REFERENCES zones(id),
        docs_verified  BOOLEAN DEFAULT false,
        is_active      BOOLEAN DEFAULT true,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wallets (
        id          SERIAL PRIMARY KEY,
        driver_id   INTEGER UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,
        wallet_code VARCHAR(20) UNIQUE NOT NULL,
        balance     INTEGER DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS trips (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id),
        driver_id       INTEGER REFERENCES drivers(id),
        status          VARCHAR(30) NOT NULL DEFAULT 'searching',
        payment_method  VARCHAR(20) DEFAULT 'cash',
        pickup_lat      NUMERIC(10,7),
        pickup_lng      NUMERIC(10,7),
        pickup_addr     TEXT,
        dropoff_lat     NUMERIC(10,7),
        dropoff_lng     NUMERIC(10,7),
        dropoff_addr    TEXT,
        distance_km     NUMERIC(6,2),
        vehicle_type    VARCHAR(50),
        price           INTEGER,
        commission      INTEGER DEFAULT 250,
        driver_net      INTEGER,
        surge_type      VARCHAR(20),
        started_at      TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id            SERIAL PRIMARY KEY,
        driver_id     INTEGER REFERENCES drivers(id),
        trip_id       INTEGER REFERENCES trips(id),
        type          VARCHAR(30) NOT NULL,
        amount        INTEGER NOT NULL,
        direction     VARCHAR(5) NOT NULL CHECK (direction IN ('+', '-')),
        balance_after INTEGER NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS gps_logs (
        id        SERIAL PRIMARY KEY,
        driver_id INTEGER REFERENCES drivers(id),
        lat       NUMERIC(10,7) NOT NULL,
        lng       NUMERIC(10,7) NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS disputes (
        id          SERIAL PRIMARY KEY,
        trip_id     INTEGER REFERENCES trips(id),
        reporter_id INTEGER,
        type        VARCHAR(50),
        status      VARCHAR(30) DEFAULT 'open',
        decision    TEXT,
        resolved_by INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS promo_codes (
        id         SERIAL PRIMARY KEY,
        code       VARCHAR(50) UNIQUE NOT NULL,
        type       VARCHAR(30),
        value      INTEGER,
        uses_count INTEGER DEFAULT 0,
        max_uses   INTEGER,
        expires_at TIMESTAMPTZ,
        is_active  BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const zonesCount = await client.query('SELECT COUNT(*) FROM zones');
    if (parseInt(zonesCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO zones (name, city) VALUES
          ('البصرة المركز', 'البصرة'),
          ('الزبير', 'البصرة'),
          ('أبو الخصيب', 'البصرة'),
          ('شط العرب', 'البصرة'),
          ('القرنة', 'البصرة');
      `);
      console.log('✅ تم إضافة المناطق');
    }
    console.log('✅ تم إنشاء الجداول بنجاح');
  } catch (err) {
    console.error('❌ خطأ في إنشاء الجداول:', err.message);
  } finally {
    client.release();
  }
}

// ─── Vonage ───────────────────────────────────────────────
const vonage = new Vonage({
  apiKey:    process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET,
});

const otpStore = new Map();

// ─── Helpers ──────────────────────────────────────────────
const handleError = (res, err, message = 'خطأ في الخادم') => {
  console.error(`❌ ${message}:`, err.message);
  res.status(500).json({ success: false, error: message });
};

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const isValidIraqiPhone = (phone) => /^\+9647[0-9]{9}$/.test(phone);

// حساب السعر — RULE_1 to RULE_1d
function calculatePrice(distanceKm, isCovered = false) {
  const rounded = Math.round(distanceKm * 2) / 2;
  let price = 500 + (rounded * 500);
  if (isCovered) price += 500;
  const hour = new Date().getHours();
  let surgeAmount = 0, surgeLabel = null;
  if (hour >= 0 && hour < 6)
    { surgeAmount = 500; surgeLabel = 'ليل'; }
  else if ((hour >= 6 && hour < 10) || (hour >= 16 && hour < 20))
    { surgeAmount = 250; surgeLabel = 'ذروة'; }
  price += surgeAmount;
  return {
    distance_km:   rounded,
    base_price:    500 + (rounded * 500),
    covered_extra: isCovered ? 500 : 0,
    surge_amount:  surgeAmount,
    surge_type:    surgeLabel,
    total_price:   price,
    commission:    250,
    driver_net:    price - 250
  };
}

// ─── JWT Middleware ───────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token)
    return res.status(401).json({ success: false, error: 'مطلوب تسجيل الدخول' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'جلسة منتهية' });
  }
};

const driverOnly = (req, res, next) => {
  if (req.user.type !== 'driver')
    return res.status(403).json({ success: false, error: 'للسائقين فقط' });
  next();
};

const userOnly = (req, res, next) => {
  if (req.user.type !== 'user')
    return res.status(403).json({ success: false, error: 'للزبائن فقط' });
  next();
};

// ══════════════════════════════════════════════════════════
// 🏠 HEALTH
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ success: true, message: 'تكتك سيرفر يعمل 🛺', version: '3.0.0' });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, db: 'connected', server: 'running' });
  } catch (err) {
    res.status(500).json({ success: false, db: 'disconnected', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// 🔐 AUTH — PART 2
// ══════════════════════════════════════════════════════════
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone)
      return res.status(400).json({ success: false, error: 'أرسل رقم الهاتف' });
    if (!isValidIraqiPhone(phone))
      return res.status(400).json({ success: false, error: 'رقم الهاتف يجب أن يبدأ بـ +9647' });

    const otp     = generateOTP();
    const expires = Date.now() + 5 * 60 * 1000;
    otpStore.set(phone, { otp, expires });

    await vonage.sms.send({
      to:   phone.replace('+', ''),
      from: 'TukTuk',
      text: `كودك في تِكتِك: ${otp}\nصالح لمدة 5 دقائق`,
    });

    console.log(`📱 OTP لـ ${phone}: ${otp}`);
    res.json({ success: true, message: 'تم إرسال كود التحقق' });
  } catch (err) {
    handleError(res, err, 'فشل إرسال OTP');
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp)
      return res.status(400).json({ success: false, error: 'أرسل رقم الهاتف والكود' });

    const stored = otpStore.get(phone);
    if (!stored)
      return res.status(400).json({ success: false, error: 'لم يتم إرسال كود لهذا الرقم' });
    if (Date.now() > stored.expires) {
      otpStore.delete(phone);
      return res.status(400).json({ success: false, error: 'انتهت صلاحية الكود' });
    }
    if (stored.otp !== otp)
      return res.status(400).json({ success: false, error: 'الكود غير صحيح' });

    otpStore.delete(phone);

    const driverResult = await pool.query('SELECT * FROM drivers WHERE phone = $1', [phone]);
    const userResult   = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);

    let userId, userType, userData;
    if (driverResult.rowCount > 0) {
      userData = driverResult.rows[0]; userId = userData.id; userType = 'driver';
    } else if (userResult.rowCount > 0) {
      userData = userResult.rows[0]; userId = userData.id; userType = 'user';
    } else {
      const newUser = await pool.query('INSERT INTO users (phone) VALUES ($1) RETURNING *', [phone]);
      userData = newUser.rows[0]; userId = userData.id; userType = 'user';
    }

    const token = jwt.sign({ id: userId, phone, type: userType }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user_type: userType, user: { id: userData.id, phone: userData.phone, name: userData.name || null } });
  } catch (err) {
    handleError(res, err, 'فشل التحقق من OTP');
  }
});

app.post('/api/auth/register-driver', async (req, res) => {
  try {
    const { phone, name, vehicle_type, plate, zone_id } = req.body;
    if (!phone || !name || !vehicle_type || !plate)
      return res.status(400).json({ success: false, error: 'أرسل: phone, name, vehicle_type, plate' });
    if (!isValidIraqiPhone(phone))
      return res.status(400).json({ success: false, error: 'رقم الهاتف يجب أن يبدأ بـ +9647' });

    const existing = await pool.query('SELECT id FROM drivers WHERE phone = $1', [phone]);
    if (existing.rowCount > 0)
      return res.status(409).json({ success: false, error: 'هذا الرقم مسجل مسبقاً' });

    const countResult = await pool.query('SELECT COUNT(*) FROM drivers');
    const walletId = `TK-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;

    const driver = await pool.query(`
      INSERT INTO drivers (phone, name, vehicle_type, plate, zone_id, wallet_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'offline')
      RETURNING id, phone, name, vehicle_type, plate, wallet_id, status
    `, [phone, name, vehicle_type, plate, zone_id || 1, walletId]);

    await pool.query('INSERT INTO wallets (driver_id, wallet_code, balance) VALUES ($1, $2, 0)', [driver.rows[0].id, walletId]);
    res.status(201).json({ success: true, message: 'تم تسجيل السائق، انتظر موافقة الإدارة', driver: driver.rows[0] });
  } catch (err) {
    handleError(res, err, 'فشل تسجيل السائق');
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { id, type } = req.user;
    let result;
    if (type === 'driver') {
      result = await pool.query('SELECT d.*, w.balance as wallet_balance FROM drivers d LEFT JOIN wallets w ON w.driver_id = d.id WHERE d.id = $1', [id]);
    } else {
      result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    }
    if (result.rowCount === 0)
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    res.json({ success: true, user_type: type, data: result.rows[0] });
  } catch (err) {
    handleError(res, err, 'فشل جلب بيانات المستخدم');
  }
});

// ══════════════════════════════════════════════════════════
// 🚗 TRIPS — PART 3: محرك الرحلات
// ══════════════════════════════════════════════════════════

// 1. إنشاء رحلة جديدة (الزبون)
app.post('/api/trips', authMiddleware, userOnly, async (req, res) => {
  try {
    const { pickup_lat, pickup_lng, pickup_addr, dropoff_lat, dropoff_lng, dropoff_addr, distance_km, vehicle_type, payment_method } = req.body;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng || !distance_km)
      return res.status(400).json({ success: false, error: 'أرسل بيانات الموقع والمسافة' });

    // RULE_10: فحص أن الموقع داخل البصرة (تقريباً)
    const basraLat = { min: 29.9, max: 31.2 };
    const basraLng = { min: 47.0, max: 48.0 };
    if (pickup_lat < basraLat.min || pickup_lat > basraLat.max ||
        pickup_lng < basraLng.min || pickup_lng > basraLng.max) {
      return res.status(400).json({ success: false, error: 'الخدمة متاحة داخل البصرة فقط' });
    }

    const isCovered = vehicle_type === 'تكتك مسقوف';
    const priceData = calculatePrice(parseFloat(distance_km), isCovered);

    // RULE_11: أول رحلة للزبون مجانية
    const user = await pool.query('SELECT first_ride_used FROM users WHERE id = $1', [req.user.id]);
    let finalPrice = priceData.total_price;
    let isFreeRide = false;
    if (!user.rows[0].first_ride_used) {
      finalPrice = 0;
      isFreeRide = true;
    }

    const trip = await pool.query(`
      INSERT INTO trips (
        user_id, status, payment_method,
        pickup_lat, pickup_lng, pickup_addr,
        dropoff_lat, dropoff_lng, dropoff_addr,
        distance_km, vehicle_type, price, commission, driver_net, surge_type
      ) VALUES ($1, 'searching', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      req.user.id, payment_method || 'cash',
      pickup_lat, pickup_lng, pickup_addr || '',
      dropoff_lat, dropoff_lng, dropoff_addr || '',
      priceData.distance_km,
      vehicle_type || 'تكتك مكشوف',
      isFreeRide ? 0 : priceData.total_price,
      isFreeRide ? 0 : priceData.commission,
      isFreeRide ? 0 : priceData.driver_net,
      priceData.surge_type
    ]);

    res.status(201).json({
      success:    true,
      trip:       trip.rows[0],
      price_info: priceData,
      is_free:    isFreeRide,
      message:    isFreeRide ? '🎉 رحلتك الأولى مجانية!' : 'تم إنشاء الرحلة، نبحث عن سائق...'
    });
  } catch (err) {
    handleError(res, err, 'فشل إنشاء الرحلة');
  }
});

// 2. جلب تفاصيل رحلة
app.get('/api/trips/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, 
        u.name as user_name, u.phone as user_phone,
        d.name as driver_name, d.phone as driver_phone, d.vehicle_type, d.plate, d.rating as driver_rating
      FROM trips t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.id = $1
    `, [req.params.id]);

    if (result.rowCount === 0)
      return res.status(404).json({ success: false, error: 'الرحلة غير موجودة' });

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    handleError(res, err, 'فشل جلب الرحلة');
  }
});

// 3. السائق يقبل الرحلة — RULE_2
app.post('/api/trips/:id/accept', authMiddleware, driverOnly, async (req, res) => {
  try {
    const trip = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (trip.rowCount === 0)
      return res.status(404).json({ success: false, error: 'الرحلة غير موجودة' });
    if (trip.rows[0].status !== 'searching')
      return res.status(400).json({ success: false, error: 'الرحلة غير متاحة للقبول' });

    // فحص رصيد السائق — RULE_5
    const wallet = await pool.query('SELECT balance FROM wallets WHERE driver_id = $1', [req.user.id]);
    const balance = wallet.rows[0]?.balance || 0;
    if (balance + 250 < 0 && trip.rows[0].price > 0) {
      return res.status(400).json({ success: false, error: 'رصيدك غير كافٍ، يرجى شحن المحفظة' });
    }

    const updated = await pool.query(`
      UPDATE trips SET status = 'accepted', driver_id = $1
      WHERE id = $2 AND status = 'searching'
      RETURNING *
    `, [req.user.id, req.params.id]);

    if (updated.rowCount === 0)
      return res.status(400).json({ success: false, error: 'تم قبول الرحلة من سائق آخر' });

    res.json({ success: true, message: 'تم قبول الرحلة', trip: updated.rows[0] });
  } catch (err) {
    handleError(res, err, 'فشل قبول الرحلة');
  }
});

// 4. بدء الرحلة
app.post('/api/trips/:id/start', authMiddleware, driverOnly, async (req, res) => {
  try {
    const updated = await pool.query(`
      UPDATE trips SET status = 'ongoing', started_at = NOW()
      WHERE id = $1 AND driver_id = $2 AND status = 'accepted'
      RETURNING *
    `, [req.params.id, req.user.id]);

    if (updated.rowCount === 0)
      return res.status(400).json({ success: false, error: 'لا يمكن بدء هذه الرحلة' });

    res.json({ success: true, message: 'بدأت الرحلة', trip: updated.rows[0] });
  } catch (err) {
    handleError(res, err, 'فشل بدء الرحلة');
  }
});

// 5. إكمال الرحلة + خصم العمولة — RULE_1, RULE_3, RULE_9
app.post('/api/trips/:id/complete', authMiddleware, driverOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tripResult = await client.query('SELECT * FROM trips WHERE id = $1 AND driver_id = $2', [req.params.id, req.user.id]);
    if (tripResult.rowCount === 0)
      return res.status(404).json({ success: false, error: 'الرحلة غير موجودة' });

    const trip = tripResult.rows[0];
    if (trip.status !== 'ongoing')
      return res.status(400).json({ success: false, error: 'الرحلة ليست جارية' });

    // إكمال الرحلة — RULE_9: تُحفظ للأبد
    await client.query(`
      UPDATE trips SET status = 'completed', completed_at = NOW()
      WHERE id = $1
    `, [trip.id]);

    // خصم العمولة من المحفظة — RULE_1
    if (trip.commission > 0) {
      const walletResult = await client.query('SELECT balance FROM wallets WHERE driver_id = $1', [req.user.id]);
      const currentBalance = walletResult.rows[0]?.balance || 0;
      const newBalance = currentBalance - trip.commission;

      await client.query('UPDATE wallets SET balance = $1, updated_at = NOW() WHERE driver_id = $2', [newBalance, req.user.id]);
      await client.query('UPDATE drivers SET wallet_balance = $1 WHERE id = $2', [newBalance, req.user.id]);

      // تسجيل المعاملة
      await client.query(`
        INSERT INTO transactions (driver_id, trip_id, type, amount, direction, balance_after)
        VALUES ($1, $2, 'commission', $3, '-', $4)
      `, [req.user.id, trip.id, trip.commission, newBalance]);

      // RULE_5: رصيد سالب → إيقاف تلقائي
      if (newBalance < 0) {
        await client.query("UPDATE drivers SET status = 'suspended' WHERE id = $1", [req.user.id]);
      }
    }

    // RULE_11: تحديث أول رحلة للزبون
    await client.query('UPDATE users SET first_ride_used = true WHERE id = $1', [trip.user_id]);

    await client.query('COMMIT');

    // جلب الرصيد الجديد
    const newWallet = await pool.query('SELECT balance FROM wallets WHERE driver_id = $1', [req.user.id]);

    res.json({
      success:     true,
      message:     'تمت الرحلة بنجاح',
