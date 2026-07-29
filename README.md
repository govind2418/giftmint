# Leela Mart — Backend

A real Node.js backend for the Leela Mart college-project demo. No external
npm packages required (pure built-in Node modules), so `npm install` has
nothing to download — it just works.

It replaces the old "everything lives in browser memory" version: users,
orders and offline payments now persist in `data/store.json` on disk, so
they survive page reloads and browser restarts.

## Run it

```bash
node server.js
```

Then open **http://localhost:3000** in your browser. That's it — no
database server, no build step, no `npm install`.

On startup the terminal prints the owner login (`owner@leelamart.com` /
`admin123`) and the Razorpay webhook URL/secret.

## What's inside

- `server.js` — HTTP server + all API routes (auth, products, orders, admin, payments, webhook)
- `lib/store.js` — tiny JSON-file database
- `lib/auth.js` — password hashing (scrypt), session tokens, cookies
- `lib/router.js` — minimal Express-style router
- `data/products.js` — the 100-item product catalog
- `data/store.json` — created automatically on first run (users, orders, offline orders)
- `public/index.html` — the storefront + owner dashboard (talks to the API via `fetch`)

## Customer accounts

Signup/login only accept `@gmail.com` addresses (same rule as the earlier
demo). "Forgot password" resets the password for an existing Gmail account.

## Owner Dashboard

Footer → "Owner / Admin Login" → `owner@leelamart.com` / `admin123`.

From there you can:
- see every order from every customer, with totals and status
- **Add Offline Order** — manually record a payment received outside the
  site (optionally paste the bank SMS text and it auto-fills the amount)
- **Export CSV** — download every order as a spreadsheet
- open a **per-order invoice** (print/save as PDF) for any order

To change the owner login, set environment variables before starting:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=somethingBetter node server.js
```

## Razorpay payments

Real Standard Checkout is wired up end-to-end: `POST /api/payments/create-order`
prices the cart server-side and creates a Razorpay order, the storefront opens
Razorpay's Checkout modal, and `POST /api/payments/verify` checks the payment
signature before the order is created. There's also `POST
/api/webhook/razorpay-payment`, which turns a `payment.captured` webhook into
an auto-attributed order (useful for payments made outside the site, e.g.
Payment Links).

Set these in `.env` (see `.env.example`) or the host's environment variables:

```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...   # only needed once the webhook is configured in the Razorpay dashboard
```

## Limitations (by design, it's a college demo)

- `data/store.json` is a flat file, not a real database — fine for a single
  small shop's worth of traffic, not for production scale.
- No HTTPS built in — if you deploy this beyond localhost/ngrok, put it
  behind a reverse proxy (nginx, Caddy) or a host that terminates TLS for you.
- Passwords are hashed (scrypt) but there's no email verification, rate
  limiting, or account lockout — add those before using this for anything
  real.
