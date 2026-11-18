// Local entry point. On Vercel the same app is served as a function
// (Vercel may load this file, src/app.js or api/index.js), so never exit or listen there.
const app = require('./app');

module.exports = app;

if (!process.env.VERCEL) {
  if (app.missing.length) {
    console.error(`Missing ${app.missing.join(', ')} in .env (copy .env.example to .env and fill it in)`);
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Foodics demo on http://localhost:${PORT}  (env: ${app.foodicsEnv}, storage: ${app.storeKind})`);
    console.log(`Webhook path: /webhooks/foodics/${process.env.WEBHOOK_SECRET.slice(0, 4)}...`);
  });
}
