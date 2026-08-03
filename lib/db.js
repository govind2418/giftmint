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
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS failed_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      razorpay_payment_id VARCHAR(128) NULL,
      amount INT NULL,
      name VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      reason TEXT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_failed_payments_created (created_at)
    ) ENGINE=InnoDB
  `);

  // Gift-code inventory. `real` rows are codes an admin actually holds and
  // typed in by hand - the only ones ever handed to an authenticated,
  // logged-in buyer. `synthetic` rows are invented by the server itself to
  // match a bank payment that arrived with no matching cart (webhook / manual
  // offline entry) - never drawn from the real pool.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gift_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      platform VARCHAR(32) NOT NULL,
      denomination INT NOT NULL,
      code VARCHAR(64) NOT NULL,
      type ENUM('real', 'synthetic') NOT NULL,
      status ENUM('available', 'redeemed') NOT NULL DEFAULT 'available',
      order_id VARCHAR(64) NULL,
      created_at BIGINT NOT NULL,
      redeemed_at BIGINT NULL,
      UNIQUE KEY uniq_gift_code (code),
      INDEX idx_gift_codes_lookup (platform, denomination, type, status),
      INDEX idx_gift_codes_order (order_id)
    ) ENGINE=InnoDB
  `);

  // A direct-UPI checkout (customer pays our own VPA instead of going
  // through Razorpay) has no automatic payment-success webhook to confirm
  // it - so it sits here as 'pending' until an admin manually confirms the
  // money actually arrived, then it's turned into a real order (same real
  // stock claim as the Razorpay flow). Persisted (not in-memory) so it
  // survives restarts and admin can review it whenever they check.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_upi_orders (
      id VARCHAR(64) PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      items JSON NOT NULL,
      subtotal INT NOT NULL,
      platform_fee INT NOT NULL,
      grand_total INT NOT NULL,
      status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      resolved_at BIGINT NULL,
      order_id VARCHAR(64) NULL,
      admin_note VARCHAR(255) NULL,
      INDEX idx_pending_upi_status (status),
      INDEX idx_pending_upi_user (user_email)
    ) ENGINE=InnoDB
  `);

  // Migration: admin_sessions originally had no last_seen column (needed
  // for the idle-timeout check below).
  await ensureColumn('admin_sessions', 'last_seen', 'BIGINT NOT NULL DEFAULT 0');

  // Migration: the users table originally had no address column. Added so a
  // user's delivery address is assigned once and reused for every order
  // afterward, instead of a new random one every time.
  await ensureColumn('users', 'address', 'TEXT NULL');

  // Migration: profile photo, stored as a small resized base64 data URI
  // (the frontend downsizes it before upload, so this stays well under a
  // few hundred KB even though the column allows more).
  await ensureColumn('users', 'photo', 'MEDIUMTEXT NULL');

  // Migration: the payer's contact number, when Razorpay's webhook payload
  // includes one (common for UPI/QR payments with no name/email at all).
  // Stored raw; only ever shown masked on the admin invoice.
  await ensureColumn('orders', 'contact', 'VARCHAR(20) NULL');

  // Migration: partner-triggered bonus orders (e.g. Leela Mart rewarding its
  // own customers with a GiftMint code). partner_order_ref is the partner's
  // own order id - unique so a retried/duplicate API call can't mint a
  // second bonus code for the same partner order (MySQL's UNIQUE index
  // allows any number of NULL rows, so normal non-partner orders are fine).
  await ensureColumn('orders', 'partner_name', 'VARCHAR(64) NULL');
  await ensureColumn('orders', 'partner_order_ref', 'VARCHAR(128) NULL');
  await ensureUniqueIndex('orders', 'uniq_partner_order_ref', ['partner_order_ref']);

  // One-time (per user) backfill: anyone who already had orders before this
  // column existed gets their most recent order's address as their address
  // on file, so their very next order is already consistent instead of
  // getting one more fresh random one first.
  await pool.query(`
    UPDATE users u
    SET u.address = (
      SELECT o.address FROM orders o WHERE o.user_email = u.email ORDER BY o.created_at DESC LIMIT 1
    )
    WHERE u.address IS NULL
      AND EXISTS (SELECT 1 FROM orders o WHERE o.user_email = u.email)
  `);

  // One-time migration: orders created before the IST timezone fix have a
  // stale order_date string baked in (computed from the server's own local
  // time, e.g. UTC, mislabeled as IST) even though their created_at epoch
  // was always correct. Recompute every order_date from created_at so the
  // displayed date always matches what the date-range filters use.
  if (!(await getSetting('orderDatesRecomputedForIST'))) {
    const [rows] = await pool.query('SELECT order_id, created_at FROM orders');
    for (const r of rows) {
      const correctDate = new Date(Number(r.created_at)).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
      });
      await pool.query('UPDATE orders SET order_date = ? WHERE order_id = ?', [correctDate, r.order_id]);
    }
    await setSetting('orderDatesRecomputedForIST', '1');
  }
}

async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column]
  );
  if (rows[0].c === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureUniqueIndex(table, indexName, columns) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, indexName]
  );
  if (rows[0].c === 0) {
    await pool.query(`ALTER TABLE ${table} ADD UNIQUE KEY ${indexName} (${columns.join(', ')})`);
  }
}

function rowToUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    auto: !!row.is_auto,
    address: row.address || null,
    photo: row.photo || null
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
    razorpayPaymentId: row.razorpay_payment_id || undefined,
    contact: row.contact || null,
    partnerName: row.partner_name || null,
    partnerOrderRef: row.partner_order_ref || null
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

async function updateUserAddress(email, address) {
  await pool.query('UPDATE users SET address = ? WHERE email = ?', [address, email]);
}

// Partial update - only the fields actually present in `fields` get
// touched, so the profile form can save name/address/photo independently.
async function updateUserProfile(email, fields) {
  const columns = { name: 'name', address: 'address', photo: 'photo' };
  const sets = [];
  const params = [];
  for (const key of Object.keys(fields)) {
    if (!columns[key]) continue;
    sets.push(`${columns[key]} = ?`);
    params.push(fields[key]);
  }
  if (sets.length === 0) return;
  params.push(email);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE email = ?`, params);
}

async function countUsers() {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM users');
  return Number(rows[0].c);
}

// True totals regardless of pagination/search on the Users tab.
async function getUserTypeCounts() {
  const [[{ total, registered, auto }]] = await pool.query(`
    SELECT COUNT(*) AS total, SUM(is_auto = 0) AS registered, SUM(is_auto = 1) AS auto FROM users
  `);
  return { total: Number(total), registered: Number(registered), auto: Number(auto) };
}

// Every registered user (real signups and the auto-generated accounts
// webhook payments create) with their order count and total spend, for the
// owner dashboard's Users tab.
const ADMIN_USER_SORT_COLUMNS = {
  name: 'u.name', type: 'u.is_auto', orders: 'orderCount', spent: 'totalSpent', joined: 'u.created_at'
};

// opts: { search, sortKey, sortDir, limit, offset }. Returns { users, total }.
async function getAllUsersWithStats(opts = {}) {
  const { search, sortKey, sortDir, limit, offset } = opts;
  const where = search ? 'WHERE u.name LIKE ? OR u.email LIKE ?' : '';
  const whereParams = search ? [`%${search}%`, `%${search}%`] : [];

  const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM users u ${where}`, whereParams);
  const total = Number(countRows[0].c);

  const column = ADMIN_USER_SORT_COLUMNS[sortKey] || 'u.created_at';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  let query = `
    SELECT
      u.email, u.name, u.is_auto, u.created_at,
      COUNT(o.order_id) AS orderCount,
      COALESCE(SUM(o.grand_total), 0) AS totalSpent
    FROM users u
    LEFT JOIN orders o ON o.user_email = u.email
    ${where}
    GROUP BY u.email, u.name, u.is_auto, u.created_at
    ORDER BY ${column} ${dir}
  `;
  const queryParams = [...whereParams];
  if (limit != null) {
    query += ' LIMIT ? OFFSET ?';
    queryParams.push(limit, offset || 0);
  }
  const [rows] = await pool.query(query, queryParams);
  const users = rows.map(r => ({
    email: r.email,
    name: r.name,
    auto: !!r.is_auto,
    createdAt: Number(r.created_at),
    orderCount: Number(r.orderCount),
    totalSpent: Number(r.totalSpent)
  }));
  return { users, total };
}

async function addSession(email, token) {
  await pool.query('INSERT INTO sessions (token, user_email, created_at) VALUES (?, ?, ?)', [token, email, Date.now()]);
}

async function removeSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
}

// Owner sessions expire after this long with no admin API activity - a
// sliding window, not a fixed login-to-logout duration. Refreshing the
// dashboard, switching tabs, etc. all count as activity and push it back.
const ADMIN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

async function addAdminSession(token) {
  const now = Date.now();
  // Sweep out anything already idle-expired while we're at it.
  await pool.query('DELETE FROM admin_sessions WHERE last_seen < ?', [now - ADMIN_IDLE_TIMEOUT_MS]);
  await pool.query('INSERT INTO admin_sessions (token, created_at, last_seen) VALUES (?, ?, ?)', [token, now, now]);
}

async function removeAdminSession(token) {
  await pool.query('DELETE FROM admin_sessions WHERE token = ?', [token]);
}

async function isAdminSessionValid(token) {
  if (!token) return false;
  const now = Date.now();
  const [rows] = await pool.query('SELECT 1 FROM admin_sessions WHERE token = ? AND last_seen >= ?', [token, now - ADMIN_IDLE_TIMEOUT_MS]);
  if (rows.length === 0) return false;
  await pool.query('UPDATE admin_sessions SET last_seen = ? WHERE token = ?', [now, token]);
  return true;
}

async function createOrder(order, conn = pool) {
  await conn.query(
    `INSERT INTO orders
      (order_id, user_email, customer_name, customer_email, order_date, created_at, address, items,
       subtotal, tax, delivery, grand_total, deliver_at, status, offline, source, razorpay_order_id, razorpay_payment_id, contact,
       partner_name, partner_order_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.orderId, order.userEmail || null, order.customerName, order.customerEmail,
      order.orderDate, order.createdAt, order.address, JSON.stringify(order.items),
      order.subtotal, order.tax, order.delivery, order.grandTotal,
      order.deliverAt || null, order.status, order.offline ? 1 : 0, order.source || null,
      order.razorpayOrderId || null, order.razorpayPaymentId || null, order.contact || null,
      order.partnerName || null, order.partnerOrderRef || null
    ]
  );
}

// Looks up an existing order by a partner's own order reference - lets the
// bonus-code API be safely retried (a duplicate call returns the same
// already-issued code instead of minting a second one).
async function getOrderByPartnerRef(partnerOrderRef) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE partner_order_ref = ?', [partnerOrderRef]);
  return rowToOrder(rows[0]);
}

async function getOrdersForUser(email) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE user_email = ? ORDER BY created_at DESC', [email]);
  return rows.map(rowToOrder);
}

async function getOrderById(orderId) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE order_id = ?', [orderId]);
  return rowToOrder(rows[0]);
}

// `range` is an optional { from, to } of epoch-ms timestamps (inclusive) to
// filter orders by created_at - used for the owner dashboard's date filter.
const ORDER_SORT_COLUMNS = {
  orderId: 'order_id', customer: 'customer_name', date: 'created_at', amount: 'grand_total', status: 'status'
};

// range: optional {from, to} epoch-ms. opts: { search, sortKey, sortDir, limit, offset }.
// Returns { orders, total } - total is the full matching count (ignoring
// limit/offset), so the frontend can render page numbers. Passing no
// limit returns every matching row (used by CSV export, which shouldn't
// be paginated).
async function getAllOrders(range, opts = {}) {
  const { search, sortKey, sortDir, limit, offset } = opts;
  const conditions = [];
  const params = [];
  if (range) { conditions.push('created_at BETWEEN ? AND ?'); params.push(range.from, range.to); }
  if (search) {
    conditions.push('(order_id LIKE ? OR customer_name LIKE ? OR customer_email LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM orders ${where}`, params);
  const total = Number(countRows[0].c);

  const column = ORDER_SORT_COLUMNS[sortKey] || 'created_at';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  let query = `SELECT * FROM orders ${where} ORDER BY ${column} ${dir}`;
  const queryParams = [...params];
  if (limit != null) {
    query += ' LIMIT ? OFFSET ?';
    queryParams.push(limit, offset || 0);
  }
  const [rows] = await pool.query(query, queryParams);
  return { orders: rows.map(rowToOrder), total };
}

async function getOrderStats(range) {
  const where = range ? 'WHERE created_at BETWEEN ? AND ?' : '';
  const params = range ? [range.from, range.to] : [];
  const [[{ totalOrders, totalRevenue, processingCount, deliveredCount, distinctCustomers }]] = await pool.query(`
    SELECT
      COUNT(*) AS totalOrders,
      COALESCE(SUM(grand_total), 0) AS totalRevenue,
      SUM(status = 'Processing') AS processingCount,
      SUM(status = 'Delivered') AS deliveredCount,
      COUNT(DISTINCT customer_email) AS distinctCustomers
    FROM orders ${where}
  `, params);
  return {
    totalOrders: Number(totalOrders),
    totalRevenue: Number(totalRevenue),
    processingCount: Number(processingCount),
    deliveredCount: Number(deliveredCount),
    distinctCustomers: Number(distinctCustomers)
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

// Records a payment.failed webhook so the owner can see it instead of it
// being silently acknowledged and forgotten.
async function recordFailedPayment({ razorpayPaymentId, amount, name, email, reason }) {
  await pool.query(
    'INSERT INTO failed_payments (razorpay_payment_id, amount, name, email, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [razorpayPaymentId || null, amount != null ? Math.round(amount) : null, name || null, email || null, reason || null, Date.now()]
  );
}

async function getFailedPayments() {
  const [rows] = await pool.query('SELECT * FROM failed_payments ORDER BY created_at DESC LIMIT 200');
  return rows.map(r => ({
    id: r.id,
    razorpayPaymentId: r.razorpay_payment_id,
    amount: r.amount,
    name: r.name,
    email: r.email,
    reason: r.reason,
    createdAt: Number(r.created_at)
  }));
}

// Runs `fn(conn)` inside a transaction, committing on success and rolling
// back on any thrown error. `conn` exposes the same `.query()` shape as the
// pool, so callers can reuse ordinary query code inside it.
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Real stock available right now for every platform+denomination combo that
// has at least one available real code - used to build the storefront
// catalog and to validate a cart before creating a Razorpay order.
async function getRealStock() {
  const [rows] = await pool.query(
    `SELECT platform, denomination, COUNT(*) AS available
     FROM gift_codes WHERE type = 'real' AND status = 'available'
     GROUP BY platform, denomination`
  );
  return rows.map(r => ({ platform: r.platform, denomination: Number(r.denomination), available: Number(r.available) }));
}

// Admin-only: every gift code (real and synthetic, any status), most recent
// first, optionally filtered.
async function listGiftCodes(opts = {}) {
  const { platform, type, status, search, limit, offset } = opts;
  const conditions = [];
  const params = [];
  if (platform) { conditions.push('platform = ?'); params.push(platform); }
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (search) { conditions.push('(code LIKE ? OR order_id LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM gift_codes ${where}`, params);
  const total = Number(countRows[0].c);

  let query = `SELECT * FROM gift_codes ${where} ORDER BY created_at DESC`;
  const queryParams = [...params];
  if (limit != null) { query += ' LIMIT ? OFFSET ?'; queryParams.push(limit, offset || 0); }
  const [rows] = await pool.query(query, queryParams);
  const codes = rows.map(r => ({
    id: r.id, platform: r.platform, denomination: Number(r.denomination), code: r.code,
    type: r.type, status: r.status, orderId: r.order_id, createdAt: Number(r.created_at),
    redeemedAt: r.redeemed_at != null ? Number(r.redeemed_at) : null
  }));
  return { codes, total };
}

// Admin adds a real code they physically hold. Throws with code ER_DUP_ENTRY
// if that exact code string already exists.
async function addRealGiftCode({ platform, denomination, code }) {
  await pool.query(
    `INSERT INTO gift_codes (platform, denomination, code, type, status, created_at) VALUES (?, ?, ?, 'real', 'available', ?)`,
    [platform, denomination, code, Date.now()]
  );
}

// Admin removes a real code that was entered by mistake - only allowed while
// it's still unsold, so a code already on a customer's invoice can't vanish.
async function deleteAvailableGiftCode(id) {
  const [result] = await pool.query(`DELETE FROM gift_codes WHERE id = ? AND status = 'available'`, [id]);
  return result.affectedRows > 0;
}

// Claims up to `qty` available real codes for one cart line inside an
// existing transaction. Row-locks the candidates (SKIP LOCKED so a
// concurrent buyer's claim on other rows isn't blocked) and immediately
// marks them redeemed against `orderId`. Returns the claimed code strings -
// fewer than `qty` means stock ran out between checkout and payment.
async function claimRealCodes(conn, { platform, denomination, qty, orderId }) {
  const [rows] = await conn.query(
    `SELECT id, code FROM gift_codes
     WHERE platform = ? AND denomination = ? AND type = 'real' AND status = 'available'
     ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
    [platform, denomination, qty]
  );
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  await conn.query(
    `UPDATE gift_codes SET status = 'redeemed', order_id = ?, redeemed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [orderId, Date.now(), ...ids]
  );
  return rows.map(r => r.code);
}

// Inserts one synthetic (server-invented) code, already redeemed against
// `orderId`, inside an existing transaction. Throws ER_DUP_ENTRY on the rare
// collision so the caller can regenerate and retry.
async function insertSyntheticCode(conn, { platform, denomination, code, orderId }) {
  const now = Date.now();
  await conn.query(
    `INSERT INTO gift_codes (platform, denomination, code, type, status, order_id, created_at, redeemed_at)
     VALUES (?, ?, ?, 'synthetic', 'redeemed', ?, ?, ?)`,
    [platform, denomination, code, orderId, now, now]
  );
}

function rowToPendingUpiOrder(row) {
  if (!row) return null;
  const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
  return {
    id: row.id, userEmail: row.user_email, items,
    subtotal: row.subtotal, platformFee: row.platform_fee, grandTotal: row.grand_total,
    status: row.status, createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at != null ? Number(row.resolved_at) : null,
    orderId: row.order_id || null, adminNote: row.admin_note || null
  };
}

async function createPendingUpiOrder(p) {
  await pool.query(
    `INSERT INTO pending_upi_orders (id, user_email, items, subtotal, platform_fee, grand_total, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [p.id, p.userEmail, JSON.stringify(p.items), p.subtotal, p.platformFee, p.grandTotal, Date.now()]
  );
}

async function getPendingUpiOrder(id) {
  const [rows] = await pool.query('SELECT * FROM pending_upi_orders WHERE id = ?', [id]);
  return rowToPendingUpiOrder(rows[0]);
}

async function listPendingUpiOrders(status) {
  const [rows] = status
    ? await pool.query('SELECT * FROM pending_upi_orders WHERE status = ? ORDER BY created_at DESC', [status])
    : await pool.query('SELECT * FROM pending_upi_orders ORDER BY created_at DESC LIMIT 200');
  return rows.map(rowToPendingUpiOrder);
}

// Resolves a pending UPI order to 'approved' or 'rejected' - only from
// 'pending', so a double-click (or the admin acting twice) can't process the
// same payment into two orders. `conn` defaults to the plain pool (for a
// standalone reject) but can be a transaction connection (for approve,
// where it must commit atomically with the order/code creation).
async function resolvePendingUpiOrder(id, status, orderId, adminNote, conn = pool) {
  const [result] = await conn.query(
    `UPDATE pending_upi_orders SET status = ?, order_id = ?, admin_note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    [status, orderId || null, adminNote || null, Date.now(), id]
  );
  return result.affectedRows > 0;
}

module.exports = {
  init,
  getUserByEmail, getUserByToken, createUser, updateUserPassword, updateUserAddress, updateUserProfile, countUsers, getUserTypeCounts, getAllUsersWithStats,
  addSession, removeSession,
  addAdminSession, removeAdminSession, isAdminSessionValid,
  createOrder, getOrdersForUser, getOrderById, getOrderByPartnerRef, getAllOrders, getOrderStats, refreshStatuses,
  getOrCreateRazorpaySecret, recordFailedPayment, getFailedPayments,
  withTransaction, getRealStock, listGiftCodes, addRealGiftCode, deleteAvailableGiftCode, claimRealCodes, insertSyntheticCode,
  createPendingUpiOrder, getPendingUpiOrder, listPendingUpiOrders, resolvePendingUpiOrder
};
