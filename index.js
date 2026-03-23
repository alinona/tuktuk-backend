const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// إعدادات السماح بالاتصال من التطبيقات (CORS)
app.use(cors());
app.use(express.json());

// الربط مع قاعدة بيانات Supabase باستخدام الرابط الموجود في Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. اختبار السيرفر (للتأكد أنه يعمل)
app.get('/', (req, res) => {
  res.json({ status: 'تكتك سيرفر يعمل بنجاح 🛺' });
});

// 2. جلب قائمة المناطق (Zones)
app.get('/api/zones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM zones WHERE is_active = true ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب المناطق' });
  }
});

// 3. جلب السائقين المتاحين حالياً (Available Drivers)
app.get('/api/drivers/available', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, vehicle_type, rating FROM drivers WHERE status = 'online' AND is_active = true");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب السائقين' });
  }
});

// 4. جلب إحصائيات بسيطة للوحة الإدارة (Stats)
app.get('/api/stats', async (req, res) => {
  try {
    const driversCount = await pool.query('SELECT COUNT(*) FROM drivers');
    const activeTrips = await pool.query("SELECT COUNT(*) FROM trips WHERE status = 'searching' OR status = 'accepted'");
    const totalZones = await pool.query('SELECT COUNT(*) FROM zones');
    
    res.json({
      total_drivers: parseInt(driversCount.rows[0].count),
      active_trips: parseInt(activeTrips.rows[0].count),
      total_zones: parseInt(totalZones.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// تشغيل السيرفر على المنفذ المخصص من Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
