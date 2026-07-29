const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const Router = require('./lib/router');
const store = require('./lib/store');
const auth = require('./lib/auth');
const products = require('./data/products');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'owner@leelamart.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DELIVERY_WAIT_MS = 5 * 60 * 1000; // 5 minutes, same as the original demo
const TAX_RATE = 0.18;
const DELIVERY_FEE = 100;

const db = store.load();
const router = new Router();

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) { // 2MB safety cap
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function findUserByToken(token) {
  if (!token) return null;
  for (const email of Object.keys(db.users)) {
    const u = db.users[email];
    if (u.sessionTokens && u.sessionTokens.includes(token)) return u;
  }
  return null;
}

function getCurrentUser(req) {
  const cookies = auth.parseCookies(req);
  return findUserByToken(cookies.session);
}

function isAdmin(req) {
  const cookies = auth.parseCookies(req);
  return !!(cookies.admin_session && db.adminSessionTokens.includes(cookies.admin_session));
}

function computeItemsFromCart(cartItems) {
  // cartItems: [{productId, qty}] from the client - we NEVER trust client-sent
  // prices, always look the authoritative price up server-side.
  const items = [];
  for (const ci of cartItems) {
    const p = products.find(x => x.id === Number(ci.productId));
    if (!p) throw new Error(`Unknown product id ${ci.productId}`);
    const qty = Math.max(1, parseInt(ci.qty, 10) || 1);
    items.push({ id: p.id, name: p.name, price: p.price, qty });
  }
  if (items.length === 0) throw new Error('No items in order');
  return items;
}

function buildOrder(items, addressPicker) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  const delivery = DELIVERY_FEE;
  const grandTotal = subtotal + tax + delivery;
  return {
    orderId: 'LM' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10),
    orderDate: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    createdAt: Date.now(),
    address: addressPicker(),
    items, subtotal, tax, delivery, grandTotal,
    deliverAt: Date.now() + DELIVERY_WAIT_MS,
    status: 'Processing',
    offline: false
  };
}

const ADDRESS_POOL = [
  { city: 'Mumbai', state: 'Maharashtra', pin: '400001' },
  { city: 'New Delhi', state: 'Delhi', pin: '110001' },
  { city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
  { city: 'Chennai', state: 'Tamil Nadu', pin: '600001' },
  { city: 'Kolkata', state: 'West Bengal', pin: '700001' },
  { city: 'Hyderabad', state: 'Telangana', pin: '500001' },
  { city: 'Pune', state: 'Maharashtra', pin: '411001' },
  { city: 'Jaipur', state: 'Rajasthan', pin: '302001' },
  { city: 'Lucknow', state: 'Uttar Pradesh', pin: '226001' },
  { city: 'Kochi', state: 'Kerala', pin: '682001' }
];
const STREET_POOL = ['MG Road', 'Park Street', 'Station Road', 'Civil Lines', 'Sector 21', 'Gandhi Nagar', 'Nehru Place', 'Ring Road'];
function randomAddress() {
  const a = ADDRESS_POOL[Math.floor(Math.random() * ADDRESS_POOL.length)];
  const houseNo = Math.floor(Math.random() * 450) + 1;
  const street = STREET_POOL[Math.floor(Math.random() * STREET_POOL.length)];
  return `${houseNo}, ${street}, ${a.city}, ${a.state} - ${a.pin}`;
}

// Flip any order whose 5-minute delivery window has elapsed. Called on every
// read so status is always accurate even if nobody has been polling.
function refreshStatuses() {
  let changed = false;
  Object.values(db.users).forEach(u => {
    u.orders.forEach(o => {
      if (o.status === 'Processing' && Date.now() >= o.deliverAt) {
        o.status = 'Delivered';
        changed = true;
      }
    });
  });
  if (changed) store.save();
}

function parseAmountFromText(text) {
  const match = String(text || '').match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

// Best-effort sender-name extraction from common GPay/PhonePe/Paytm/bank SMS
// notification wordings. Falls back to null if nothing matches.
function parseNameFromText(text) {
  const t = String(text || '').trim();
  const patterns = [
    /^([A-Za-z][A-Za-z.\s]{1,40}?)\s+paid you/i,               // "John Doe paid you ₹499"
    /(?:received|credited)[^a-zA-Z]*(?:from|frm)\s+([A-Za-z][A-Za-z.\s]{1,40}?)(?:\s+(?:via|using|on|towards|for|to|UPI|Ref|A\/c)\b|[.,]|$)/i,
    /\bfrom\s+([A-Za-z][A-Za-z.\s]{1,40}?)(?:\s+(?:via|using|on|towards|for|to|UPI|Ref|A\/c)\b|[.,]|$)/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length >= 2) {
        return name.replace(/\b\w/g, c => c.toUpperCase());
      }
    }
  }
  return null;
}

// Finds (or auto-creates) a user account under the payer's name so the
// webhook-generated order shows up as a normal customer order. Synthetic
// accounts get a random password (nobody needs to log into them - they
// exist purely so the order is attributed and visible on the dashboard).
function findOrCreateAutoUser(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'customer';
  const email = `${slug}@upi.auto`;
  if (!db.users[email]) {
    const { salt, hash } = auth.hashPassword(auth.newToken());
    db.users[email] = { name, email, passwordSalt: salt, passwordHash: hash, sessionTokens: [], orders: [], auto: true };
  }
  return db.users[email];
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
router.post('/api/auth/signup', async (req, res) => {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');

  if (!email || !auth.isValidGmail(email)) return sendJson(res, 400, { error: 'Please enter a valid @gmail.com email address.' });
  if (!name) return sendJson(res, 400, { error: 'Please enter your name.' });
  if (!password) return sendJson(res, 400, { error: 'Please enter a password.' });
  if (db.users[email]) return sendJson(res, 400, { error: 'An account with this email already exists. Please login instead.' });

  const { salt, hash } = auth.hashPassword(password);
  const token = auth.newToken();
  db.users[email] = { name, email, passwordSalt: salt, passwordHash: hash, sessionTokens: [token], orders: [] };
  store.save();
  auth.setCookie(res, 'session', token, 60 * 60 * 24 * 30);
  sendJson(res, 200, { name, email });
});

router.post('/api/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !auth.isValidGmail(email)) return sendJson(res, 400, { error: 'Please enter a valid @gmail.com email address.' });
  const u = db.users[email];
  if (!u || !auth.verifyPassword(password, u.passwordSalt, u.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid email or password. New here? Sign up instead.' });
  }
  const token = auth.newToken();
  u.sessionTokens.push(token);
  store.save();
  auth.setCookie(res, 'session', token, 60 * 60 * 24 * 30);
  sendJson(res, 200, { name: u.name, email: u.email });
});

router.post('/api/auth/forgot-password', async (req, res) => {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const newPassword = String(body.newPassword || '');

  if (!email || !auth.isValidGmail(email)) return sendJson(res, 400, { error: 'Please enter a valid @gmail.com email address.' });
  const u = db.users[email];
  if (!u) return sendJson(res, 404, { error: 'No account found with this Gmail address. Please sign up instead.' });
  if (!newPassword || newPassword.length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });

  const { salt, hash } = auth.hashPassword(newPassword);
  u.passwordSalt = salt;
  u.passwordHash = hash;
  const token = auth.newToken();
  u.sessionTokens.push(token);
  store.save();
  auth.setCookie(res, 'session', token, 60 * 60 * 24 * 30);
  sendJson(res, 200, { name: u.name, email: u.email });
});

router.post('/api/auth/logout', async (req, res) => {
  const cookies = auth.parseCookies(req);
  const u = findUserByToken(cookies.session);
  if (u) {
    u.sessionTokens = u.sessionTokens.filter(t => t !== cookies.session);
    store.save();
  }
  auth.clearCookie(res, 'session');
  sendJson(res, 200, { ok: true });
});

router.get('/api/auth/me', async (req, res) => {
  const u = getCurrentUser(req);
  if (!u) return sendJson(res, 200, { user: null });
  sendJson(res, 200, { user: { name: u.name, email: u.email } });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/api/products', async (req, res) => {
  sendJson(res, 200, products);
});

// ---------------------------------------------------------------------------
// Orders (customer)
// ---------------------------------------------------------------------------
router.post('/api/orders', async (req, res) => {
  const u = getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in to place an order.' });

  const body = await readJsonBody(req);
  let items;
  try { items = computeItemsFromCart(body.items || []); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  const order = buildOrder(items, randomAddress);
  u.orders.push(order);
  store.save();
  sendJson(res, 200, order);
});

router.get('/api/orders/mine', async (req, res) => {
  const u = getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in.' });
  refreshStatuses();
  const orders = [...u.orders].sort((a, b) => b.createdAt - a.createdAt);
  sendJson(res, 200, orders);
});

router.get('/api/orders/:id', async (req, res, params) => {
  const u = getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in.' });
  refreshStatuses();
  const order = u.orders.find(o => o.orderId === params.id);
  if (!order) return sendJson(res, 404, { error: 'Order not found.' });
  sendJson(res, 200, order);
});

// ---------------------------------------------------------------------------
// Admin / Owner dashboard
// ---------------------------------------------------------------------------
router.post('/api/admin/login', async (req, res) => {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
    return sendJson(res, 401, { error: 'Invalid admin email or password.' });
  }
  const token = auth.newToken();
  db.adminSessionTokens.push(token);
  store.save();
  auth.setCookie(res, 'admin_session', token, 60 * 60 * 8);
  sendJson(res, 200, { ok: true });
});

router.post('/api/admin/logout', async (req, res) => {
  const cookies = auth.parseCookies(req);
  db.adminSessionTokens = db.adminSessionTokens.filter(t => t !== cookies.admin_session);
  store.save();
  auth.clearCookie(res, 'admin_session');
  sendJson(res, 200, { ok: true });
});

function getAllOrders() {
  refreshStatuses();
  const online = [];
  Object.values(db.users).forEach(u => {
    u.orders.forEach(o => online.push({ ...o, customerName: u.name, customerEmail: u.email }));
  });
  const all = [...online, ...db.offlineOrders];
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

router.get('/api/admin/orders', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Admin login required.' });
  const orders = getAllOrders();
  const stats = {
    totalOrders: orders.length,
    totalRevenue: orders.reduce((s, o) => s + o.grandTotal, 0),
    processingCount: orders.filter(o => o.status === 'Processing').length,
    deliveredCount: orders.filter(o => o.status === 'Delivered').length,
    totalCustomers: Object.keys(db.users).length
  };
  sendJson(res, 200, { orders, stats });
});

router.post('/api/admin/offline-orders', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Admin login required.' });
  const body = await readJsonBody(req);
  const name = String(body.customerName || '').trim() || 'Walk-in Customer';
  const amount = parseFloat(body.amount);
  const smsText = String(body.smsText || '').trim();
  const note = String(body.note || '').trim() || (smsText ? ('Bank SMS: ' + smsText.slice(0, 80)) : 'Offline Sale');

  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Please enter a valid amount.' });

  const order = {
    orderId: 'LM-OFF' + Date.now().toString().slice(-6),
    orderDate: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    createdAt: Date.now(),
    address: 'N/A — Offline / in-store payment',
    items: [{ name: note, qty: 1, price: amount }],
    subtotal: amount, tax: 0, delivery: 0, grandTotal: amount,
    status: 'Delivered', offline: true,
    customerName: name, customerEmail: '—', source: smsText ? 'sms-paste' : 'manual'
  };
  db.offlineOrders.push(order);
  store.save();
  sendJson(res, 200, order);
});

router.get('/api/admin/orders/export.csv', async (req, res) => {
  if (!isAdmin(req)) { res.writeHead(401); return res.end('Admin login required.'); }
  const orders = getAllOrders();
  const header = ['Order ID', 'Customer Name', 'Customer Email', 'Date', 'Items', 'Item Count', 'Subtotal', 'GST', 'Delivery', 'Grand Total', 'Source', 'Status', 'Delivery Address'];
  const esc = v => {
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = orders.map(o => [
    o.orderId, o.customerName, o.customerEmail, o.orderDate,
    o.items.map(i => `${i.name} x${i.qty}`).join(' | '),
    o.items.reduce((s, i) => s + i.qty, 0),
    o.subtotal, o.tax, o.delivery, o.grandTotal,
    o.offline ? 'Offline' : 'Online', o.status, o.address
  ]);
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="leela-mart-orders-${Date.now()}.csv"`
  });
  res.end(csv);
});

// Owner-facing endpoint to fetch the webhook URL + secret so it's easy to
// copy into an IFTTT applet from the dashboard itself.
router.get('/api/admin/webhook-info', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Admin login required.' });
  sendJson(res, 200, { secret: db.webhookSecret });
});

// ---------------------------------------------------------------------------
// IFTTT webhook: Android "Notifications" trigger -> "Webhooks" action posts
// here whenever a matching bank/UPI notification appears on the owner's phone.
// ---------------------------------------------------------------------------
router.post('/api/webhook/bank-notification', async (req, res) => {
  const parsed = url.parse(req.url, true);
  const secret = parsed.query.secret || req.headers['x-webhook-secret'];
  if (secret !== db.webhookSecret) return sendJson(res, 401, { error: 'Invalid or missing webhook secret.' });

  const body = await readJsonBody(req);
  const text = String(body.text || body.value1 || '').trim(); // value1 = IFTTT's default ingredient name
  const amount = parseAmountFromText(text);
  if (!amount) return sendJson(res, 400, { error: 'Could not find a rupee amount in the notification text.', text });

  const name = parseNameFromText(text) || 'UPI Customer';
  const user = findOrCreateAutoUser(name);

  const order = {
    orderId: 'LM-WH' + Date.now().toString().slice(-6),
    orderDate: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    createdAt: Date.now(),
    address: randomAddress(),
    items: [{ name: 'UPI Payment: ' + text.slice(0, 80), qty: 1, price: amount }],
    subtotal: amount, tax: 0, delivery: 0, grandTotal: amount,
    deliverAt: Date.now() + DELIVERY_WAIT_MS,
    status: 'Processing', offline: false, source: 'ifttt-webhook'
  };
  user.orders.push(order);
  store.save();
  sendJson(res, 200, { ok: true, amount, name: user.name, email: user.email, orderId: order.orderId });
});

// ---------------------------------------------------------------------------
// HTTP server / static file serving
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback: unknown non-API GET routes serve index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    const match = router.match(req.method, pathname);
    if (!match) return sendJson(res, 404, { error: 'Not found' });
    try {
      await match.handler(req, res, match.params);
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: 'Server error: ' + e.message });
    }
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  res.writeHead(404); res.end('Not found');
});

// Sweep for orders that finished "processing" even with no active requests.
setInterval(refreshStatuses, 15_000);

server.listen(PORT, () => {
  console.log(`\nLeela Mart backend running at http://localhost:${PORT}`);
  console.log(`Owner login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`IFTTT webhook secret: ${db.webhookSecret}`);
  console.log(`Webhook URL (once you expose this with ngrok): https://<your-ngrok-domain>/api/webhook/bank-notification?secret=${db.webhookSecret}\n`);
});
