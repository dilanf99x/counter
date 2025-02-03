require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for some cloud PostgreSQL services
});

// Create table if not exists
pool.query(`
    CREATE TABLE IF NOT EXISTS warehouse_counts (
        id SERIAL PRIMARY KEY,
        item VARCHAR(255) NOT NULL,
        quantity INT NOT NULL
    );
`);

// Get all warehouse counts
app.get('/api/counts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM warehouse_counts');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add a new warehouse count
app.post('/api/counts', async (req, res) => {
    const { item, quantity } = req.body;
    if (!item || quantity == null) {
        return res.status(400).json({ error: 'Item and quantity are required' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO warehouse_counts (item, quantity) VALUES ($1, $2) RETURNING *',
            [item, quantity]
        );
        res.json({ message: 'Count added', data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
