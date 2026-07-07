# Prizm Coffee — Kitchen Display

Real-time kitchen ticket board for Square POS orders. When a customer pays, the order appears instantly on every barista's screen. Tap **✓ Delivered** when the drink is handed off.

Live at: **https://kitchen.prizmcoffee.com**

---

## Deploy to Railway (one-time setup)

### 1 — Push this repo to GitHub

```bash
git add .
git commit -m "Initial kitchen display"
git push
```

### 2 — Create a Railway project

1. Go to [railway.app](https://railway.app) and sign up with your GitHub account
2. Click **New Project → Deploy from GitHub repo**
3. Select **mvr1127/squareorders**
4. Railway will detect Node.js and deploy automatically

### 3 — Set environment variables in Railway

In your Railway project, go to **Variables** and add each of the following:

| Variable | Value |
|---|---|
| `SQUARE_ACCESS_TOKEN` | From Square Developer Portal → your app → Production Credentials |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | From Square webhook subscription (step 5 below) |
| `SQUARE_ENVIRONMENT` | `production` |
| `WEBHOOK_URL` | `https://kitchen.prizmcoffee.com/webhook/square` |
| `APP_PASSWORD` | A password your baristas will use to log in |
| `SESSION_SECRET` | Any long random string (e.g. 40+ random characters) |

> **Do not add PORT** — Railway sets it automatically.

### 4 — Add the custom domain in Railway

1. In your Railway project, go to **Settings → Networking → Custom Domain**
2. Click **Add Domain** and enter: `kitchen.prizmcoffee.com`
3. Railway will show you a **CNAME value** — copy it (looks like `xyz.up.railway.app`)

### 5 — Add a DNS record in Wix

1. Log in to Wix → **Domains** → click **prizmcoffee.com** → **Advanced DNS**
2. Click **Add Record** and enter:
   - **Type**: CNAME
   - **Host**: `kitchen`
   - **Value**: paste the CNAME from Railway (e.g. `xyz.up.railway.app`)
   - **TTL**: 1 hour
3. Save. DNS can take up to 10 minutes to go live.

### 6 — Set up Square webhook

1. Go to [Square Developer Portal](https://developer.squareup.com/apps) → your app → **Webhooks**
2. Click **Add Subscription**
3. Set the URL to: `https://kitchen.prizmcoffee.com/webhook/square`
4. Check the event: **`payment.completed`**
5. Save and copy the **Signature Key** → paste it into Railway as `SQUARE_WEBHOOK_SIGNATURE_KEY`

### 7 — Open the display

Go to **https://kitchen.prizmcoffee.com** on any phone or tablet, enter your barista password, and you're live.

---

## Local development

```bash
# Copy and fill in environment variables
cp .env.example .env

# Install dependencies
npm install

# Start the server
npm start
# or with auto-reload:
npm run dev
```

Open http://localhost:3000 in your browser. A **+ Test Ticket** button appears when running locally so you can add dummy orders without Square.

---

## How it works

1. Customer pays on Square POS → Square fires a `payment.completed` webhook to your server
2. Server fetches the full order from Square API (items, modifiers, customer name)
3. Ticket is saved and broadcast to all connected screens via Server-Sent Events
4. Barista taps **✓ Delivered** → ticket is removed from all screens instantly

---

## Switching between sandbox and production

Change `SQUARE_ENVIRONMENT` in Railway:
- `sandbox` — use test credentials, no real orders
- `production` — live orders, use production credentials from Square
