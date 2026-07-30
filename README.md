# GiftMint — Backend

A real Node.js backend for a gift-card marketplace demo (Myntra, Flipkart,
Zepto, Amazon). Data is persisted in MySQL, so it survives redeploys - not
just a flat file sitting inside the app directory.

## How it works

- **Real inventory.** An admin enters actual gift codes they hold (platform +
  denomination + code) into the Gift Codes tab. A logged-in customer can only
  ever buy a platform/denomination combo that has real stock - out of stock
  blocks the purchase before payment even starts.
- **Unattributed payments.** A Razorpay webhook payment (or a manually
  recorded offline payment) that doesn't come from the site's own checkout has
  no cart, no platform, no denomination on file. Instead of matching it to
  real stock, the server mints a one-off synthetic code: a random platform,
  valued at exactly the amount received, in a format that looks like a real
  code but is guaranteed unique and clearly tagged `synthetic` in the admin
  dashboard - it never touches the real inventory reserved for authenticated
  buyers.

## Run it

```bash
npm install
node server.js
```

Then open **http://localhost:3000** in your browser.

Requires a MySQL database - set `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME` in `.env` (see `.env.example`). Tables are created
automatically on first startup if they don't exist yet.

On startup the terminal prints the owner login (`owner@giftmint.com` /
`admin123`) and the Razorpay webhook URL/secret.

## What's inside

- `server.js` — HTTP server + all API routes (auth, catalog, orders, admin, payments, webhook)
- `lib/db.js` — MySQL persistence layer (users, sessions, orders, gift codes, settings)
- `lib/giftcodes.js` — realistic-looking synthetic code generator
- `lib/auth.js` — password hashing (scrypt), session tokens, cookies
- `lib/router.js` — minimal Express-style router
- `lib/env.js` — tiny dependency-free `.env` loader
- `data/platforms.js` — supported platforms + denomination tiers
- `public/index.html` — the storefront + owner dashboard (talks to the API via `fetch`)

## Customer accounts

Signup/login only accept `@gmail.com` addresses. "Forgot password" resets
the password for an existing Gmail account.

## Owner Dashboard

Footer → "Owner / Admin Login" → `owner@giftmint.com` / `admin123`.

From there you can:
- **Gift Codes** — add real codes you hold (single or bulk-paste), see a
  live stock matrix per platform/denomination, and browse every code (real
  or synthetic, available or redeemed) with the order it was issued against
- see every order from every customer, with totals and status
- **Add Offline Order** — manually record a payment received outside the
  site (optionally paste the bank SMS text and it auto-fills the amount);
  mints a synthetic code the same way the webhook does
- **Export CSV** — download every order as a spreadsheet
- open a **per-order invoice** (print/save as PDF) for any order, showing the
  gift code(s) issued

To change the owner login, set environment variables before starting:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=somethingBetter node server.js
```

## Razorpay payments

Real Standard Checkout is wired up end-to-end: `POST /api/payments/create-order`
checks real stock and prices the cart server-side before creating a Razorpay
order, the storefront opens Razorpay's Checkout modal, and `POST
/api/payments/verify` checks the payment signature and atomically claims the
real code(s) before the order is created. There's also `POST
/api/webhook/razorpay-payment`, which turns a `payment.captured` webhook into
an auto-attributed order with a synthetic code (useful for payments made
outside the site, e.g. Payment Links or UPI QR scans).

Set these in `.env` (see `.env.example`) or the host's environment variables:

```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...   # only needed once the webhook is configured in the Razorpay dashboard
```

## Limitations (by design, it's a demo)

- No HTTPS built in — if you deploy this beyond localhost, put it behind a
  reverse proxy (nginx, Caddy) or a host that terminates TLS for you.
- Passwords are hashed (scrypt) but there's no email verification, rate
  limiting, or account lockout — add those before using this for anything
  real.
- The MySQL connection pool has no retry/backoff logic - fine for a single
  small shop's worth of traffic, not built for high concurrency.
