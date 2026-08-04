const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isValidGmail(email) {
  return /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(String(email || '').toLowerCase());
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

// `req` is used only to decide whether to add the Secure flag (the request
// arrived over HTTPS) - Hostinger terminates TLS upstream and forwards
// x-forwarded-proto, so req.socket alone wouldn't show HTTPS even in
// production. Falls back to no Secure flag when req is omitted (or the
// connection is plain HTTP, e.g. local dev on http://localhost) so cookies
// still work there.
function isHttps(req) {
  return !!req && (req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true);
}

function setCookie(res, name, value, maxAgeSeconds, req) {
  const existing = res.getHeader('Set-Cookie');
  const secure = isHttps(req) ? '; Secure' : '';
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
  const arr = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

module.exports = {
  hashPassword, verifyPassword, newToken, isValidGmail,
  parseCookies, setCookie, clearCookie
};
