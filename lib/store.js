// Tiny JSON-file "database". Good enough for a college demo / low-traffic
// single-owner shop - not meant for high concurrency production use.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'store.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 30;

function defaultStore() {
  return {
    users: {},              // email -> { name, email, passwordHash, passwordSalt, sessionTokens: [], orders: [] }
    offlineOrders: [],      // manually / webhook recorded offline payments
    adminSessionTokens: [],
    webhookSecret: crypto.randomBytes(16).toString('hex'),
    razorpaySecret: crypto.randomBytes(16).toString('hex')
  };
}

// Finds the most recently written backup file, if any. Used to recover
// real data instead of silently falling back to an empty store whenever
// store.json is missing, corrupted, or accidentally emptied.
function latestBackupPath() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

function pruneBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  while (files.length > MAX_BACKUPS) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
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
    if (!store.razorpaySecret) store.razorpaySecret = crypto.randomBytes(16).toString('hex');
  } catch (e) {
    // store.json is missing/corrupted - try the newest backup before
    // giving up and starting fresh, so a bad write never loses real data.
    const backup = latestBackupPath();
    if (backup) {
      store = JSON.parse(fs.readFileSync(backup, 'utf8'));
    } else {
      store = defaultStore();
    }
    save();
  }
  return store;
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Snapshot whatever is currently on disk before overwriting it, so an
  // accidental empty/bad write is always recoverable from data/backups.
  if (fs.existsSync(STORE_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(STORE_PATH, path.join(BACKUP_DIR, `store.${stamp}.json`));
    pruneBackups();
  }

  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

module.exports = { load, save };
