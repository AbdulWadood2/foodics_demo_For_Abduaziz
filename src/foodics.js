// Foodics endpoints and lookup tables.
// Sources: developers.foodics.com/guides/get-started,
//          developers.foodics.com/guides/partnership_authentication_process,
//          developers.foodics.com/guides/online_ordering_integrations,
//          apidocs.foodics.com/core/webhooks.html

const ENVIRONMENTS = {
  sandbox: {
    authorizeUrl: 'https://console-sandbox.foodics.com/authorize',
    tokenUrl: 'https://api-sandbox.foodics.com/oauth/token',
    apiBase: 'https://api-sandbox.foodics.com/v5',
  },
  production: {
    authorizeUrl: 'https://console.foodics.com/authorize',
    tokenUrl: 'https://api.foodics.com/oauth/token',
    apiBase: 'https://api.foodics.com/v5',
  },
};

// order.status
const ORDER_STATUS = {
  1: 'Pending',
  2: 'Active',
  3: 'Declined',
  4: 'Closed',
  5: 'Returned',
  6: 'Joined',
  7: 'Void',
  8: 'Draft',
};

// order.delivery_status. 2 = Ready: set when the kitchen bumps the order.
const DELIVERY_STATUS = {
  1: 'Sent to kitchen',
  2: 'Ready',
  3: 'Assigned',
  4: 'En route',
  5: 'Delivered',
  6: 'Cancelled',
};

function getEnv(name) {
  const env = ENVIRONMENTS[name];
  if (!env) throw new Error(`Unknown FOODICS_ENV "${name}" (use sandbox or production)`);
  return env;
}

async function exchangeCode(env, { code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(env.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function apiGet(env, accessToken, path) {
  const res = await fetch(`${env.apiBase}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

// Pull the fields worth showing out of a webhook payload.
function summarize(payload) {
  const order = payload && payload.order ? payload.order : {};
  const status = order.status;
  const deliveryStatus = order.delivery_status;
  return {
    event: payload && payload.event ? payload.event : '(no event field)',
    business: payload && payload.business ? payload.business.name : undefined,
    orderId: order.id,
    reference: order.reference,
    status,
    statusLabel: ORDER_STATUS[status],
    deliveryStatus,
    deliveryStatusLabel: DELIVERY_STATUS[deliveryStatus],
    isReady: deliveryStatus === 2,
  };
}

module.exports = { getEnv, exchangeCode, apiGet, summarize, ORDER_STATUS, DELIVERY_STATUS };
