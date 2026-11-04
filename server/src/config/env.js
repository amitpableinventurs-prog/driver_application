import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

function required(name, fallbackForDev) {
  const value = process.env[name];
  if (value) return value;
  if (!isProd && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required environment variable: ${name}`);
}

const list = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);

export const env = {
  nodeEnv,
  isProd,
  isTest: nodeEnv === 'test',
  port: Number(process.env.PORT || 5100),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/driver_go'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET', 'dev-only-access-secret-change-me-please'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '30m',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 60),
  corsOrigins: list(process.env.CORS_ORIGINS || 'http://localhost:5175,http://localhost:5176'),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 5100}`,
  // Dev convenience only: echoes the OTP in the API response. Never honoured in production.
  otpDevMode: !isProd && process.env.OTP_DEV_MODE !== 'false',
  enableApiDocs: !isProd || process.env.ENABLE_API_DOCS === 'true',
  paymentGateway: process.env.PAYMENT_GATEWAY || (isProd ? 'razorpay' : 'mock'),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  trustProxy: Number(process.env.TRUST_PROXY || 0),
};

if (isProd && env.paymentGateway === 'mock') {
  throw new Error('PAYMENT_GATEWAY=mock credits money without a real payment and is not allowed in production');
}
