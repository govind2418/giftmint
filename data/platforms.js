// Static catalog of gift-card platforms and the denomination tiers we sell.
// Real code inventory (which of these platform+denomination combos actually
// has a code in stock) lives in the `gift_codes` table, not here - this file
// only defines what's sellable in principle and how a realistic-looking code
// is formatted per platform.
const DENOMINATIONS = [100, 200, 500, 1000, 1500, 2000, 2500, 3000];

const PLATFORMS = [
  { id: 'myntra', name: 'Myntra', prefix: 'MYNT' },
  { id: 'flipkart', name: 'Flipkart', prefix: 'FLPKT' },
  { id: 'zepto', name: 'Zepto', prefix: 'ZPTO' },
  { id: 'amazon', name: 'Amazon', prefix: 'AMZN' }
];

function getPlatform(id) {
  return PLATFORMS.find(p => p.id === id) || null;
}

function isValidDenomination(value) {
  return DENOMINATIONS.includes(Number(value));
}

module.exports = { PLATFORMS, DENOMINATIONS, getPlatform, isValidDenomination };
