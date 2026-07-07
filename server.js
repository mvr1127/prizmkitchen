require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || 'sandbox';
const SQUARE_BASE_URL = SQUARE_ENVIRONMENT === 'production'
  ? 'https://connect.squareup.com/v2'
  : 'https://connect.squareupsandbox.com/v2';
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const APP_PASSWORD = process.env.APP_PASSWORD || 'coffee123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const DATA_DIR = path.join(__dirname, 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');

const sseTokens = new Map();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let tickets = [];
let ticketCounter = 1;
try {
  const raw = fs.readFileSync(TICKETS_FILE, 'utf8');
  tickets = JSON.parse(raw).filter(t => !t.delivered);
  if (tickets.length > 0) {
    ticketCounter = Math.max(...tickets.map(t => t.number || 0)) + 1;
  }
} catch (_) {}

function saveTickets() {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}

let sseClients = [];

function broadcastSSE(payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients = sseClients.filter(res => {
    try {
      res.write(message);
      return true;
    } catch (_) {
      return false;
    }
  });
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.xhr || req.headers.accept?.includes('application/json') || req.headers.accept?.includes('text/event-stream')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

app.post('/webhook/square', express.raw({ type: '*/*' }), async (req, res) => {
  console.log('Webhook hit — raw body length:', req.body?.length);

  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-square-hmacsha256-signature'];

  console.log('Signature present:', !!signature);
  console.log('WEBHOOK_URL set:', !!WEBHOOK_URL);
  console.log('SIGNATURE_KEY set:', !!SQUARE_WEBHOOK_SIGNATURE_KEY);

  if (SQUARE_WEBHOOK_SIGNATURE_KEY && WEBHOOK_URL) {
    if (!signature) {
      console.log('Rejected: missing signature');
      return res.status(401).send('Missing signature');
    }
    const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(WEBHOOK_URL + rawBody);
    const expected = hmac.digest('base64');
    try {
      const sigBuf = Buffer.from(signature, 'base64');
      const expBuf = Buffer.from(expected, 'base64');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.log('Rejected: signature mismatch');
        console.log('Expected:', expected);
        console.log('Received:', signature);
        return res.status(401).send('Invalid signature');
      }
    } catch (err) {
      console.log('Rejected: signature error —', err.message);
      return res.status(401).send('Invalid signature');
    }
    console.log('Signature verified OK');
  } else {
    console.log('Signature check skipped — env vars not set');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    console.log('Rejected: invalid JSON');
    return res.status(400).send('Invalid JSON');
  }

  console.log('Event type:', event.type);

  res.status(200).send('OK');

  try {
    await processSquareEvent(event);
  } catch (err) {
    console.error('Error in processSquareEvent:', err.message, err.stack);
  }
});

async function processSquareEvent(event) {
  console.log(`Received Square event: ${event.type}`);

  let orderId = null;

  if (event.type === 'payment.completed' || event.type === 'payment.updated' || event.type === 'payment.created') {
    const payment = event.data?.object?.payment;
    console.log(`Payment status: ${payment?.status}, order_id: ${payment?.order_id}`);
    if (payment?.order_id) {
      orderId = payment.order_id;
    }
  } else if (event.type === 'order.updated') {
    const updated = event.data?.object?.order_updated;
    if (updated?.state === 'COMPLETED') {
      orderId = updated.order_id || event.data?.id;
    }
  }

  if (!orderId) {
    console.log(`No order ID found in event or state not COMPLETED — skipping`);
    return;
  }

  const existing = tickets.find(t => t.orderId === orderId);
  if (existing) {
    console.log(`Order ${orderId} already in queue — skipping`);
    return;
  }

  const order = await fetchOrder(orderId);
  if (!order) return;

  const ticket = buildTicket(order);
  tickets.push(ticket);
  saveTickets();
  broadcastSSE({ type: 'new_ticket', ticket });
  console.log(`New ticket added: ${ticket.id} for ${ticket.customerName || 'Unknown'}`);
}

async function fetchOrder(orderId) {
  const res = await fetch(`${SQUARE_BASE_URL}/orders/${orderId}`, {
    headers: {
      'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Square-Version': '2024-01-17',
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`Square API error fetching order ${orderId}: ${res.status} — ${errBody}`);
    return null;
  }
  const data = await res.json();
  console.log(`Fetched order ${orderId}, state: ${data.order?.state}, items: ${data.order?.line_items?.length}`);
  return data.order || null;
}

function buildTicket(order) {
  const customerName =
    order.fulfillments?.[0]?.pickup_details?.recipient?.display_name ||
    order.ticket_name ||
    null;

  const items = (order.line_items || []).map(item => ({
    name: item.name || 'Item',
    quantity: item.quantity || '1',
    modifiers: (item.modifiers || []).map(m => m.name).filter(Boolean),
    note: item.note || null
  }));

  const number = ticketCounter++;

  return {
    id: order.id,
    orderId: order.id,
    number,
    ticketName: order.ticket_name || null,
    customerName: customerName || null,
    orderNote: order.note || null,
    items,
    createdAt: order.created_at || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    delivered: false
  };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.authenticated = true;
    const sseToken = crypto.randomBytes(24).toString('hex');
    sseTokens.set(sseToken, Date.now());
    setTimeout(() => sseTokens.delete(sseToken), 24 * 60 * 60 * 1000);
    return res.json({ success: true, sseToken });
  }
  res.status(401).json({ success: false, message: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/tickets', requireAuth, (req, res) => {
  res.json(tickets.filter(t => !t.delivered));
});

app.get('/api/tickets/delivered', requireAuth, (req, res) => {
  const delivered = tickets.filter(t => t.delivered)
    .sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt))
    .slice(0, 50);
  res.json(delivered);
});

app.post('/api/tickets/:id/deliver', requireAuth, (req, res) => {
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.delivered = true;
  ticket.deliveredAt = new Date().toISOString();
  saveTickets();
  broadcastSSE({ type: 'ticket_delivered', ticketId: ticket.id });
  console.log(`Ticket delivered: ${ticket.id}`);
  res.json({ success: true });
});

app.post('/api/tickets/:id/restore', requireAuth, (req, res) => {
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.delivered = false;
  delete ticket.deliveredAt;
  saveTickets();
  broadcastSSE({ type: 'new_ticket', ticket });
  res.json({ success: true });
});

app.post('/api/tickets/manual', requireAuth, (req, res) => {
  const { customerName, orderNote, items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item required' });
  }

  const number = ticketCounter++;
  const ticket = {
    id: `MANUAL-${Date.now()}`,
    orderId: null,
    number,
    ticketName: null,
    customerName: customerName?.trim() || null,
    orderNote: orderNote?.trim() || null,
    items: items.map(item => ({
      name: item.name?.trim() || 'Item',
      quantity: String(item.quantity || '1'),
      modifiers: (item.modifiers || []).filter(Boolean),
      note: item.note?.trim() || null
    })),
    createdAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    delivered: false,
    manual: true
  };

  tickets.push(ticket);
  saveTickets();
  broadcastSSE({ type: 'new_ticket', ticket });
  res.json({ success: true, ticket });
});

app.get('/api/events', (req, res) => {
  const token = req.query.token;
  const sessionOk = !!req.session.authenticated;
  const tokenOk = !!(token && sseTokens.has(token));
  console.log(`SSE attempt — session:${sessionOk} token:${token ? token.slice(0,8) : 'none'} tokenValid:${tokenOk} mapSize:${sseTokens.size}`);
  if (!sessionOk && !tokenOk) {
    return res.status(401).end();
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.push(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c !== res);
  });
});

if (process.env.NODE_ENV !== 'production') {
  app.post('/api/test-ticket', requireAuth, (req, res) => {
    const testOrder = {
      id: `TEST-${Date.now()}`,
      ticket_name: `T${Math.floor(Math.random() * 99) + 1}`,
      created_at: new Date().toISOString(),
      fulfillments: [{
        pickup_details: {
          recipient: { display_name: req.body.customerName || 'Test Customer' }
        }
      }],
      line_items: [
        {
          name: 'Latte',
          quantity: '2',
          modifiers: [{ name: 'Oat Milk' }, { name: 'Extra Shot' }],
          note: 'No foam please'
        },
        {
          name: 'Cappuccino',
          quantity: '1',
          modifiers: [],
          note: null
        }
      ]
    };

    const ticket = buildTicket(testOrder);
    tickets.push(ticket);
    saveTickets();
    broadcastSSE({ type: 'new_ticket', ticket });
    res.json({ success: true, ticket });
  });
}

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  const sseToken = crypto.randomBytes(24).toString('hex');
  sseTokens.set(sseToken, Date.now());
  setTimeout(() => sseTokens.delete(sseToken), 24 * 60 * 60 * 1000);

  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  html = html.replace('</head>', `  <script>window.__SSE_TOKEN__="${sseToken}";</script>\n</head>`);
  res.send(html);
});

app.use('/style.css', express.static(path.join(__dirname, 'public', 'style.css')));
app.get('/app.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.listen(PORT, () => {
  console.log(`\nSquare Kitchen Display running on http://localhost:${PORT}`);
  console.log(`Environment: ${SQUARE_ENVIRONMENT}`);
  console.log(`Password: ${APP_PASSWORD}\n`);
});
