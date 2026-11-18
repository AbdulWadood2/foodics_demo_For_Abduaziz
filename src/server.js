// Local entry point. On Vercel, api/index.js serves the same app.
const { app, missing, storeKind, FOODICS_ENV, WEBHOOK_SECRET } = require('./app');

if (missing.length) {
  console.error(`Missing ${missing.join(', ')} in .env (copy .env.example to .env and fill it in)`);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Foodics demo on http://localhost:${PORT}  (env: ${FOODICS_ENV}, storage: ${storeKind})`);
  console.log(`Webhook path: /webhooks/foodics/${WEBHOOK_SECRET.slice(0, 4)}...`);
});
