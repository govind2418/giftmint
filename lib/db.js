// MySQL-backed persistence. Replaces the old JSON-file store, which lived
// inside the git-deployed app directory and got wiped on every redeploy on
// hosts that reset untracked files. A real database lives outside that
// directory entirely, so it survives redeploys.
const mysql = require('mysql2/promise');
const crypto = require('crypto');

let pool;

async function init() {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      password_salt VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_auto TINYINT(1) NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_sessions_email (user_email),
      FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token VARCHAR(64) PRIMARY KEY,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id VARCHAR(64) PRIMARY KEY,
      user_email VARCHAR(255) NULL,
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255) NOT NULL,
      order_date VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL,
      address TEXT NOT NULL,
      items JSON NOT NULL,
      subtotal INT NOT NULL,
      tax INT NOT NULL,
      delivery INT NOT NULL,
      grand_total INT NOT NULL,
      deliver_at BIGINT NULL,
      status VARCHAR(32) NOT NULL,
      offline TINYINT(1) NOT NULL DEFAULT 0,
      source VARCHAR(64) NULL,
      razorpay_order_id VARCHAR(128) NULL,
      razorpay_payment_id VARCHAR(128) NULL,
      INDEX idx_orders_user (user_email),
      INDEX idx_orders_created (created_at),
      FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(64) PRIMARY KEY,
      \`value\` VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB
  `);
}

function rowToUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    auto: !!row.is_auto
  };
}

function rowToOrder(row) {
  if (!row) return null;
  const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
  return {
    orderId: row.order_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    orderDate: row.order_date,
    createdAt: Number(row.created_at),
    address: row.address,
    items,
    subtotal: row.subtotal,
    tax: row.tax,
    delivery: row.delivery,
    grandTotal: row.grand_total,
    deliverAt: row.deliver_at != null ? Number(row.deliver_at) : null,
    status: row.status,
    offline: !!row.offline,
    source: row.source || undefined,
    razorpayOrderId: row.razorpay_order_id || undefined,
    razorpayPaymentId: row.razorpay_payment_id || undefined
  };
}

async function getUserByEmail(email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rowToUser(rows[0]);
}

async function getUserByToken(token) {
  if (!token) return null;
  const [rows] = await pool.query(
    `SELECT u.* FROM users u JOIN sessions s ON s.user_email = u.email WHERE s.token = ?`,
    [token]
  );
  return rowToUser(rows[0]);
}

async function createUser({ email, name, passwordSalt, passwordHash, auto = false }) {
  await pool.query(
    'INSERT INTO users (email, name, password_salt, password_hash, is_auto, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [email, name, passwordSalt, passwordHash, auto ? 1 : 0, Date.now()]
  );
}

async function updateUserPassword(email, passwordSalt, passwordHash) {
  await pool.query('UPDATE users SET password_salt = ?, password_hash = ? WHERE email = ?', [passwordSalt, passwordHash, email]);
}

async function countUsers() {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM users');
  return Number(rows[0].c);
}

// Every registered user (real signups and the auto-generated accounts
// webhook payments create) with their order count and total spend, for the
// owner dashboard's Users tab.
async function getAllUsersWithStats() {
  const [rows] = await pool.query(`
    SELECT
      u.email, u.name, u.is_auto, u.created_at,
      COUNT(o.order_id) AS orderCount,
      COALESCE(SUM(o.grand_total), 0) AS totalSpent
    FROM users u
    LEFT JOIN orders o ON o.user_email = u.email
    GROUP BY u.email, u.name, u.is_auto, u.created_at
    ORDER BY u.created_at DESC
  `);
  return rows.map(r => ({
    email: r.email,
    name: r.name,
    auto: !!r.is_auto,
    createdAt: Number(r.created_at),
    orderCount: Number(r.orderCount),
    totalSpent: Number(r.totalSpent)
  }));
}

async function addSession(email, token) {
  await pool.query('INSERT INTO sessions (token, user_email, created_at) VALUES (?, ?, ?)', [token, email, Date.now()]);
}

async function removeSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
}

async function addAdminSession(token) {
  await pool.query('INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)', [token, Date.now()]);
}

async function removeAdminSession(token) {
  await pool.query('DELETE FROM admin_sessions WHERE token = ?', [token]);
}

async function isAdminSessionValid(token) {
  if (!token) return false;
  const [rows] = await pool.query('SELECT 1 FROM admin_sessions WHERE token = ?', [token]);
  return rows.length > 0;
}

async function createOrder(order) {
  await pool.query(
    `INSERT INTO orders
      (order_id, user_email, customer_name, customer_email, order_date, created_at, address, items,
       subtotal, tax, delivery, grand_total, deliver_at, status, offline, source, razorpay_order_id, razorpay_payment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.orderId, order.userEmail || null, order.customerName, order.customerEmail,
      order.orderDate, order.createdAt, order.address, JSON.stringify(order.items),
      order.subtotal, order.tax, order.delivery, order.grandTotal,
      order.deliverAt || null, order.status, order.offline ? 1 : 0, order.source || null,
      order.razorpayOrderId || null, order.razorpayPaymentId || null
    ]
  );
}

async function getOrdersForUser(email) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE user_email = ? ORDER BY created_at DESC', [email]);
  return rows.map(rowToOrder);
}

async function getOrderById(orderId) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE order_id = ?', [orderId]);
  return rowToOrder(rows[0]);
}

async function getAllOrders() {
  const [rows] = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  return rows.map(rowToOrder);
}

async function getOrderStats() {
  const [[{ totalOrders, totalRevenue, processingCount, deliveredCount }]] = await pool.query(`
    SELECT
      COUNT(*) AS totalOrders,
      COALESCE(SUM(grand_total), 0) AS totalRevenue,
      SUM(status = 'Processing') AS processingCount,
      SUM(status = 'Delivered') AS deliveredCount
    FROM orders
  `);
  return {
    totalOrders: Number(totalOrders),
    totalRevenue: Number(totalRevenue),
    processingCount: Number(processingCount),
    deliveredCount: Number(deliveredCount)
  };
}

// Flips any order whose delivery window has elapsed - one bulk UPDATE
// instead of looping through every user's orders in JS.
async function refreshStatuses() {
  await pool.query(
    `UPDATE orders SET status = 'Delivered' WHERE status = 'Processing' AND deliver_at IS NOT NULL AND deliver_at <= ?`,
    [Date.now()]
  );
}

async function getSetting(key) {
  const [rows] = await pool.query('SELECT `value` FROM settings WHERE `key` = ?', [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query('INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?', [key, value, value]);
}

async function getOrCreateRazorpaySecret() {
  let secret = await getSetting('razorpaySecret');
  if (!secret) {
    secret = crypto.randomBytes(16).toString('hex');
    await setSetting('razorpaySecret', secret);
  }
  return secret;
}

module.exports = {
  init,
  getUserByEmail, getUserByToken, createUser, updateUserPassword, countUsers, getAllUsersWithStats,
  addSession, removeSession,
  addAdminSession, removeAdminSession, isAdminSessionValid,
  createOrder, getOrdersForUser, getOrderById, getAllOrders, getOrderStats, refreshStatuses,
  getOrCreateRazorpaySecret
};
