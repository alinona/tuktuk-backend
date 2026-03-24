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

    // إضافة بيانات تجريبية إذا كانت الجداول فارغة
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
      console.log('✅ تم إضافة المناطق التجريبية');
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

// ══════════════════════════════════════════════════════════
// 🏠 HEALTH CHECK
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ success: true, message: 'تكتك سيرفر يعمل 🛺', version: '2.0.0' });
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
// 🔐 AUTH
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
// 🗺️ ZONES
// ══════════════════════════════════════════════════════════
app.get('/api/zones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM zones WHERE is_active = true ORDER BY name ASC');
    res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب المناطق');
  }
});

// ══════════════════════════════════════════════════════════
// 🚗 DRIVERS
// ══════════════════════════════════════════════════════════
app.get('/api/drivers/available', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, vehicle_type, rating, zone_id
      FROM drivers WHERE status = 'online' AND is_active = true
      ORDER BY rating DESC
    `);
    res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب السائقين');
  }
});

// ══════════════════════════════════════════════════════════
// 💰 PRICE CALCULATOR
// ══════════════════════════════════════════════════════════
function calculatePrice(distanceKm, isCovered = false) {
  const rounded = Math.round(distanceKm * 2) / 2;
  let price = 500 + (rounded * 500);
  if (isCovered) price += 500;
  const hour = new Date().getHours();
  let surgeAmount = 0, surgeLabel = null;
  if (hour >= 0 && hour < 6) { surgeAmount = 500; surgeLabel = 'ليل'; }
  else if ((hour >= 6 && hour < 10) || (hour >= 16 && hour < 20)) { surgeAmount = 250; surgeLabel = 'ذروة'; }
  price += surgeAmount;
  return { distance_km: rounded, base_price: 500 + (rounded * 500), covered_extra: isCovered ? 500 : 0, surge_amount: surgeAmount, surge_type: surgeLabel, total_price: price, commission: 250, driver_net: price - 250 };
}

app.post('/api/price/calculate', (req, res) => {
  try {
    const { distance_km, is_covered } = req.body;
    if (!distance_km || isNaN(distance_km) || distance_km <= 0)
      return res.status(400).json({ success: false, error: 'أرسل distance_km صحيحة' });
    res.json({ success: true, data: calculatePrice(parseFloat(distance_km), !!is_covered) });
  } catch (err) {
    handleError(res, err, 'خطأ في حساب السعر');
  }
});

// ══════════════════════════════════════════════════════════
// 📊 STATS
// ══════════════════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
  try {
    const [drivers, trips, zones, earnings] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM drivers WHERE is_active = true'),
      pool.query("SELECT COUNT(*) FROM trips WHERE status IN ('searching','accepted','ongoing')"),
      pool.query('SELECT COUNT(*) FROM zones WHERE is_active = true'),
      pool.query("SELECT COALESCE(SUM(commission),0) AS total FROM trips WHERE status = 'completed'"),
    ]);
    res.json({ success: true, data: { active_drivers: parseInt(drivers.rows[0].count), active_trips: parseInt(trips.rows[0].count), active_zones: parseInt(zones.rows[0].count), total_earnings: parseInt(earnings.rows[0].total) } });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب الإحصائيات');
  }
});

// ══════════════════════════════════════════════════════════
// 🚨 404
// ══════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({ success: false, error: `المسار ${req.path} غير موجود` });
});

// ══════════════════════════════════════════════════════════
// 🚀 تشغيل الخادم
// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🛺 تكتك v2 يعمل على المنفذ ${PORT}`);
  await runMigrations();
});
