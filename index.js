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
    taskName VARCHAR(50),
    priority VARCHAR(50),
    comment VARCHAR(250),
    assignedToUserName TEXT,
    location TEXT NOT NULL,
    status VARCHAR(20) CHECK (status IN ('open', 'in_progress', 'completed', 'await_approval', 'approved', 'recheck')) NOT NULL
);
`);

pool.query(`
CREATE TABLE IF NOT EXISTS counting_task_items (
    id SERIAL PRIMARY KEY,
    countingTaskId INTEGER REFERENCES counting_tasks(countingTaskId) ON DELETE CASCADE,
    GTIN VARCHAR(50) REFERENCES products(GTIN) ON DELETE CASCADE,
    expectedQuantity INT NOT NULL,
    countedQuantity INT DEFAULT NULL,
    countedStatus VARCHAR(20) CHECK (countedStatus IN ('open', 'counted', 'await_approval', 'approved', 'recheck'))
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

// // **1. Create a counting task**
app.post("/api/tasks", async (req, res) => {
    const {location,taskName, priority,comment, productsToCount} = req.body;
    try {
        await pool.query("BEGIN");

        const taskResult = await pool.query(
            `INSERT INTO counting_tasks (location,taskName, priority,comment, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING countingTaskId`,
            [location,taskName, priority,comment]
        );

        const countingTaskId = taskResult.rows[0].countingtaskid;

        for (const product of productsToCount) {
            await pool.query(
                `INSERT INTO counting_task_items (countingTaskId, GTIN, expectedQuantity, countedStatus)
         VALUES ($1, $2, $3, 'open')`,
                [countingTaskId, product.GTIN, product.expectedQuantity]
            );
        }

        await pool.query("COMMIT");
        res.status(201).json({message: "Task created successfully", taskId: countingTaskId});
    } catch (error) {
        await pool.query("ROLLBACK");
        res.status(500).json({error: error.message});
    }
});

// **2. Retrieve all open tasks**
app.get("/api/tasks", async (req, res) => {
    try {
        // Fetch all tasks
        const tasksResult = await pool.query(
            `SELECT * FROM counting_tasks` //WHERE status = 'open'
        );

        const tasks = tasksResult.rows;

        if (tasks.length === 0) {
            return res.json([]); // Return an empty array if no tasks exist
        }

        // Get all task IDs
        const taskIds = tasks.map(task => task.countingtaskid);

        // Fetch associated products for the retrieved tasks
        const productsResult = await pool.query(
            `SELECT cti.countingTaskId, cti.GTIN, p.ProductName, cti.expectedQuantity, cti.countedQuantity, cti.countedStatus
       FROM counting_task_items cti
       JOIN products p ON cti.GTIN = p.GTIN
       WHERE cti.countingTaskId = ANY($1)`,
            [taskIds]
        );

        // Group products by their respective task
        const productsByTask = {};
        productsResult.rows.forEach(product => {
            if (!productsByTask[product.countingtaskid]) {
                productsByTask[product.countingtaskid] = [];
            }
            productsByTask[product.countingtaskid].push(product);
        });

        // Attach products to their respective tasks
        const tasksWithProducts = tasks.map(task => ({
            ...task,
            products: productsByTask[task.countingtaskid] || []
        }));

        res.json(tasksWithProducts);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// **3. Start a counting task**
app.put("/api/tasks/:taskId/start", async (req, res) => {
    try {
        const {assignedTo} = req.body;

        await pool.query(
            `UPDATE counting_tasks
       SET status = 'in_progress',
           assignedToUserId = $2,
           assignedToUserName = $3
       WHERE countingTaskId = $1`,
            [req.params.taskId, assignedTo?.userId || null, assignedTo?.userName || null]
        );

        res.json({message: "Task started"});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// **3. Unassign a counting task**
app.put("/api/tasks/:taskId/unassign", async (req, res) => {
    try {
        await pool.query(
            `UPDATE counting_tasks SET status = 'open', assignedToUserId = NULL, assignedToUserName = NULL
        WHERE countingTaskId = $1`,
            [req.params.taskId]
        );

        res.json({message: "Task Unassigned"});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// **4. Update counted product quantities**
app.put("/api/tasks/:taskId/count", async (req, res) => {
    const {productsCounted} = req.body;
    try {
        await pool.query("BEGIN");

        console.log("productsCounted " + JSON.stringify(productsCounted))

        for (const item of productsCounted) {
            await pool.query(
                `UPDATE counting_task_items SET countedQuantity = $1, countedStatus = 'counted'
         WHERE countingTaskId = $2 AND GTIN = $3`,
                [item.countedQuantity, req.params.taskId, item.GTIN]
            );
        }

        await pool.query("COMMIT");
        res.json({message: "Count updated successfully"});
    } catch (error) {
        await pool.query("ROLLBACK");
        res.status(500).json({error: error.message});
    }
});

// **5. Complete a counting task & update products**
app.delete("/api/tasks/:taskId/complete", async (req, res) => {
    try {
        await pool.query("BEGIN");

        const countedItems = await pool.query(
            `SELECT GTIN, expectedQuantity, countedQuantity FROM counting_task_items WHERE countingTaskId = $1`,
            [req.params.taskId]
        );

        console.log("countedItems " + JSON.stringify(countedItems.rows))

        let allMatch = true;

        for (const item of countedItems.rows) {
            console.log("countedItems item " + JSON.stringify(item))
            if (item.countedquantity !== item.expectedquantity) {
                allMatch = false;
                await pool.query(
                    `UPDATE counting_task_items
           SET countedStatus = 'await_approval'
           WHERE countingTaskId = $1 AND GTIN = $2`,
                    [req.params.taskId, item.gtin]
                );
            } else {
                await pool.query(
                    `DELETE FROM counting_task_items
           WHERE countingTaskId = $1 AND GTIN = $2`,
                    [req.params.taskId, item.gtin]
                );

                await pool.query(
                    `UPDATE products
           SET Quantity = $1
           WHERE GTIN = $2`,
                    [item.countedquantity, item.gtin]
                );
            }
        }

        // If at least one item didn't match, update task status to 'waiting_approval'
        if (!allMatch) {
            await pool.query(
                `UPDATE counting_tasks
         SET status = 'await_approval'
         WHERE countingTaskId = $1`,
                [req.params.taskId]
            );

            await pool.query("COMMIT");
            return res.json({
                message: "Some counted quantities didn't match. Task set to waiting_approval.",
            });
        }

        // If all matched, delete the task
        await pool.query(
            `DELETE FROM counting_tasks WHERE countingTaskId = $1`,
            [req.params.taskId]
        );

        await pool.query("COMMIT");
        res.json({message: "Task completed and removed successfully."});
    } catch (error) {
        await pool.query("ROLLBACK");
        res.status(500).json({error: error.message});
    }
});

// **6. Approve and complete a counting task & update products**
app.delete("/api/tasks/approve", async (req, res) => {
    try {
        const {taskId, gtin} = req.query;

        if (!taskId || !gtin) {
            return res.status(400).json({error: "taskId and gtin are required"});
        }

        console.log("Approve task "+taskId+" gtin "+gtin)

        await pool.query("BEGIN");

        const countedItemQuery = await pool.query(
            `SELECT GTIN, expectedQuantity, countedQuantity FROM counting_task_items WHERE countingTaskId = $1 AND GTIN = $2`,
            [taskId, gtin]
        );

        if (countedItemQuery.rowCount === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Item not found" });
        }

        const countedQuantity = countedItemQuery.rows[0].countedquantity;

        await pool.query(
            `DELETE FROM counting_task_items
           WHERE countingTaskId = $1 AND GTIN = $2`,
            [taskId, gtin]
        );

        await pool.query(
            `UPDATE products
           SET Quantity = $1
           WHERE GTIN = $2`,
            [countedQuantity, gtin]
        );

        const countedItems = await pool.query(
            `SELECT GTIN, expectedQuantity, countedQuantity FROM counting_task_items WHERE countingTaskId = $1`,
            [taskId]
        );

        // If all matched, delete the task
        if (countedItems.rowCount === 0) {
            await pool.query(
                `DELETE FROM counting_tasks WHERE countingTaskId = $1`,
                [taskId]
            );
        }

        await pool.query("COMMIT");
        res.json({message: "Task approved and completed successfully."});
    } catch (error) {
        await pool.query("ROLLBACK");
        res.status(500).json({error: error.message});
    }
});

// **1. Recheck counting task**
app.post("/api/tasks/recheck", async (req, res) => {
    const {currentTaskId, location, productsToCount} = req.body;
    try {
        await pool.query("BEGIN");

        const taskResult = await pool.query(
            `INSERT INTO counting_tasks (location, status)
       VALUES ($1, 'open') RETURNING countingTaskId`,
            [location]
        );

        const countingTaskId = taskResult.rows[0].countingtaskid;

        for (const product of productsToCount) {
            await pool.query(
                `INSERT INTO counting_task_items (countingTaskId, GTIN, expectedQuantity, countedStatus)
         VALUES ($1, $2, $3, 'open')`,
                [countingTaskId, product.GTIN, product.expectedQuantity]
            );

            await pool.query(
                `DELETE FROM counting_task_items
               WHERE countingTaskId = $1 AND GTIN = $2`,
                [currentTaskId, product.GTIN]
            );
        }

        const countedItems = await pool.query(
            `SELECT GTIN, expectedQuantity, countedQuantity FROM counting_task_items WHERE countingTaskId = $1`,
            [currentTaskId]
        );

        // If all matched, delete the task
        if (countedItems.rowCount === 0) {
            await pool.query(
                `DELETE FROM counting_tasks WHERE countingTaskId = $1`,
                [currentTaskId]
            );
        }

        await pool.query("COMMIT");
        res.status(201).json({message: "Task created successfully", taskId: countingTaskId});
    } catch (error) {
        await pool.query("ROLLBACK");
        res.status(500).json({error: error.message});
    }
});

//app.delete("/api/tasks/:taskId/complete", async (req, res) => {
//  try {
//    await pool.query("BEGIN");
//
//    const countedItems = await pool.query(
//      `SELECT GTIN, expectedQuantity ,countedQuantity FROM counting_task_items WHERE countingTaskId = $1`,
//      [req.params.taskId]
//    );
//
//    console.log("countedItems " + JSON.stringify(countedItems))
//
//    for (const item of countedItems.rows) {
//      if (item.countedquantity !== null) {
//        await pool.query(
//          `UPDATE products
//           SET Quantity = $1
//           WHERE GTIN = $2`,
//          [item.countedquantity, item.gtin]
//        );
//      }
//    }
//
//
//    await pool.query(
//      `DELETE FROM counting_task_items WHERE countingTaskId = $1`,
//      [req.params.taskId]
//    );
//
//    await pool.query(
//      `DELETE FROM counting_tasks WHERE countingTaskId = $1`,
//      [req.params.taskId]
//    );
//
//    await pool.query("COMMIT");
//    res.json({ message: "Task completed and removed" });
//  } catch (error) {
//    await pool.query("ROLLBACK");
//    res.status(500).json({ error: error.message });
//  }
//});

// **7. Delete a counting task**
app.delete("/api/tasks/:taskId/delete", async (req, res) => {
    try {
        await pool.query("BEGIN");

        await pool.query(
            `DELETE FROM counting_task_items WHERE countingTaskId = $1`,
            [req.params.taskId]
        );

        await pool.query(
            `DELETE FROM counting_tasks WHERE countingTaskId = $1`,
            [req.params.taskId]
        );

        await pool.query("COMMIT");
        res.json({message: "Task deleted!"});
    } catch (error) {
        await pool.query("ROLLBACK");
        res.status(500).json({error: error.message});
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
