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

On startup the terminal prints:
- the owner login (`owner@leelamart.com` / `admin123`)
- a randomly generated IFTTT webhook secret (stays the same across restarts,
  stored in `data/store.json`)

You can also see the webhook URL + secret any time from inside the **Owner
Dashboard** (footer → "Owner / Admin Login").

## What's inside

- `server.js` — HTTP server + all API routes (auth, products, orders, admin, webhook)
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
- copy the **IFTTT webhook URL** shown in the dashboard

To change the owner login, set environment variables before starting:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=somethingBetter node server.js
```

## Connecting IFTTT (auto-log bank credit notifications)

This lets your phone automatically create an "Offline — Delivered" order
whenever a matching bank/UPI notification appears, without opening the
dashboard yourself.

**Important - this needs to be reachable from the internet.** Running
`node server.js` only serves `http://localhost:3000`, which your phone (and
IFTTT's servers) cannot reach. For a **trial**, expose it temporarily with a
tunnel like [ngrok](https://ngrok.com):

```bash
npx ngrok http 3000
```

ngrok will print a public URL like `https://abcd1234.ngrok-free.app`. Use
that in place of `localhost:3000` below. (Free ngrok URLs change every time
you restart it — fine for testing, not for a permanent setup. For that
you'd eventually deploy this server somewhere with a fixed domain, e.g.
Render/Railway.)

**IFTTT applet setup (Android only — iOS does not allow this):**

1. Install the IFTTT app on the phone that receives your bank/UPI notifications.
2. Create a new applet: **If** → *Notifications* service → *"New notification from Android"* (optionally filter by app, e.g. your bank's app or Google Pay).
3. **Then** → *Webhooks* service → *"Make a web request"**:
   - URL: `https://<your-ngrok-domain>/api/webhook/bank-notification?secret=<your webhook secret>`
   - Method: `POST`
   - Content Type: `application/json`
   - Body: `{"text": "{{NotificationContent}}"}` (use the Notification Content ingredient IFTTT offers)
4. Save it. Next time a matching notification arrives, this server extracts
   the rupee amount (looks for `Rs.`, `INR`, or `₹` followed by a number) and
   logs a "Delivered" offline order automatically — visible instantly in the
   Owner Dashboard.

**Reality check on this approach:** it's a fun trial/hackathon-grade setup,
not something to run a real business on. Notification wording differs bank
to bank, IFTTT free plans cap how many applets/runs you get, and there's no
guarantee of delivery. For a real shop, a payment gateway (Razorpay,
Cashfree, etc.) that gives you a proper server-to-server webhook the moment
a payment succeeds is far more reliable — no phone, no SMS parsing needed.

## Limitations (by design, it's a college demo)

- `data/store.json` is a flat file, not a real database — fine for a single
  small shop's worth of traffic, not for production scale.
- No HTTPS built in — if you deploy this beyond localhost/ngrok, put it
  behind a reverse proxy (nginx, Caddy) or a host that terminates TLS for you.
- Passwords are hashed (scrypt) but there's no email verification, rate
  limiting, or account lockout — add those before using this for anything
  real.
