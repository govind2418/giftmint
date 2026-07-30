const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

require('./lib/env').loadEnv(path.join(__dirname, '.env'));

const Router = require('./lib/router');
const db = require('./lib/db');
const auth = require('./lib/auth');
const giftcodes = require('./lib/giftcodes');
const { PLATFORMS, DENOMINATIONS, getPlatform, isValidDenomination } = require('./data/platforms');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'owner@giftmint.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
// Only applies to the authenticated storefront checkout (real inventory) -
// webhook/offline synthetic orders price at exactly the amount received,
// with no "before checkout" step to add a fee on top of.
const PLATFORM_FEE_RATE = 0.05;

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

// Like readJsonBody, but hands back the raw string too - needed for Razorpay
// signature verification, which is computed over the exact bytes received.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyRazorpaySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getCurrentUser(req) {
  const cookies = auth.parseCookies(req);
  return db.getUserByToken(cookies.session);
}

async function isAdmin(req) {
  const cookies = auth.parseCookies(req);
  return db.isAdminSessionValid(cookies.admin_session);
}

// cartItems: [{platform, denomination, qty}] from the client - price is
// always the face value of the denomination itself (never client-supplied),
// and both platform and denomination are validated against our fixed catalog.
function computeCartLines(cartItems) {
  const lines = [];
  for (const ci of cartItems || []) {
    const platform = getPlatform(String(ci.platform || ''));
    if (!platform) throw new Error(`Unknown platform ${ci.platform}`);
    if (!isValidDenomination(ci.denomination)) throw new Error(`Invalid denomination ${ci.denomination}`);
    const qty = Math.max(1, parseInt(ci.qty, 10) || 1);
    lines.push({ platform: platform.id, platformName: platform.name, denomination: Number(ci.denomination), qty });
  }
  if (lines.length === 0) throw new Error('No items in order');
  return lines;
}

// Timestamp + 4 random bytes of entropy - safe against collisions even
// when many orders (e.g. a burst of webhook payments) are created in the
// same millisecond, unlike a plain Date.now() slice.
function newOrderId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// Always formats in IST regardless of the server's own OS timezone (e.g.
// most hosts run in UTC) - without an explicit timeZone, toLocaleString
// uses the server's local time, which is wrong for Indian customers.
function formatOrderDate() {
  return new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function toTitleCase(s) {
  return String(s).trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// A payer's VPA/email local-part is often nothing but digits (a bare phone
// number, e.g. "9876543210@okaxis") or a name with a stray numeric suffix
// (e.g. "raj.kumar24@okaxis") - neither looks right as someone's "name" on
// an invoice. Picked deterministically from the raw identifier (not
// Math.random) so the same payer always gets the same stand-in name across
// repeat payments, same as pickAutoUserDomain below.
const INDIAN_NAME_POOL = [
  'Aarav Sharma', 'Priya Patel', 'Rohan Gupta', 'Ananya Singh', 'Vikram Rao',
  'Sneha Iyer', 'Karan Mehta', 'Divya Nair', 'Arjun Reddy', 'Neha Joshi',
  'Aditya Kumar', 'Pooja Verma', 'Rahul Desai', 'Kavita Menon', 'Suresh Pillai'
];
function pickIndianName(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return INDIAN_NAME_POOL[hash % INDIAN_NAME_POOL.length];
}

// Turns a raw slug guess (VPA/email local-part) into a presentable display
// name: strips digits entirely (never shows "Raj24" or a bare "9876543210"
// as a name), and falls back to a stand-in Indian name if nothing
// alphabetic survives the strip.
function cleanGuessedName(rawIdentifier) {
  const cleaned = rawIdentifier
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? toTitleCase(cleaned) : pickIndianName(rawIdentifier);
}

// Masks a phone number for display, e.g. "9876543210" -> "9876xxxx10" -
// keeps enough at each end to be recognizable without exposing the full
// number on a printable invoice.
function maskPhone(digits) {
  if (!digits || digits.length <= 6) return digits || '';
  return digits.slice(0, 4) + 'x'.repeat(digits.length - 6) + digits.slice(-2);
}

// Pulls the payer name + paid amount (in rupees) out of a Razorpay
// `payment.captured` webhook payload. Also accepts a flat {name, amount}
// body so the flow can be smoke-tested with curl before Razorpay is wired up.
function extractRazorpayPaymentDetails(body) {
  const entity = body && body.payload && body.payload.payment && body.payload.payment.entity;
  if (entity) {
    const amount = typeof entity.amount === 'number' ? entity.amount / 100 : null;
    const notes = entity.notes;
    const notesName = notes && !Array.isArray(notes) && (notes.name || notes.customer_name);
    const emailLocal = entity.email ? entity.email.split('@')[0] : null;
    // Real Razorpay QR/UPI payments carry no name, email, or contact at
    // all - the only thing that's ever actually populated is the payer's
    // VPA (UPI ID, e.g. "raj.kumar-14@okaxis"). Not a real name, but it's
    // the only field that differs per payer, so it's what attributes each
    // scan to a distinct "customer" instead of lumping everyone into one
    // generic account.
    const vpa = entity.vpa || (entity.upi && entity.upi.vpa);
    const vpaLocal = vpa ? vpa.split('@')[0] : null;
    // `slug` is the raw, uncleaned identifier used to key the auto-created
    // account (so repeat payments from the same VPA always land on the same
    // account) - kept separate from `name`, the cosmetic cleaned-up version
    // shown on invoices/dashboards.
    const slug = notesName || emailLocal || vpaLocal || null;
    const name = notesName ? toTitleCase(notesName) : (slug ? cleanGuessedName(slug) : null);
    const contact = entity.contact ? String(entity.contact).replace(/\D/g, '') : null;
    return { amount, name, slug, contact, event: body.event || null };
  }
  if (body && body.amount != null) {
    const name = body.name ? toTitleCase(body.name) : null;
    return { amount: Number(body.amount), name, slug: name, contact: null, event: 'manual' };
  }
  return { amount: null, name: null, slug: null, contact: null, event: null };
}

// Invents a gift code for a platform+denomination and inserts it (already
// redeemed) inside the given transaction, retrying on the astronomically
// rare code collision. Never touches the real inventory - these codes exist
// purely to back an order that has no real code behind it.
async function generateSyntheticCode(conn, platform, denomination, orderId) {
  const platformInfo = getPlatform(platform);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = giftcodes.formatCode(platformInfo.prefix);
    try {
      await db.insertSyntheticCode(conn, { platform, denomination, code, orderId });
      return code;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY' || attempt === 4) throw e;
    }
  }
}

// Turns a captured payment amount that has no matching real cart (a webhook
// payment or a manually-entered offline payment) into a full order: picks a
// random platform, prices the "gift card" at exactly the amount received
// (the real money is the only source of truth), and mints a one-off
// synthetic code for it - never one of the real codes reserved for
// authenticated, logged-in buyers.
async function synthesizeGiftCodeOrder({ amount, name, userEmail, customerEmail, source, offline, contact }) {
  const denomination = Math.max(1, Math.round(amount));
  const platform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
  const orderId = newOrderId(offline ? 'GM-OFF' : 'GM-RP');

  return db.withTransaction(async conn => {
    const code = await generateSyntheticCode(conn, platform.id, denomination, orderId);
    const order = {
      orderId, orderDate: formatOrderDate(), createdAt: Date.now(),
      address: 'Digital delivery', items: [{ platform: platform.id, platformName: platform.name, denomination, code }],
      subtotal: denomination, tax: 0, delivery: 0, grandTotal: denomination,
      status: 'Delivered', offline: !!offline, source,
      userEmail: userEmail || null, customerName: name, customerEmail: customerEmail || '—',
      contact: contact || null
    };
    await db.createOrder(order, conn);
    return order;
  });
}

// Finds (or auto-creates) a user account under the payer's name so the
// webhook-generated order shows up as a normal customer order. Synthetic
// accounts get a random password (nobody needs to log into them - they
// exist purely so the order is attributed and visible on the dashboard).
// Picks an email domain for an auto-created account that looks like a real
// address instead of an obviously-synthetic one - but deterministically
// from the slug, so the same payer always lands on the same domain (and
// therefore the same account) across repeat payments, not a new random one
// each time. Numeric slugs (a bare phone number, e.g. a VPA with no name
// in it) get gmail.com specifically - a real person owning the exact same
// digits as their own Gmail username is rare enough to accept; everyone
// else is spread across a few other common providers for variety.
const AUTO_USER_DOMAINS = ['icloud.com', 'outlook.com', 'yahoo.com', 'giftmint.com'];
function pickAutoUserDomain(slug) {
  if (/^\d+$/.test(slug)) return 'gmail.com';
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return AUTO_USER_DOMAINS[hash % AUTO_USER_DOMAINS.length];
}

// `identitySlug` is the raw, uncleaned VPA/email/name text - it decides
// which account a payment lands on, so it must stay identical across repeat
// payments from the same payer. `displayName` is only the cosmetic name
// stored on that account (may be a stand-in name if identitySlug was just
// digits) - never used for the email/dedup key itself.
async function findOrCreateAutoUser(identitySlug, displayName) {
  const slug = identitySlug.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'customer';
  const email = `${slug}@${pickAutoUserDomain(slug)}`;
  let user = await db.getUserByEmail(email);
  if (!user) {
    const { salt, hash } = auth.hashPassword(auth.newToken());
    try {
      await db.createUser({ email, name: displayName, passwordSalt: salt, passwordHash: hash, auto: true });
      user = { email, name: displayName, passwordSalt: salt, passwordHash: hash, auto: true };
    } catch (e) {
      // Two payments for the same person landed at the same instant and
      // both tried to create this account - the other one won, so just use
      // what it created instead of failing this request.
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      user = await db.getUserByEmail(email);
    }
  }
  return user;
}

// Calls the Razorpay REST API using key/secret Basic Auth. No SDK - just the
// built-in https module.
function razorpayApiRequest(method, pathname, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const authHeader = 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const req = https.request({
      hostname: 'api.razorpay.com',
      path: pathname,
      method,
      headers: Object.assign(
        { Authorization: authHeader },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Razorpay order_id -> priced cart, kept in memory only until the payment is
// verified (or abandoned). Server-computed pricing is what actually gets
// charged and later turned into the real order - the client never gets to
// dictate the amount.
const pendingPayments = new Map();
const PENDING_PAYMENT_TTL_MS = 30 * 60 * 1000;
function prunePendingPayments() {
  const cutoff = Date.now() - PENDING_PAYMENT_TTL_MS;
  for (const [id, p] of pendingPayments) {
    if (p.createdAt < cutoff) pendingPayments.delete(id);
  }
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
  if (await db.getUserByEmail(email)) return sendJson(res, 400, { error: 'An account with this email already exists. Please login instead.' });

  const { salt, hash } = auth.hashPassword(password);
  const token = auth.newToken();
  await db.createUser({ email, name, passwordSalt: salt, passwordHash: hash });
  await db.addSession(email, token);
  auth.setCookie(res, 'session', token, 60 * 60 * 24 * 30);
  sendJson(res, 200, { name, email });
});

router.post('/api/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !auth.isValidGmail(email)) return sendJson(res, 400, { error: 'Please enter a valid @gmail.com email address.' });
  const u = await db.getUserByEmail(email);
  if (!u || !auth.verifyPassword(password, u.passwordSalt, u.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid email or password. New here? Sign up instead.' });
  }
  const token = auth.newToken();
  await db.addSession(email, token);
  auth.setCookie(res, 'session', token, 60 * 60 * 24 * 30);
  sendJson(res, 200, { name: u.name, email: u.email });
});

router.post('/api/auth/forgot-password', async (req, res) => {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const newPassword = String(body.newPassword || '');

  if (!email || !auth.isValidGmail(email)) return sendJson(res, 400, { error: 'Please enter a valid @gmail.com email address.' });
  const u = await db.getUserByEmail(email);
  if (!u) return sendJson(res, 404, { error: 'No account found with this Gmail address. Please sign up instead.' });
  if (!newPassword || newPassword.length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });

  const { salt, hash } = auth.hashPassword(newPassword);
  await db.updateUserPassword(email, salt, hash);
  const token = auth.newToken();
  await db.addSession(email, token);
  auth.setCookie(res, 'session', token, 60 * 60 * 24 * 30);
  sendJson(res, 200, { name: u.name, email: u.email });
});

router.post('/api/auth/logout', async (req, res) => {
  const cookies = auth.parseCookies(req);
  if (cookies.session) await db.removeSession(cookies.session);
  auth.clearCookie(res, 'session');
  sendJson(res, 200, { ok: true });
});

router.get('/api/auth/me', async (req, res) => {
  const u = await getCurrentUser(req);
  if (!u) return sendJson(res, 200, { user: null });
  sendJson(res, 200, { user: { name: u.name, email: u.email, address: u.address || '', photo: u.photo || null } });
});

router.post('/api/auth/profile', async (req, res) => {
  const u = await getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in.' });

  const body = await readJsonBody(req);
  const fields = {};

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Name cannot be empty.' });
    if (name.length > 100) return sendJson(res, 400, { error: 'Name is too long.' });
    fields.name = name;
  }
  if (body.address !== undefined) {
    const address = String(body.address || '').trim();
    if (!address) return sendJson(res, 400, { error: 'Address cannot be empty.' });
    if (address.length > 500) return sendJson(res, 400, { error: 'Address is too long.' });
    fields.address = address;
  }
  if (body.photo !== undefined) {
    const photo = String(body.photo || '').trim();
    if (photo && !photo.startsWith('data:image/')) return sendJson(res, 400, { error: 'Invalid photo data.' });
    if (photo.length > 500_000) return sendJson(res, 400, { error: 'Photo is too large.' });
    fields.photo = photo || null;
  }

  if (Object.keys(fields).length === 0) return sendJson(res, 400, { error: 'Nothing to update.' });

  await db.updateUserProfile(u.email, fields);
  sendJson(res, 200, {
    name: fields.name || u.name,
    email: u.email,
    address: fields.address !== undefined ? fields.address : (u.address || ''),
    photo: fields.photo !== undefined ? fields.photo : (u.photo || null)
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
// Catalog = every platform x denomination combo, annotated with how many
// real codes we actually hold right now. `inStock: 0` combos are still
// listed (so the storefront can show them, disabled) but can never be
// bought - there is deliberately no "sell a code we don't have" path here.
router.get('/api/catalog', async (req, res) => {
  const stock = await db.getRealStock();
  const stockMap = new Map(stock.map(s => [`${s.platform}:${s.denomination}`, s.available]));
  const catalog = PLATFORMS.map(p => ({
    id: p.id, name: p.name,
    denominations: DENOMINATIONS.map(d => ({ value: d, inStock: stockMap.get(`${p.id}:${d}`) || 0 }))
  }));
  sendJson(res, 200, catalog);
});

// ---------------------------------------------------------------------------
// Orders (customer) - actual order creation only happens after a verified
// Razorpay payment (see /api/payments/verify below), and only ever draws
// from real inventory we actually hold. There is deliberately no "create
// order for free" endpoint here.
// ---------------------------------------------------------------------------
// Razorpay Standard Checkout: create-order -> checkout.js modal -> verify
// ---------------------------------------------------------------------------
router.post('/api/payments/create-order', async (req, res) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return sendJson(res, 500, { error: 'Razorpay is not configured on this server (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET).' });
  }
  const u = await getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in to pay.' });

  const body = await readJsonBody(req);
  let lines;
  try { lines = computeCartLines(body.items || []); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  // Real stock is only ever handed to an authenticated, logged-in buyer -
  // if we don't actually hold enough of a combo, the purchase is blocked
  // here rather than ever substituting a synthetic code for a paying,
  // logged-in customer.
  const stock = await db.getRealStock();
  const stockMap = new Map(stock.map(s => [`${s.platform}:${s.denomination}`, s.available]));
  for (const line of lines) {
    const available = stockMap.get(`${line.platform}:${line.denomination}`) || 0;
    if (available < line.qty) {
      return sendJson(res, 400, { error: `Sorry, only ${available} in stock for ${line.platformName} ₹${line.denomination}.` });
    }
  }

  const subtotal = lines.reduce((s, l) => s + l.denomination * l.qty, 0);
  const platformFee = Math.round(subtotal * PLATFORM_FEE_RATE);
  const grandTotal = subtotal + platformFee;
  const amountPaise = Math.round(grandTotal * 100);
  if (amountPaise < 100) return sendJson(res, 400, { error: 'Order amount must be at least Rs. 1.' });

  prunePendingPayments();
  let rzpRes;
  try {
    rzpRes = await razorpayApiRequest('POST', '/v1/orders', {
      amount: amountPaise, currency: 'INR', receipt: 'GM-' + Date.now().toString(36)
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'Could not reach Razorpay: ' + e.message });
  }
  if (rzpRes.status === 401) {
    return sendJson(res, 401, { error: 'Razorpay authentication failed - check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.' });
  }
  if (rzpRes.status >= 400) {
    const msg = (rzpRes.body && rzpRes.body.error && rzpRes.body.error.description) || 'Razorpay order creation failed.';
    return sendJson(res, 500, { error: msg });
  }

  pendingPayments.set(rzpRes.body.id, { userEmail: u.email, lines, subtotal, platformFee, grandTotal, createdAt: Date.now() });

  sendJson(res, 200, {
    key_id: RAZORPAY_KEY_ID,
    order_id: rzpRes.body.id,
    amount: rzpRes.body.amount,
    currency: rzpRes.body.currency,
    name: u.name,
    email: u.email
  });
});

router.post('/api/payments/verify', async (req, res) => {
  const u = await getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in.' });

  const body = await readJsonBody(req);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return sendJson(res, 400, { error: 'Missing payment verification fields.' });
  }

  const pending = pendingPayments.get(razorpay_order_id);
  if (!pending || pending.userEmail !== u.email) {
    return sendJson(res, 400, { error: 'No matching pending payment found for this order.' });
  }

  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(razorpay_signature), 'hex');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return sendJson(res, 400, { error: 'Payment signature verification failed.' });

  pendingPayments.delete(razorpay_order_id);

  const orderId = newOrderId('GM');
  const order = await db.withTransaction(async conn => {
    const items = [];
    for (const line of pending.lines) {
      const codes = await db.claimRealCodes(conn, { platform: line.platform, denomination: line.denomination, qty: line.qty, orderId });
      // Stock ran out between checkout and payment (rare - covered by the
      // create-order check above plus row-locking here). The payment is
      // already captured, so the customer still gets a code for it, minted
      // on the spot instead of the real one that's no longer available.
      const shortfall = line.qty - codes.length;
      for (let i = 0; i < shortfall; i++) codes.push(await generateSyntheticCode(conn, line.platform, line.denomination, orderId));
      for (const code of codes) items.push({ platform: line.platform, platformName: line.platformName, denomination: line.denomination, code });
    }
    const orderObj = {
      orderId, orderDate: formatOrderDate(), createdAt: Date.now(),
      address: 'Digital delivery',
      items, subtotal: pending.subtotal, tax: pending.platformFee, delivery: 0, grandTotal: pending.grandTotal,
      status: 'Delivered', offline: false,
      source: 'razorpay-checkout', razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id,
      userEmail: u.email, customerName: u.name, customerEmail: u.email
    };
    await db.createOrder(orderObj, conn);
    return orderObj;
  });
  sendJson(res, 200, order);
});

router.get('/api/orders/mine', async (req, res) => {
  const u = await getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in.' });
  await db.refreshStatuses();
  const orders = await db.getOrdersForUser(u.email);
  sendJson(res, 200, orders);
});

router.get('/api/orders/:id', async (req, res, params) => {
  const u = await getCurrentUser(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in.' });
  await db.refreshStatuses();
  const order = await db.getOrderById(params.id);
  if (!order || order.customerEmail !== u.email) return sendJson(res, 404, { error: 'Order not found.' });
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
  await db.addAdminSession(token);
  auth.setCookie(res, 'admin_session', token, 60 * 60 * 8);
  sendJson(res, 200, { ok: true });
});

router.post('/api/admin/logout', async (req, res) => {
  const cookies = auth.parseCookies(req);
  if (cookies.admin_session) await db.removeAdminSession(cookies.admin_session);
  auth.clearCookie(res, 'admin_session');
  sendJson(res, 200, { ok: true });
});

// Cheap check the frontend calls on page load to tell whether the owner is
// still validly logged in (and, since isAdmin() renews the idle timer,
// this call itself counts as activity).
router.get('/api/admin/me', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Not logged in.' });
  sendJson(res, 200, { ok: true });
});

// Customer-facing label for the internal `source` tag, so the invoice
// reads like a normal receipt instead of showing an implementation detail
// like "razorpay-webhook".
const ORDER_SOURCE_LABELS = {
  'razorpay-checkout': 'Razorpay Checkout',
  'razorpay-webhook': 'UPI Payment',
  'sms-paste': 'Bank SMS (Manual Entry)',
  'manual': 'Manual Entry'
};

// Renders a standalone, print-ready Tax Invoice page for one order. Works
// for every order (self-placed, offline, or Razorpay) since it's looked up
// from the admin's own view rather than a customer session - the
// auto/synthetic accounts webhooks create have no real login, so this is
// the only way to ever see their invoice.
function renderInvoiceHtml(o) {
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = o.items.map(i => `<tr><td>${esc(i.platformName)} Gift Card</td><td>Rs. ${i.denomination.toLocaleString('en-IN')}</td><td class="code">${esc(i.code)}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invoice ${esc(o.orderId)} - GiftMint</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --primary:#4F46E5; --primary-dark:#3730A3; --primary-light:#EEF2FF;
    --mint:#10B981; --mint-dark:#059669; --mint-light:#ECFDF5;
    --text:#0F172A; --muted:#64748B; --border:#E5E7EB; --bg:#F5F6FB;
  }
  *{box-sizing:border-box;}
  body{font-family:'Inter',Arial,Helvetica,sans-serif;color:var(--text);background:var(--bg);margin:0;padding:32px 16px;}
  .sheet{max-width:700px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.08);overflow:hidden;border:1px solid var(--border);}
  .print-bar{max-width:700px;margin:0 auto 16px;text-align:right;}
  .print-bar button{padding:10px 20px;border:none;border-radius:8px;background:var(--mint);color:#fff;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(16,185,129,.3);}
  .head{background:linear-gradient(100deg,var(--primary),var(--primary-dark) 75%);color:#fff;padding:28px 32px;}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
  .brand-word{font-family:'Poppins',sans-serif;font-size:21px;font-weight:800;letter-spacing:-.3px;}
  .brand-word .mint{color:#6EE7B7;}
  .sub{color:#C7D2FE;font-size:12.5px;margin-top:2px;}
  .status{display:inline-block;padding:5px 12px;border-radius:20px;font-size:11.5px;font-weight:700;margin-top:14px;}
  .status.delivered{background:rgba(110,231,183,.2);color:#6EE7B7;}
  .status.processing{background:rgba(255,255,255,.18);color:#fff;}
  .body-pad{padding:28px 32px;}
  .row{display:flex;justify-content:space-between;gap:20px;margin-bottom:22px;flex-wrap:wrap;}
  .box h4{font-size:10.5px;text-transform:uppercase;color:var(--muted);margin:0 0 5px;letter-spacing:.6px;font-weight:700;}
  .box p{margin:0;font-size:13.5px;line-height:1.6;color:var(--text);}
  table{width:100%;border-collapse:collapse;margin:4px 0 20px;font-size:13.5px;}
  th{text-align:left;border-bottom:2px solid var(--border);padding:9px 8px;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;}
  td{padding:12px 8px;border-bottom:1px solid #F1F2F6;}
  td.code{font-family:'Courier New',monospace;font-weight:700;letter-spacing:.5px;background:var(--primary-light);border-radius:4px;color:var(--primary-dark);}
  .totals{margin-left:auto;width:260px;}
  .totals div{display:flex;justify-content:space-between;padding:5px 0;font-size:13.5px;color:var(--muted);}
  .totals .grand{font-size:18px;font-weight:800;border-top:2px solid var(--border);margin-top:8px;padding-top:10px;color:var(--primary-dark);}
  .disclaimer{margin-top:24px;padding:14px 32px;font-size:11px;color:#9CA3AF;border-top:1px solid var(--border);background:#FAFAFB;line-height:1.7;}
  @media print{
    body{background:#fff;padding:0;}
    .print-bar{display:none;}
    .sheet{box-shadow:none;border:none;border-radius:0;}
  }
</style></head>
<body>
  <div class="print-bar"><button onclick="window.print()">Download / Print as PDF</button></div>
  <div class="sheet">
    <div class="head">
      <div class="brand">
        <svg width="34" height="34" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="gmInv" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#818CF8"/><stop offset="100%" stop-color="#34D399"/>
          </linearGradient></defs>
          <rect width="40" height="40" rx="11" fill="url(#gmInv)"/>
          <rect x="9" y="15" width="22" height="5" rx="2" fill="#fff"/>
          <rect x="11" y="19" width="18" height="12" rx="2" fill="#fff"/>
          <rect x="18.5" y="10" width="3" height="21" fill="url(#gmInv)"/>
          <circle cx="30" cy="9" r="2.6" fill="#fff"/>
        </svg>
        <span class="brand-word">Gift<span class="mint">Mint</span></span>
      </div>
      <div class="sub">Gift Card Invoice &middot; Order ID: ${esc(o.orderId)} &middot; ${esc(o.orderDate)}</div>
      <span class="status ${o.status === 'Delivered' ? 'delivered' : 'processing'}">${esc(o.status)}</span>
    </div>
    <div class="body-pad">
      <div class="row">
        <div class="box"><h4>Billed To</h4><p>${esc(o.customerName)}<br>${esc(o.customerEmail)}</p></div>
        <div class="box"><h4>Delivery</h4><p>Digital &mdash; code(s) below</p></div>
        <div class="box"><h4>Source</h4><p>${esc(o.offline ? 'Offline' : 'Online')}${o.source ? ' &middot; ' + esc(ORDER_SOURCE_LABELS[o.source] || o.source) : ''}</p></div>
        ${o.contact ? `<div class="box"><h4>Contact</h4><p>${esc(maskPhone(o.contact))}</p></div>` : ''}
      </div>
      <table><thead><tr><th>Gift Card</th><th>Value</th><th>Code</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="totals">
        ${o.tax > 0 ? `<div><span>Subtotal</span><span>Rs. ${o.subtotal.toLocaleString('en-IN')}</span></div>
        <div><span>Platform Fee (5%)</span><span>Rs. ${o.tax.toLocaleString('en-IN')}</span></div>` : ''}
        <div class="grand"><span>Grand Total</span><span>Rs. ${o.grandTotal.toLocaleString('en-IN')}</span></div>
      </div>
    </div>
    <div class="disclaimer">Mock invoice generated for a college demo / academic project. No real transaction occurred.</div>
  </div>
</body></html>`;
}

router.get('/api/admin/invoice/:orderId', async (req, res, params) => {
  if (!(await isAdmin(req))) { res.writeHead(401); return res.end('Admin login required.'); }
  const order = await db.getOrderById(params.orderId);
  if (!order) { res.writeHead(404); return res.end('Order not found.'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderInvoiceHtml(order));
});

const ADMIN_PAGE_SIZE = 20;

router.get('/api/admin/orders', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  await db.refreshStatuses();

  const parsed = url.parse(req.url, true);
  const from = parsed.query.from ? Number(parsed.query.from) : null;
  const to = parsed.query.to ? Number(parsed.query.to) : null;
  const range = (from != null && to != null && !isNaN(from) && !isNaN(to)) ? { from, to } : null;
  const search = String(parsed.query.search || '').trim();
  const sortKey = String(parsed.query.sortKey || '');
  const sortDir = String(parsed.query.sortDir || '');
  const page = Math.max(1, Number(parsed.query.page) || 1);

  const { orders, total } = await db.getAllOrders(range, {
    search, sortKey, sortDir, limit: ADMIN_PAGE_SIZE, offset: (page - 1) * ADMIN_PAGE_SIZE
  });
  const orderStats = await db.getOrderStats(range);
  const stats = {
    totalOrders: orderStats.totalOrders,
    totalRevenue: orderStats.totalRevenue,
    processingCount: orderStats.processingCount,
    deliveredCount: orderStats.deliveredCount,
    // Within a date range, "customers" means distinct buyers in that
    // window, not the all-time registered count.
    totalCustomers: range ? orderStats.distinctCustomers : await db.countUsers()
  };
  sendJson(res, 200, { orders, stats, page, pageSize: ADMIN_PAGE_SIZE, total });
});

router.get('/api/admin/users', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const parsed = url.parse(req.url, true);
  const search = String(parsed.query.search || '').trim();
  const sortKey = String(parsed.query.sortKey || '');
  const sortDir = String(parsed.query.sortDir || '');
  const page = Math.max(1, Number(parsed.query.page) || 1);

  const { users, total } = await db.getAllUsersWithStats({
    search, sortKey, sortDir, limit: ADMIN_PAGE_SIZE, offset: (page - 1) * ADMIN_PAGE_SIZE
  });
  const typeCounts = await db.getUserTypeCounts();
  sendJson(res, 200, { users, page, pageSize: ADMIN_PAGE_SIZE, total, typeCounts });
});

router.get('/api/admin/failed-payments', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const failedPayments = await db.getFailedPayments();
  sendJson(res, 200, { failedPayments });
});

// ---------------------------------------------------------------------------
// Gift code inventory (admin only) - the real codes an admin physically
// holds, entered by hand. This is the only source of codes ever handed to
// an authenticated, logged-in buyer.
// ---------------------------------------------------------------------------
router.get('/api/admin/gift-codes/stock', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const stock = await db.getRealStock();
  const stockMap = new Map(stock.map(s => [`${s.platform}:${s.denomination}`, s.available]));
  const matrix = PLATFORMS.map(p => ({
    id: p.id, name: p.name,
    denominations: DENOMINATIONS.map(d => ({ value: d, available: stockMap.get(`${p.id}:${d}`) || 0 }))
  }));
  sendJson(res, 200, { platforms: PLATFORMS, denominations: DENOMINATIONS, matrix });
});

router.get('/api/admin/gift-codes', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const parsed = url.parse(req.url, true);
  const { codes, total } = await db.listGiftCodes({
    platform: String(parsed.query.platform || '') || undefined,
    type: String(parsed.query.type || '') || undefined,
    status: String(parsed.query.status || '') || undefined,
    search: String(parsed.query.search || '').trim() || undefined,
    limit: ADMIN_PAGE_SIZE, offset: (Math.max(1, Number(parsed.query.page) || 1) - 1) * ADMIN_PAGE_SIZE
  });
  sendJson(res, 200, { codes, total, pageSize: ADMIN_PAGE_SIZE });
});

// Bulk-add real codes an admin physically holds. body: { codes: [{platform, denomination, code}, ...] }
router.post('/api/admin/gift-codes', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const body = await readJsonBody(req);
  const entries = Array.isArray(body.codes) ? body.codes : [body];

  const results = [];
  for (const entry of entries) {
    const platform = getPlatform(String(entry.platform || ''));
    const code = String(entry.code || '').trim();
    if (!platform) { results.push({ code, ok: false, error: 'Unknown platform.' }); continue; }
    if (!isValidDenomination(entry.denomination)) { results.push({ code, ok: false, error: 'Invalid denomination.' }); continue; }
    if (!code) { results.push({ code, ok: false, error: 'Code is required.' }); continue; }
    try {
      await db.addRealGiftCode({ platform: platform.id, denomination: Number(entry.denomination), code });
      results.push({ code, ok: true });
    } catch (e) {
      results.push({ code, ok: false, error: e.code === 'ER_DUP_ENTRY' ? 'This code already exists.' : e.message });
    }
  }
  const added = results.filter(r => r.ok).length;
  sendJson(res, 200, { added, results });
});

router.add('DELETE', '/api/admin/gift-codes/:id', async (req, res, params) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const removed = await db.deleteAvailableGiftCode(Number(params.id));
  if (!removed) return sendJson(res, 404, { error: 'Code not found or already sold.' });
  sendJson(res, 200, { ok: true });
});

router.post('/api/admin/offline-orders', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  const body = await readJsonBody(req);
  const name = String(body.customerName || '').trim() || 'Walk-in Customer';
  const amount = parseFloat(body.amount);
  const smsText = String(body.smsText || '').trim();

  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Please enter a valid amount.' });

  const order = await synthesizeGiftCodeOrder({
    amount, name, customerEmail: '—', offline: true, source: smsText ? 'sms-paste' : 'manual'
  });
  sendJson(res, 200, order);
});

router.get('/api/admin/orders/export.csv', async (req, res) => {
  if (!(await isAdmin(req))) { res.writeHead(401); return res.end('Admin login required.'); }
  const parsed = url.parse(req.url, true);
  const from = parsed.query.from ? Number(parsed.query.from) : null;
  const to = parsed.query.to ? Number(parsed.query.to) : null;
  const range = (from != null && to != null && !isNaN(from) && !isNaN(to)) ? { from, to } : null;
  const { orders } = await db.getAllOrders(range); // no limit - export gets every matching row
  const header = ['Order ID', 'Customer Name', 'Customer Email', 'Date', 'Items', 'Item Count', 'Subtotal', 'Platform Fee', 'Delivery', 'Grand Total', 'Source', 'Status', 'Delivery Address'];
  const esc = v => {
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = orders.map(o => [
    o.orderId, o.customerName, o.customerEmail, o.orderDate,
    o.items.map(i => `${i.platformName} ₹${i.denomination} (${i.code})`).join(' | '),
    o.items.length,
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

// Owner-facing endpoint to fetch the Razorpay webhook secret, in case it's
// still running in query-secret testing mode (no RAZORPAY_WEBHOOK_SECRET set).
router.get('/api/admin/webhook-info', async (req, res) => {
  if (!(await isAdmin(req))) return sendJson(res, 401, { error: 'Admin login required.' });
  sendJson(res, 200, { razorpaySecret: await db.getOrCreateRazorpaySecret() });
});

// ---------------------------------------------------------------------------
// Razorpay webhook: fires on `payment.captured` for payments that never went
// through the site's own checkout (a QR code scan, a Payment Link, etc) - so
// there's no cart, no platform, no denomination on file for it. Turns the
// captured amount into an auto-attributed customer order with a freshly
// minted synthetic gift code (random platform, value = amount paid).
// ---------------------------------------------------------------------------
router.post('/api/webhook/razorpay-payment', async (req, res) => {
  const raw = await readRawBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch (e) { return sendJson(res, 400, { error: 'Invalid JSON body' }); }

  const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (RAZORPAY_WEBHOOK_SECRET) {
    // Production path: verify the HMAC-SHA256 signature Razorpay sends in
    // the X-Razorpay-Signature header, signed with the secret configured in
    // the Razorpay dashboard's webhook settings.
    const signature = req.headers['x-razorpay-signature'];
    if (!verifyRazorpaySignature(raw, signature, RAZORPAY_WEBHOOK_SECRET)) {
      return sendJson(res, 401, { error: 'Invalid Razorpay signature.' });
    }
  } else {
    // No production secret configured yet - fall back to a shared-secret
    // query param so this can be smoke-tested with curl before Razorpay is
    // wired up for real.
    const parsed = url.parse(req.url, true);
    const razorpaySecret = await db.getOrCreateRazorpaySecret();
    if (parsed.query.secret !== razorpaySecret) {
      return sendJson(res, 401, { error: 'Invalid or missing webhook secret.' });
    }
  }

  const details = extractRazorpayPaymentDetails(body);
  if (body.event && details.event !== 'manual' && body.event !== 'payment.captured') {
    if (body.event === 'payment.failed') {
      const entity = body.payload && body.payload.payment && body.payload.payment.entity;
      await db.recordFailedPayment({
        razorpayPaymentId: entity && entity.id,
        amount: entity && typeof entity.amount === 'number' ? entity.amount / 100 : null,
        name: entity && entity.notes && (entity.notes.name || entity.notes.customer_name),
        email: entity && entity.email,
        reason: entity && (entity.error_description || entity.error_reason)
      });
    }
    return sendJson(res, 200, { ok: true, ignored: true, event: body.event });
  }
  if (!details.amount || details.amount <= 0) {
    return sendJson(res, 400, { error: 'Could not find a valid payment amount.', body });
  }

  const name = details.name || 'Razorpay Customer';
  const identitySlug = details.slug || name;
  const user = await findOrCreateAutoUser(identitySlug, name);
  const order = await synthesizeGiftCodeOrder({
    amount: details.amount, name: user.name, userEmail: user.email, customerEmail: user.email,
    offline: false, source: 'razorpay-webhook', contact: details.contact
  });
  sendJson(res, 200, {
    ok: true, amount: details.amount, name: user.name, email: user.email,
    orderId: order.orderId, items: order.items.map(i => `${i.platformName} ₹${i.denomination}`)
  });
});

// ---------------------------------------------------------------------------
// HTTP server / static file serving
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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

async function start() {
  await db.init();

  // Sweep for orders that finished "processing" even with no active requests.
  setInterval(() => { db.refreshStatuses().catch(e => console.error('refreshStatuses failed:', e.message)); }, 15_000);

  server.listen(PORT, async () => {
    console.log(`\nGiftMint backend running at http://localhost:${PORT}`);
    console.log(`Owner login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    if (process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.log(`Razorpay webhook URL (signature-verified): https://<your-domain>/api/webhook/razorpay-payment`);
    } else {
      const razorpaySecret = await db.getOrCreateRazorpaySecret();
      console.log(`Razorpay webhook secret (testing only, no signature check yet): ${razorpaySecret}`);
      console.log(`Razorpay test webhook URL: https://<your-domain>/api/webhook/razorpay-payment?secret=${razorpaySecret}`);
      console.log(`Set RAZORPAY_WEBHOOK_SECRET env var once Razorpay is wired up for real (enables signature verification).`);
    }
    console.log('');
  });
}

start().catch(e => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
