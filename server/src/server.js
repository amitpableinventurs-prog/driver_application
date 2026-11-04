import http from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { closeRealtime, initRealtime } from './services/realtime.js';
import { startScheduler } from './services/bookings.js';

await connectDb();
const server = http.createServer(createApp());
initRealtime(server);
startScheduler();

server.listen(env.port, () => {
  console.log(`Driver IN API on http://localhost:${env.port}  (docs: /api/docs, env: ${env.nodeEnv})`);
});

async function shutdown() {
  await closeRealtime();
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
