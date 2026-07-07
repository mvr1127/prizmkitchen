# Kitchen Ticket Display — Square Orders

Build a password-protected web app that listens for Square webhook events (`payment.completed`),
displays live kitchen tickets with item names, quantities, modifiers, and customer name,
and lets baristas mark orders as delivered. Uses SSE for real-time browser updates.

### [x] Step 1: Project setup
- package.json (express, express-session, dotenv)
- .gitignore, .env.example

### [x] Step 2: Express server
- Auth (session-based, single shared password)
- Square webhook handler with HMAC-SHA256 signature verification
- Order fetching from Square API (sandbox/production switchable)
- Ticket storage (in-memory + JSON file persistence)
- SSE endpoint for real-time browser push
- Ticket deliver endpoint
- Dev-only test ticket endpoint

### [x] Step 3: Frontend
- login.html — password form
- index.html + app.js — live kitchen display
- style.css — mobile-first, coffee-themed UI with large readable cards
- Real-time updates via SSE; browser notifications when tab is hidden
