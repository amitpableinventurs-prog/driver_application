import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { badRequest, ApiError } from '../core/errors.js';
import { Otp } from '../models/index.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (phone, role, code) => crypto
  .createHmac('sha256', env.jwtAccessSecret)
  .update(`${phone}:${role}:${code}`)
  .digest('hex');

async function deliver(phone, code) {
  const { MSG91_AUTH_KEY: authKey, MSG91_TEMPLATE_ID: templateId } = process.env;
  if (authKey && templateId) {
    const url = `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=91${phone}&otp=${code}`;
    const response = await fetch(url, { method: 'POST', headers: { authkey: authKey } });
    if (!response.ok) throw new ApiError(502, 'SMS_FAILED', 'Could not send OTP, please try again');
    return;
  }
  if (env.isProd) throw new ApiError(503, 'SMS_NOT_CONFIGURED', 'SMS provider is not configured');
  if (!env.isTest) console.log(`[otp] ${phone}: ${code}`);
}

export async function sendOtp(phone, role) {
  const existing = await Otp.findOne({ phone, role });
  if (existing && Date.now() - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new ApiError(429, 'OTP_COOLDOWN', 'Please wait 30 seconds before requesting another OTP');
  }
  const code = String(crypto.randomInt(100000, 1000000));
  await Otp.findOneAndUpdate(
    { phone, role },
    { codeHash: hashCode(phone, role, code), attempts: 0, lastSentAt: new Date(), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    { upsert: true },
  );
  await deliver(phone, code);
  return env.otpDevMode ? code : undefined;
}

export async function verifyOtp(phone, role, code) {
  // The attempt is counted before the comparison so parallel guesses cannot exceed the limit.
  const record = await Otp.findOneAndUpdate(
    { phone, role, attempts: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: new Date() } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!record) throw badRequest('OTP expired or too many attempts. Please request a new OTP.', 'OTP_EXPIRED');
  const expected = Buffer.from(record.codeHash, 'hex');
  const actual = Buffer.from(hashCode(phone, role, code), 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) throw badRequest('Incorrect OTP', 'OTP_INVALID');
  await Otp.deleteOne({ _id: record._id });
}
