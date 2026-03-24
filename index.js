const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('خطأ في اتصال قاعدة البيانات:', err.stack);
    }
    console.log('تم الاتصال بقاعدة البيانات بنجاح');
    release();
});

app.get('/', (req, res) => {
    res.json({"status":"تكتك سيرفر يعمل بنجاح 🛺"});
});

app.listen(PORT, () => {
    console.log(`سيرفر تكتك يعمل على المنفذ ${PORT}`);
});

app.get("/api/zones", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM zones WHERE is_active = TRUE");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "خطأ في جلب المناطق" });
    }
});

app.post("/api/auth/register", async (req, res) => {
    const { full_name, phone_number, email, password, role, license_number, vehicle_type, vehicle_model, vehicle_color, plate_number } = req.body;
    try {
        let newUser;
        if (role === 'user') {
            newUser = await pool.query(
                "INSERT INTO users (full_name, phone_number, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, full_name",
                [full_name, phone_number, email, password]
            );
            await pool.query("INSERT INTO wallets (user_id) VALUES ($1)", [newUser.rows[0].id]);
            res.status(201).json({ message: "تم تسجيل المستخدم بنجاح.", user: newUser.rows[0] });
        } else {
            newUser = await pool.query(
                "INSERT INTO users (full_name, phone_number, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
                [full_name, phone_number, email, password]
            );
            const newDriver = await pool.query(
                "INSERT INTO drivers (user_id, full_name, phone_number, email, password_hash, license_number, vehicle_type, vehicle_model, vehicle_color, plate_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, full_name",
                [newUser.rows[0].id, full_name, phone_number, email, password, license_number, vehicle_type, vehicle_model, vehicle_color, plate_number]
            );
            await pool.query("INSERT INTO wallets (driver_id) VALUES ($1)", [newDriver.rows[0].id]);
            res.status(201).json({ message: "تم تسجيل السائق بنجاح.", driver: newDriver.rows[0] });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/auth/login", async (req, res) => {
    const { phone_number, password, role } = req.body;
    try {
        let user;
        if (role === 'user') {
            user = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND password_hash = $2", [phone_number, password]);
        } else {
            user = await pool.query("SELECT * FROM drivers WHERE phone_number = $1 AND password_hash = $2", [phone_number, password]);
        }
        if (user.rows.length === 0) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
        res.json({ message: "تم تسجيل الدخول بنجاح", user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/trips/request", async (req, res) => {
    const { user_id, start_latitude, start_longitude, end_latitude, end_longitude, distance_km, payment_method } = req.body;
    try {
        const fare = 500 + (distance_km * 500) + 500;
        const newTrip = await pool.query(
            "INSERT INTO trips (user_id, start_latitude, start_longitude, end_latitude, end_longitude, distance_km, fare_amount, payment_method, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'searching') RETURNING *",
            [user_id, start_latitude, start_longitude, end_latitude, end_longitude, distance_km, fare, payment_method]
        );
        res.status(201).json(newTrip.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/trips/:id/complete", async (req, res) => {
    const { id } = req.params;
    try {
        const trip = await pool.query("UPDATE trips SET status = 'completed', completed_at = NOW(), payment_status = 'paid' WHERE id = $1 RETURNING *", [id]);
        res.json(trip.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
