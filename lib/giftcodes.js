// Generates realistic-looking (but synthetic/fake) gift card code strings for
// a given platform, e.g. "FLPKT-9K2H-7QXZ-3RTN". Used only for codes we
// invent ourselves to match an unattributed bank payment - never for the
// real codes an admin enters, which are typed in as-is.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids look-alike chars on an invoice

function randomGroup(len) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function formatCode(prefix) {
  return `${prefix}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

module.exports = { formatCode };
