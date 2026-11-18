require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getEnv, exchangeCode, apiGet, summarize } = require('./foodics');

const {
  FOODICS_ENV = 'sandbox',
  FOODICS_CLIENT_ID,
  FOODICS_CLIENT_SECRET,
  FOODICS_REDIRECT_URI,
  WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ FOODICS_CLIENT_ID, FOODICS_CLIENT_SECRET, FOODICS_REDIRECT_URI, WEBHOOK_SECRET })) {
  if (!v) {
    console.error(`Missing ${k} in .env (copy .env.example to .env and fill it in)`);
    process.exit(1);
  }
}

const env = getEnv(FOODICS_ENV);
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONNECTION_FILE = path.join(DATA_DIR, 'connection.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- tiny file-backed storage -------------------------------------------

function readConnection() {
  try { return JSON.parse(fs.readFileSync(CONNECTION_FILE, 'utf8')); } catch { return null; }
}
function writeConnection(c) {
  fs.writeFileSync(CONNECTION_FILE, JSON.stringify(c, null, 2));
}
function readEvents() {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// Last known status per order, so the log can show "Active -> Closed".
const lastSeen = new Map();
for (const e of readEvents()) {
  if (e.summary.orderId) lastSeen.set(e.summary.orderId, e.summary);
}

// ---- live updates to the dashboard (Server-Sent Events) ------------------

const clients = new Set();
function broadcast(record) {
  const line = `data: ${JSON.stringify(record)}\n\n`;
  for (const res of clients) res.write(line);
}

// ---- app -----------------------------------------------------------------

const app = express();
const pendingStates = new Map(); // state -> created time

app.use(express.static(path.join(__dirname, '..', 'public')));

// Step 1: send the merchant to Foodics to approve the app.
app.get('/oauth/connect', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const url = new URL(env.authorizeUrl);
  url.searchParams.set('client_id', FOODICS_CLIENT_ID);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// Step 2: Foodics redirects back with ?code&state. Code is valid for 600 s.
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!state || !pendingStates.has(state)) {
    return res.status(400).send('Invalid or expired state. Start again at /oauth/connect.');
  }
  pendingStates.delete(state);
  if (!code) return res.status(400).send('No code returned by Foodics.');

  try {
    const token = await exchangeCode(env, {
      code,
      clientId: FOODICS_CLIENT_ID,
      clientSecret: FOODICS_CLIENT_SECRET,
      redirectUri: FOODICS_REDIRECT_URI,
    });
    let whoami = null;
    try { whoami = await apiGet(env, token.access_token, '/whoami'); } catch (e) { whoami = { error: e.message }; }
    writeConnection({ connectedAt: new Date().toISOString(), env: FOODICS_ENV, token, whoami });
    console.log('[oauth] connected to Foodics', FOODICS_ENV);
    res.redirect('/?connected=1');
  } catch (err) {
    console.error('[oauth]', err.message);
    res.status(502).send(`Could not exchange code: ${err.message}`);
  }
});

// Connection status for the dashboard. The token itself is never sent out.
app.get('/api/connection', (req, res) => {
  const c = readConnection();
  if (!c) return res.json({ connected: false, env: FOODICS_ENV });
  const user = c.whoami && c.whoami.data ? c.whoami.data : null;
  res.json({
    connected: true,
    env: c.env,
    connectedAt: c.connectedAt,
    business: user && user.business ? user.business.name : null,
    user: user && user.user ? user.user.name : null,
  });
});

// Fetch the order straight from the Foodics API to cross-check a webhook.
app.get('/api/orders/:id', async (req, res) => {
  const c = readConnection();
  if (!c) return res.status(400).json({ error: 'Not connected' });
  try {
    res.json(await apiGet(env, c.token.access_token, `/orders/${encodeURIComponent(req.params.id)}`));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/events', (req, res) => res.json(readEvents().reverse()));

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Step 3: Foodics webhooks. Foodics times out after 5 s and only wants a 2xx,
// so answer first, then process. Foodics does not sign requests; the secret
// in the URL path keeps strangers from posting fake events.
app.post('/webhooks/foodics/:secret', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  const ok = req.params.secret.length === WEBHOOK_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(req.params.secret), Buffer.from(WEBHOOK_SECRET));
  if (!ok) return res.sendStatus(404);

  res.sendStatus(200);

  setImmediate(() => {
    const raw = req.body ? req.body.toString('utf8') : '';
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { unparsed: raw }; }

    const summary = summarize(payload);
    const prev = summary.orderId ? lastSeen.get(summary.orderId) : undefined;
    if (prev) {
      summary.previousStatusLabel = prev.statusLabel;
      summary.previousDeliveryStatusLabel = prev.deliveryStatusLabel;
    }
    if (summary.orderId) lastSeen.set(summary.orderId, summary);

    const record = {
      receivedAt: new Date().toISOString(),
      headers: {
        'user-agent': req.get('user-agent'),
        'content-type': req.get('content-type'),
      },
      summary,
      payload,
    };
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + '\n');
    broadcast(record);

    const change = prev && prev.statusLabel !== summary.statusLabel ? ` (${prev.statusLabel} -> ${summary.statusLabel})` : '';
    console.log(
      `[webhook] ${summary.event} order=${summary.reference || summary.orderId || '-'} ` +
      `status=${summary.statusLabel || summary.status || '-'}${change} ` +
      `delivery=${summary.deliveryStatusLabel || '-'}${summary.isReady ? '  <-- READY' : ''}`
    );
  });
});

app.listen(PORT, () => {
  console.log(`Foodics demo on http://localhost:${PORT}  (env: ${FOODICS_ENV})`);
  console.log(`Webhook path: /webhooks/foodics/${WEBHOOK_SECRET.slice(0, 4)}...`);
});
