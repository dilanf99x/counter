require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {Pool} = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {rejectUnauthorized: false}, // Required for some cloud PostgreSQL services
});

// Create table if not exists
pool.query(`
CREATE TABLE IF NOT EXISTS products (
    GTIN VARCHAR(50) PRIMARY KEY,
    ProductName TEXT NOT NULL,
    ProductCategory TEXT NOT NULL,
    Batch VARCHAR(50),
    BestBefore TIMESTAMP,
    Quantity INT NOT NULL,
    UnitOfMeasure TEXT
);
`);

pool.query(`
CREATE TABLE IF NOT EXISTS counting_tasks (
    countingTaskId SERIAL PRIMARY KEY,
    creationDate TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assignedToUserId VARCHAR(50),
    assignedToUserName TEXT,
    location TEXT NOT NULL,
    status VARCHAR(20) CHECK (status IN ('open', 'in_progress', 'completed')) NOT NULL
);
`);

pool.query(`
CREATE TABLE IF NOT EXISTS counting_task_items (
    id SERIAL PRIMARY KEY,
    countingTaskId INTEGER REFERENCES counting_tasks(countingTaskId) ON DELETE CASCADE,
    GTIN VARCHAR(50) REFERENCES products(GTIN) ON DELETE CASCADE,
    expectedQuantity INT NOT NULL,
    countedQuantity INT DEFAULT NULL,
    countedStatus VARCHAR(20) CHECK (countedStatus IN ('open', 'counted'))
);
`);

//// insert data
//pool.query(`
//INSERT INTO products (GTIN, ProductName, ProductCategory, Batch, BestBefore, Quantity, unitOfMeasure) VALUES
//    ('7090052090008', 'Glöd Sophie Elise Self Tan Express Foam', 'Glöd Sophie Elise', 'TMSKDSFJ', '2029-02-03T09:30:00Z', 150, 'FPACK'),
//    ('7090052090015', 'Glöd Sophie Elise Self Tan Remover Gel', 'Glöd Sophie Elise', 'HGSKDUFM', '2029-02-03T09:30:00Z', 150, 'FPACK'),
//    ('7090052090016', 'Glöd Sophie Elise Self Tan Mousse - Light', 'Glöd Sophie Elise', 'BATCH001', '2029-02-03T09:30:00Z', 120, 'FPACK'),
//    ('7090052090017', 'Glöd Sophie Elise Self Tan Mousse - Medium', 'Glöd Sophie Elise', 'BATCH002', '2029-02-03T09:30:00Z', 100, 'FPACK'),
//    ('7090052090018', 'Glöd Sophie Elise Self Tan Mousse - Dark', 'Glöd Sophie Elise', 'BATCH003', '2029-02-03T09:30:00Z', 200, 'FPACK');
//`);

// Get all warehouse products
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// **1. Create a counting task**
app.post("/api/tasks", async (req, res) => {
  const { assignedTo, location, productsToCount } = req.body;
  try {
    await pool.query("BEGIN");

    const taskResult = await pool.query(
      `INSERT INTO counting_tasks (assignedToUserId, assignedToUserName, location, status)
       VALUES ($1, $2, $3, 'open') RETURNING countingTaskId`,
      [assignedTo.userId, assignedTo.userName, location]
    );

    const taskId = taskResult.rows[0].countingTaskId;

    for (const product of productsToCount) {
      await pool.query(
        `INSERT INTO counting_task_items (taskId, GTIN, expectedQuantity, countedStatus)
         VALUES ($1, $2, $3, 'open')`,
        [taskId, product.GTIN, product.expectedQuantity]
      );
    }

    await pool.query("COMMIT");
    res.status(201).json({ message: "Task created successfully", taskId: countingTaskId  });
  } catch (error) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: error.message });
  }
});

// **2. Retrieve all open tasks**
app.get("/api/tasks", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM counting_tasks WHERE status = 'open'`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// **3. Start a counting task**
app.put("/api/tasks/:taskId/start", async (req, res) => {
  try {
    await pool.query(
      `UPDATE counting_tasks SET status = 'in_progress' WHERE countingTaskId = $1`,
      [req.params.taskId]
    );
    res.json({ message: "Task started" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// **4. Update counted product quantities**
app.put("/api/tasks/:taskId/count", async (req, res) => {
  const { productsCounted } = req.body;
  try {
    await pool.query("BEGIN");

    for (const item of productsCounted) {
      await pool.query(
        `UPDATE counting_task_items SET countedQuantity = $1, countedStatus = 'counted'
         WHERE countingTaskId = $2 AND GTIN = $3`,
        [item.countedQuantity, req.params.taskId, item.GTIN]
      );
    }

    await pool.query("COMMIT");
    res.json({ message: "Count updated successfully" });
  } catch (error) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: error.message });
  }
});

// **5. Complete a counting task & update products**
app.delete("/api/tasks/:taskId/complete", async (req, res) => {
  try {
    await pool.query("BEGIN");

    const countedItems = await pool.query(
      `SELECT GTIN, countedQuantity FROM counting_task_items WHERE countingTaskId = $1`,
      [req.params.taskId]
    );

    for (const item of countedItems.rows) {
      await pool.query(
        `UPDATE products SET Quantity = $1 WHERE GTIN = $2`,
        [item.countedQuantity, item.GTIN]
      );
    }

    await pool.query(
      `DELETE FROM counting_tasks WHERE countingTaskId = $1`,
      [req.params.taskId]
    );

    await pool.query("COMMIT");
    res.json({ message: "Task completed and removed" });
  } catch (error) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
