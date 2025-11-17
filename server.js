const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve frontend files

// Database connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'todoapp',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Create tasks table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        priority ENUM('low', 'medium', 'high') DEFAULT 'medium',
        due_date DATE,
        completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create tags table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        tag_name VARCHAR(100) NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        INDEX idx_task_id (task_id)
      )
    `);

    // Create subtasks table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subtasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        text VARCHAR(255) NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        INDEX idx_task_id (task_id)
      )
    `);

    connection.release();
    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    process.exit(1);
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get all tasks with their tags and subtasks
app.get('/api/tasks', async (req, res) => {
  try {
    const [tasks] = await pool.query(`
      SELECT * FROM tasks ORDER BY created_at DESC
    `);

    // Fetch tags and subtasks for each task
    for (let task of tasks) {
      const [tags] = await pool.query(
        'SELECT tag_name FROM tags WHERE task_id = ?',
        [task.id]
      );
      task.tags = tags.map(t => t.tag_name);

      const [subtasks] = await pool.query(
        'SELECT id, text, completed FROM subtasks WHERE task_id = ? ORDER BY id',
        [task.id]
      );
      task.subtasks = subtasks;
    }

    res.json(tasks);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Get single task
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const [tasks] = await pool.query(
      'SELECT * FROM tasks WHERE id = ?',
      [req.params.id]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = tasks[0];

    const [tags] = await pool.query(
      'SELECT tag_name FROM tags WHERE task_id = ?',
      [task.id]
    );
    task.tags = tags.map(t => t.tag_name);

    const [subtasks] = await pool.query(
      'SELECT id, text, completed FROM subtasks WHERE task_id = ?',
      [task.id]
    );
    task.subtasks = subtasks;

    res.json(task);
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// Create new task
app.post('/api/tasks', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const { title, description, priority, due_date, tags, subtasks } = req.body;

    if (!title || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Insert task
    const [result] = await connection.query(
      'INSERT INTO tasks (title, description, priority, due_date) VALUES (?, ?, ?, ?)',
      [title, description || null, priority || 'medium', due_date || null]
    );

    const taskId = result.insertId;

    // Insert tags
    if (tags && Array.isArray(tags) && tags.length > 0) {
      const tagValues = tags.map(tag => [taskId, tag]);
      await connection.query(
        'INSERT INTO tags (task_id, tag_name) VALUES ?',
        [tagValues]
      );
    }

    // Insert subtasks
    if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
      const subtaskValues = subtasks.map(st => [taskId, st]);
      await connection.query(
        'INSERT INTO subtasks (task_id, text) VALUES ?',
        [subtaskValues]
      );
    }

    await connection.commit();

    // Fetch the created task with all relations
    const [tasks] = await connection.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const task = tasks[0];

    const [taskTags] = await connection.query(
      'SELECT tag_name FROM tags WHERE task_id = ?',
      [taskId]
    );
    task.tags = taskTags.map(t => t.tag_name);

    const [taskSubtasks] = await connection.query(
      'SELECT id, text, completed FROM subtasks WHERE task_id = ?',
      [taskId]
    );
    task.subtasks = taskSubtasks;

    res.status(201).json(task);
  } catch (error) {
    await connection.rollback();
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  } finally {
    connection.release();
  }
});

// Update task
app.put('/api/tasks/:id', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const { title, description, priority, due_date, completed, tags, subtasks } = req.body;
    const taskId = req.params.id;

    // Check if task exists
    const [existing] = await connection.query('SELECT id FROM tasks WHERE id = ?', [taskId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Update task
    await connection.query(
      'UPDATE tasks SET title = ?, description = ?, priority = ?, due_date = ?, completed = ? WHERE id = ?',
      [title, description || null, priority || 'medium', due_date || null, completed || false, taskId]
    );

    // Update tags - delete old and insert new
    await connection.query('DELETE FROM tags WHERE task_id = ?', [taskId]);
    if (tags && Array.isArray(tags) && tags.length > 0) {
      const tagValues = tags.map(tag => [taskId, tag]);
      await connection.query(
        'INSERT INTO tags (task_id, tag_name) VALUES ?',
        [tagValues]
      );
    }

    // Update subtasks - delete old and insert new
    await connection.query('DELETE FROM subtasks WHERE task_id = ?', [taskId]);
    if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
      const subtaskValues = subtasks.map(st => [
        taskId,
        typeof st === 'string' ? st : st.text,
        typeof st === 'object' ? (st.completed || false) : false
      ]);
      await connection.query(
        'INSERT INTO subtasks (task_id, text, completed) VALUES ?',
        [subtaskValues]
      );
    }

    await connection.commit();

    // Fetch updated task
    const [tasks] = await connection.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const task = tasks[0];

    const [taskTags] = await connection.query(
      'SELECT tag_name FROM tags WHERE task_id = ?',
      [taskId]
    );
    task.tags = taskTags.map(t => t.tag_name);

    const [taskSubtasks] = await connection.query(
      'SELECT id, text, completed FROM subtasks WHERE task_id = ?',
      [taskId]
    );
    task.subtasks = taskSubtasks;

    res.json(task);
  } catch (error) {
    await connection.rollback();
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  } finally {
    connection.release();
  }
});

// Toggle task completion
app.patch('/api/tasks/:id/toggle', async (req, res) => {
  try {
    const [tasks] = await pool.query('SELECT completed FROM tasks WHERE id = ?', [req.params.id]);
    
    if (tasks.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const newStatus = !tasks[0].completed;
    await pool.query('UPDATE tasks SET completed = ? WHERE id = ?', [newStatus, req.params.id]);

    res.json({ id: req.params.id, completed: newStatus });
  } catch (error) {
    console.error('Error toggling task:', error);
    res.status(500).json({ error: 'Failed to toggle task' });
  }
});

// Toggle subtask completion
app.patch('/api/subtasks/:id/toggle', async (req, res) => {
  try {
    const [subtasks] = await pool.query('SELECT completed FROM subtasks WHERE id = ?', [req.params.id]);
    
    if (subtasks.length === 0) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    const newStatus = !subtasks[0].completed;
    await pool.query('UPDATE subtasks SET completed = ? WHERE id = ?', [newStatus, req.params.id]);

    res.json({ id: req.params.id, completed: newStatus });
  } catch (error) {
    console.error('Error toggling subtask:', error);
    res.status(500).json({ error: 'Failed to toggle subtask' });
  }
});

// Delete task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM tasks WHERE id = ?', [req.params.id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ message: 'Task deleted successfully', id: req.params.id });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const [totalResult] = await pool.query('SELECT COUNT(*) as total FROM tasks');
    const [completedResult] = await pool.query('SELECT COUNT(*) as completed FROM tasks WHERE completed = TRUE');
    const [activeResult] = await pool.query('SELECT COUNT(*) as active FROM tasks WHERE completed = FALSE');
    const [overdueResult] = await pool.query('SELECT COUNT(*) as overdue FROM tasks WHERE completed = FALSE AND due_date < CURDATE()');

    res.json({
      total: totalResult[0].total,
      completed: completedResult[0].completed,
      active: activeResult[0].active,
      overdue: overdueResult[0].overdue
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Initialize database and start server
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await pool.end();
  process.exit(0);
});