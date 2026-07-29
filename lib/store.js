// Tiny JSON-file "database". Good enough for a college demo / low-traffic
// single-owner shop - not meant for high concurrency production use.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'store.json');

function defaultStore() {
  return {
    users: {},              // email -> { name, email, passwordHash, passwordSalt, sessionTokens: [], orders: [] }
    offlineOrders: [],      // manually / webhook recorded offline payments
    adminSessionTokens: [],
    webhookSecret: crypto.randomBytes(16).toString('hex')
  };
}

let store = null;

function load() {
  if (store) return store;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    store = JSON.parse(raw);
    // backfill in case of older/partial files
    if (!store.users) store.users = {};
    if (!store.offlineOrders) store.offlineOrders = [];
    if (!store.adminSessionTokens) store.adminSessionTokens = [];
    if (!store.webhookSecret) store.webhookSecret = crypto.randomBytes(16).toString('hex');
  } catch (e) {
    store = defaultStore();
    save();
  }
  return store;
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

module.exports = { load, save };
