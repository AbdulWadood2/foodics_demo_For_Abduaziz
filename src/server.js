// Local entry point. On Vercel the same app is served as a function
// (Vercel may load this file or api/index.js), so never exit or listen there.
const { app, missing, storeKind, FOODICS_ENV, WEBHOOK_SECRET } = require('./app');

module.exports = app;

if (!process.env.VERCEL) {
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')} in .env (copy .env.example to .env and fill it in)`);
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Foodics demo on http://localhost:${PORT}  (env: ${FOODICS_ENV}, storage: ${storeKind})`);
    console.log(`Webhook path: /webhooks/foodics/${WEBHOOK_SECRET.slice(0, 4)}...`);
  });
}
