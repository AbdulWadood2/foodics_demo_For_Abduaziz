// Storage: Upstash Redis when its env vars are set (Vercel), local files otherwise.
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 500;

function redisStore(url, token) {
  const { Redis } = require('@upstash/redis');
  const redis = new Redis({ url, token });
  return {
    kind: 'redis',
    async getConnection() { return (await redis.get('foodics:connection')) || null; },
    async setConnection(c) { await redis.set('foodics:connection', c); },
    async getLastSeen(orderId) { return (await redis.hget('foodics:lastSeen', orderId)) || null; },
    async setLastSeen(orderId, s) { await redis.hset('foodics:lastSeen', { [orderId]: s }); },
    async addEvent(record) {
      await redis.lpush('foodics:events', record);
      await redis.ltrim('foodics:events', 0, MAX_EVENTS - 1);
    },
    async listEvents() { return (await redis.lrange('foodics:events', 0, MAX_EVENTS - 1)) || []; },
  };
}

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const connFile = path.join(dir, 'connection.json');
  const eventsFile = path.join(dir, 'events.jsonl');
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const readEvents = () => {
    try { return fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  return {
    kind: 'file',
    async getConnection() { return readJson(connFile); },
    async setConnection(c) { fs.writeFileSync(connFile, JSON.stringify(c, null, 2)); },
    async getLastSeen(orderId) {
      const hit = readEvents().reverse().find((e) => e.summary.orderId === orderId);
      return hit ? hit.summary : null;
    },
    async setLastSeen() { /* derived from the events file */ },
    async addEvent(record) { fs.appendFileSync(eventsFile, JSON.stringify(record) + '\n'); },
    async listEvents() { return readEvents().reverse().slice(0, MAX_EVENTS); },
  };
}

function createStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return redisStore(url, token);
  if (process.env.VERCEL) {
    throw new Error('On Vercel you must connect Upstash Redis (UPSTASH_REDIS_REST_URL / _TOKEN missing).');
  }
  return fileStore(path.join(__dirname, '..', 'data'));
}

module.exports = { createStore };
