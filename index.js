// ╔══════════════════════════════════════════════════════════╗
// ║        تِكتِك Backend — index.js (PART 1 Complete)       ║
// ║        نظيف + مكتمل + جاهز لـ PART 2                    ║
// ╚══════════════════════════════════════════════════════════╝

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── قاعدة البيانات ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                  // أقصى عدد اتصالات متزامنة
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// اختبار الاتصال عند التشغيل
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
  } else {
    console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');
    release();
  }
});

// ─── Helper: معالجة الأخطاء بشكل موحد ───────────────────
const handleError = (res, err, message = 'خطأ في الخادم') => {
  console.error(`❌ ${message}:`, err.message);
  res.status(500).json({ success: false, error: message });
};

// ══════════════════════════════════════════════════════════
// 🏠 HEALTH CHECK — اختبار الخادم
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'تكتك سيرفر يعمل بنجاح 🛺',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// اختبار الاتصال بقاعدة البيانات
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, db: 'connected', server: 'running' });
  } catch (err) {
    res.status(500).json({ success: false, db: 'disconnected', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// 🗺️ ZONES — المناطق
// ══════════════════════════════════════════════════════════

// جلب كل المناطق الفعّالة
app.get('/api/zones', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM zones WHERE is_active = true ORDER BY name ASC'
    );
    res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب المناطق');
  }
});

// جلب منطقة واحدة بالـ ID
app.get('/api/zones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM zones WHERE id = $1', [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ success: false, error: 'المنطقة غير موجودة' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب المنطقة');
  }
});

// ══════════════════════════════════════════════════════════
// 🚗 DRIVERS — السائقون
// ══════════════════════════════════════════════════════════

// السائقون المتاحون
app.get('/api/drivers/available', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, vehicle_type, rating, zone_id
      FROM drivers
      WHERE status = 'online' AND is_active = true
      ORDER BY rating DESC
    `);
    res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب السائقين');
  }
});

// جلب سائق واحد بالـ ID
app.get('/api/drivers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT id, name, phone, vehicle_type, plate, status,
             rating, wallet_balance, zone_id, docs_verified, created_at
      FROM drivers WHERE id = $1
    `, [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ success: false, error: 'السائق غير موجود' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب السائق');
  }
});

// ══════════════════════════════════════════════════════════
// 💰 PRICE CALCULATOR — حساب السعر (RULE_1 to RULE_1d)
// ══════════════════════════════════════════════════════════

// دالة حساب السعر حسب قواعد العمل
function calculatePrice(distanceKm, isCovered = false) {
  // RULE_1d: تقريب لأقرب 0.5 كم
  const rounded = Math.round(distanceKm * 2) / 2;

  // RULE_1b: السعر الأساسي
  let price = 500 + (rounded * 500);

  // مسقوف؟ أضف 500
  if (isCovered) price += 500;

  // RULE_1c: فحص وقت الذروة
  const now   = new Date();
  const hour  = now.getHours();
  const isMorningRush = hour >= 6  && hour < 10;
  const isEveningRush = hour >= 16 && hour < 20;
  const isNight       = hour >= 0  && hour < 6;

  let surgeAmount = 0;
  let surgeLabel  = null;

  if (isNight) {
    surgeAmount = 500;
    surgeLabel  = 'ليل';
  } else if (isMorningRush || isEveningRush) {
    surgeAmount = 250;
    surgeLabel  = 'ذروة';
  }

  price += surgeAmount;

  return {
    distance_km:   rounded,
    base_price:    500 + (rounded * 500),
    covered_extra: isCovered ? 500 : 0,
    surge_amount:  surgeAmount,
    surge_type:    surgeLabel,
    total_price:   price,
    commission:    250,                // RULE_1: ثابتة دائماً
    driver_net:    price - 250
  };
}

// Endpoint حساب السعر
app.post('/api/price/calculate', (req, res) => {
  try {
    const { distance_km, is_covered } = req.body;

    if (!distance_km || isNaN(distance_km) || distance_km <= 0)
      return res.status(400).json({ success: false, error: 'أرسل distance_km صحيحة' });

    const result = calculatePrice(parseFloat(distance_km), !!is_covered);
    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'خطأ في حساب السعر');
  }
});

// ══════════════════════════════════════════════════════════
// 📊 STATS — إحصائيات لوحة الإدارة
// ══════════════════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
  try {
    const [drivers, trips, zones, earnings] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM drivers WHERE is_active = true'),
      pool.query("SELECT COUNT(*) FROM trips WHERE status IN ('searching','accepted','ongoing')"),
      pool.query('SELECT COUNT(*) FROM zones WHERE is_active = true'),
      pool.query("SELECT COALESCE(SUM(commission),0) AS total FROM trips WHERE status = 'completed'"),
    ]);

    res.json({
      success: true,
      data: {
        active_drivers:  parseInt(drivers.rows[0].count),
        active_trips:    parseInt(trips.rows[0].count),
        active_zones:    parseInt(zones.rows[0].count),
        total_earnings:  parseInt(earnings.rows[0].total),
      }
    });
  } catch (err) {
    handleError(res, err, 'خطأ في جلب الإحصائيات');
  }
});

// ══════════════════════════════════════════════════════════
// 🚨 404 — أي مسار غير موجود
// ══════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({ success: false, error: `المسار ${req.path} غير موجود` });
});

// ══════════════════════════════════════════════════════════
// 🚀 تشغيل الخادم
// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛺 تكتك سيرفر يعمل على المنفذ ${PORT}`);
});
