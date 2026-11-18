require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { getEnv, exchangeCode, apiGet, summarize } = require('./foodics');
const { createStore } = require('./store');

const {
  FOODICS_ENV = 'sandbox',
  FOODICS_CLIENT_ID,
  FOODICS_CLIENT_SECRET,
  FOODICS_REDIRECT_URI,
  WEBHOOK_SECRET,
} = process.env;

const missing = Object.entries({ FOODICS_CLIENT_ID, FOODICS_CLIENT_SECRET, FOODICS_REDIRECT_URI, WEBHOOK_SECRET })
  .filter(([, v]) => !v).map(([k]) => k);

const env = getEnv(FOODICS_ENV);
const store = createStore();
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  if (missing.length && req.path !== '/') {
    return res.status(500).json({ error: `Missing environment variables: ${missing.join(', ')}` });
  }
  next();
});

// ---- OAuth state: signed, so it works without server memory (serverless) --

const STATE_TTL_MS = 10 * 60 * 1000;
const sign = (s) => crypto.createHmac('sha256', FOODICS_CLIENT_SECRET).update(s).digest('hex').slice(0, 32);

function makeState() {
  const body = `${crypto.randomBytes(8).toString('hex')}.${Date.now()}`;
  return `${body}.${sign(body)}`;
}

function checkState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(body);
  if (parts[2].length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return false;
  return Date.now() - Number(parts[1]) < STATE_TTL_MS;
}

// Step 1: send the merchant to Foodics to approve the app.
app.get('/oauth/connect', (req, res) => {
  const url = new URL(env.authorizeUrl);
  url.searchParams.set('client_id', FOODICS_CLIENT_ID);
  url.searchParams.set('state', makeState());
  res.redirect(url.toString());
});

// Step 2: Foodics redirects back with ?code&state. Code is valid for 600 s.
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!checkState(state)) return res.status(400).send('Invalid or expired state. Start again at /oauth/connect.');
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
    await store.setConnection({ connectedAt: new Date().toISOString(), env: FOODICS_ENV, token, whoami });
    console.log('[oauth] connected to Foodics', FOODICS_ENV);
    res.redirect('/?connected=1');
  } catch (err) {
    console.error('[oauth]', err.message);
    res.status(502).send(`Could not exchange code: ${err.message}`);
  }
});

// Connection status for the dashboard. The token itself is never sent out.
app.get('/api/connection', async (req, res) => {
  const c = await store.getConnection();
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
  const c = await store.getConnection();
  if (!c) return res.status(400).json({ error: 'Not connected' });
  try {
    res.json(await apiGet(env, c.token.access_token, `/orders/${encodeURIComponent(req.params.id)}`));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/events', async (req, res) => res.json(await store.listEvents()));

// Step 3: Foodics webhooks. Foodics only wants a 2xx within 5 s. On serverless
// the function stops once it responds, so the (fast) save happens first.
// Foodics does not sign requests; the secret in the path blocks fake posts.
app.post('/webhooks/foodics/:secret', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const ok = req.params.secret.length === WEBHOOK_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(req.params.secret), Buffer.from(WEBHOOK_SECRET));
  if (!ok) return res.sendStatus(404);

  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { unparsed: raw }; }

    const summary = summarize(payload);
    const prev = summary.orderId ? await store.getLastSeen(summary.orderId) : null;
    if (prev) {
      summary.previousStatusLabel = prev.statusLabel;
      summary.previousDeliveryStatusLabel = prev.deliveryStatusLabel;
    }

    await store.addEvent({
      receivedAt: new Date().toISOString(),
      headers: { 'user-agent': req.get('user-agent'), 'content-type': req.get('content-type') },
      summary,
      payload,
    });
    if (summary.orderId) await store.setLastSeen(summary.orderId, summary);

    const change = prev && prev.statusLabel !== summary.statusLabel ? ` (${prev.statusLabel} -> ${summary.statusLabel})` : '';
    console.log(
      `[webhook] ${summary.event} order=${summary.reference || summary.orderId || '-'} ` +
      `status=${summary.statusLabel || summary.status || '-'}${change} ` +
      `delivery=${summary.deliveryStatusLabel || '-'}${summary.isReady ? '  <-- READY' : ''}`
    );
  } catch (err) {
    console.error('[webhook] failed to store event:', err.message);
  }
  res.sendStatus(200);
});

module.exports = { app, missing, storeKind: store.kind, FOODICS_ENV, WEBHOOK_SECRET };
