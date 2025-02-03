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
    CREATE TABLE IF NOT EXISTS products (
    GTIN VARCHAR(50) PRIMARY KEY,
    ProductName TEXT NOT NULL,
    ProductCategory TEXT NOT NULL,
    Batch VARCHAR(50) NOT NULL,
    BestBefore TIMESTAMP NOT NULL,
    expectedQuantity INT NOT NULL,
    countedQuantity INT,
    countedStatus VARCHAR(20) NOT NULL,
    unitOfMeasure VARCHAR(10) NOT NULL
);
`);

// insert data
pool.query(`
INSERT INTO products (GTIN, ProductName, ProductCategory, Batch, BestBefore, expectedQuantity, countedQuantity, countedStatus, unitOfMeasure) VALUES
    ('7090052090008', 'Glöd Sophie Elise Self Tan Express Foam', 'Glöd Sophie Elise', 'TMSKDSFJ', '2029-02-03T09:30:00Z', 150, NULL, 'open', 'FPACK'),
    ('7090052090015', 'Glöd Sophie Elise Self Tan Remover Gel', 'Glöd Sophie Elise', 'HGSKDUFM', '2029-02-03T09:30:00Z', 150, NULL, 'open', 'FPACK'),
    ('7090052090016', 'Glöd Sophie Elise Self Tan Mousse - Light', 'Glöd Sophie Elise', 'BATCH001', '2029-02-03T09:30:00Z', 120, NULL, 'open', 'FPACK'),
    ('7090052090017', 'Glöd Sophie Elise Self Tan Mousse - Medium', 'Glöd Sophie Elise', 'BATCH002', '2029-02-03T09:30:00Z', 100, NULL, 'open', 'FPACK'),
    ('7090052090018', 'Glöd Sophie Elise Self Tan Mousse - Dark', 'Glöd Sophie Elise', 'BATCH003', '2029-02-03T09:30:00Z', 200, NULL, 'open', 'FPACK');
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
