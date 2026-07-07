require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let tickets = [];
try {
  const raw = fs.readFileSync(TICKETS_FILE, 'utf8');
  tickets = JSON.parse(raw).filter(t => !t.delivered);
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
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.xhr || req.headers.accept?.includes('application/json') || req.headers.accept?.includes('text/event-stream')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

app.post('/webhook/square', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-square-hmacsha256-signature'];

  if (SQUARE_WEBHOOK_SIGNATURE_KEY && WEBHOOK_URL) {
    if (!signature) {
      return res.status(401).send('Missing signature');
    }
    const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(WEBHOOK_URL + rawBody);
    const expected = hmac.digest('base64');
    try {
      const sigBuf = Buffer.from(signature, 'base64');
      const expBuf = Buffer.from(expected, 'base64');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(401).send('Invalid signature');
      }
    } catch (_) {
      return res.status(401).send('Invalid signature');
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return res.status(400).send('Invalid JSON');
  }

  res.status(200).send('OK');

  try {
    await processSquareEvent(event);
  } catch (err) {
    console.error('Error processing Square event:', err.message);
  }
});

async function processSquareEvent(event) {
  console.log(`Received Square event: ${event.type}`);

  let orderId = null;

  if (event.type === 'payment.completed') {
    orderId = event.data?.object?.payment?.order_id;
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
    console.error(`Square API error fetching order ${orderId}: ${res.status}`);
    return null;
  }
  const data = await res.json();
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

  return {
    id: order.id,
    orderId: order.id,
    ticketName: order.ticket_name || null,
    customerName: customerName || null,
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
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/tickets', requireAuth, (req, res) => {
  res.json(tickets.filter(t => !t.delivered));
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

app.get('/api/events', requireAuth, (req, res) => {
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/style.css', express.static(path.join(__dirname, 'public', 'style.css')));
app.use('/app.js', express.static(path.join(__dirname, 'public', 'app.js')));

app.listen(PORT, () => {
  console.log(`\nSquare Kitchen Display running on http://localhost:${PORT}`);
  console.log(`Environment: ${SQUARE_ENVIRONMENT}`);
  console.log(`Password: ${APP_PASSWORD}\n`);
});
