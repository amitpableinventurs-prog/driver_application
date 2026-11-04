import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { notFound, errorHandler } from './core/errors.js';
import { buildOpenApi } from './core/openapi.js';
import { PUBLIC_DIR } from './core/upload.js';
import { API_BASE, apis } from './routes/index.js';
import { handleRazorpayWebhook } from './services/payments.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  if (env.enableApiDocs) {
    const spec = buildOpenApi(`${env.publicUrl}${API_BASE}`);
    app.get('/api/openapi.json', (_req, res) => res.json(spec));
    // Mounted ahead of helmet because Swagger UI relies on inline scripts.
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Driver IN API' }));
  }

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  if (!env.isTest) app.use(morgan(env.isProd ? 'combined' : 'dev'));

  // The webhook signature covers the exact bytes, so this must run before the JSON parser.
  app.post(`${API_BASE}/webhooks/razorpay`, express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    await handleRazorpayWebhook(req.body, req.headers['x-razorpay-signature']);
    res.json({ received: true });
  });

  app.use(express.json({ limit: '1mb' }));
  app.use('/uploads/public', express.static(PUBLIC_DIR, { maxAge: '7d', index: false }));

  app.get('/health', (_req, res) => {
    const database = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.status(database === 'up' ? 200 : 503).json({ status: database === 'up' ? 'ok' : 'degraded', database });
  });

  if (!env.isTest) {
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' } },
    });
    for (const path of ['/auth/otp', '/auth/admin']) app.use(`${API_BASE}${path}`, limiter);
    app.use(API_BASE, rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));
  }

  for (const api of apis) app.use(`${API_BASE}${api.prefix}`, api.router);

  app.use((req) => { throw notFound(`No route for ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND'); });
  app.use(errorHandler);
  return app;
}
