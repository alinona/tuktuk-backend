// ============================================
// تِكتِك — السيرفر الرئيسي
// index.js
// ============================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── الإعدادات الأساسية ──────────────────────
app.use(cors());
app.use(express.json());

// ── الاتصال بقاعدة البيانات ─────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── اختبار الاتصال ──────────────────────────
pool.connect((err) => {
  if (err) {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
  } else {
    console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');
  }
});

// ============================================
// قواعد العمل الثابتة — لا تتغير أبداً
// ============================================
const RULES = {
  BASE_PRICE: 500,           // سعر البداية بالدينار
  PRICE_PER_KM: 500,         // سعر الكيلومتر
  COVERED_EXTRA: 500,        // إضافة المسقوف
  COMMISSION: 250,           // عمولة الشركة الثابتة
  SURGE_MORNING: 250,        // ذروة الصباح 6-10
  SURGE_EVENING: 250,        // ذروة المساء 4-8
  SURGE_NIGHT: 500,          // ليل 12م-6ص
  REQUEST_TIMEOUT: 60,       // ثواني انتظار السائق
};

// ============================================
// دالة حساب السعر — RULE_1
// ============================================
function calculatePrice(distanceKm, vehicleType, hour) {
  // تقريب المسافة لأقرب 0.5 كم
  const rounded = Math.round(distanceKm * 2) / 2;

  // السعر الأساسي
  let price = RULES.BASE_PRICE + (rounded * RULES.PRICE_PER_KM);

  // إضافة المسقوف
  if (vehicleType === 'مسقوف') {
    price += RULES.COVERED_EXTRA;
  }

  // إضافة الذروة
  if ((hour >= 6 && hour < 10) || (hour >= 16 && hour < 20)) {
    price += RULES.SURGE_MORNING;
  } else if (hour >= 0 && hour < 6) {
    price += RULES.SURGE_NIGHT;
  }

  return price;
}

// ============================================
// API Routes
// ============================================

// الصفحة الرئيسية — اختبار أن السيرفر شغّال
app.get('/', (req, res) => {
  res.json({
    status: '✅ تِكتِك شغّال',
    version: '1.0.0',
    message: 'سيرفر تطبيق تِكتِك — البصرة'
  });
});

// ── اختبار حساب السعر ───────────────────────
app.get('/test/price', (req, res) => {
  const distance = parseFloat(req.query.km) || 3.5;
  const vehicle = req.query.type || 'مكشوف';
  const hour = parseInt(req.query.hour) || new Date().getHours();

  const price = calculatePrice(distance, vehicle, hour);

  res.json({
    مسافة: `${distance} كم`,
    نوع_التكتك: vehicle,
    الساعة: hour,
    السعر: `${price} دينار`,
    العمولة: `${RULES.COMMISSION} دينار`,
    صافي_السائق: `${price - RULES.COMMISSION} دينار`
  });
});

// ── المناطق ─────────────────────────────────
app.get('/api/zones', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM zones WHERE is_active = true ORDER BY id'
    );
    res.json({ success: true, zones: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── السائقون المتاحون ────────────────────────
app.get('/api/drivers/available', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, vehicle_type, rating, wallet_code, zone_id
       FROM drivers
       WHERE status = 'online' AND is_active = true AND docs_verified = true
       ORDER BY rating DESC`
    );
    res.json({ success: true, drivers: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── إحصائيات عامة (للاختبار) ────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const drivers = await pool.query('SELECT COUNT(*) FROM drivers');
    const trips = await pool.query('SELECT COUNT(*) FROM trips');

    res.json({
      success: true,
      stats: {
        المستخدمون: parseInt(users.rows[0].count),
        السائقون: parseInt(drivers.rows[0].count),
        الرحلات: parseInt(trips.rows[0].count)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── تشغيل السيرفر ────────────────────────────
app.listen(PORT, () => {
  console.log(`🛺 تِكتِك يشتغل على البورت ${PORT}`);
});

module.exports = app;
