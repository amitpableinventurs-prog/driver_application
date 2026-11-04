import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createApi, ok } from '../core/api.js';
import { adminPermissions, issueTokens, revokeRefreshToken, rotateRefreshToken } from '../core/auth.js';
import { forbidden, unauthorized } from '../core/errors.js';
import { email, phone } from '../core/schemas.js';
import { Admin, Customer, Driver } from '../models/index.js';
import { sendOtp, verifyOtp } from '../services/otp.js';
import { accountView } from './shared.js';

const api = createApi({ prefix: '/auth', tag: 'Auth' });
const role = z.enum(['customer', 'driver']);

const newReferralCode = () => `DG${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

async function findOrCreate(accountRole, input) {
  const Model = accountRole === 'customer' ? Customer : Driver;
  const existing = await Model.findOne({ phone: input.phone });
  if (existing) return { account: existing, isNewUser: false };

  const data = { phone: input.phone, name: input.name || '' };
  if (accountRole === 'customer') {
    data.referralCode = newReferralCode();
    if (input.referralCode) {
      const referrer = await Customer.findOne({ referralCode: input.referralCode.toUpperCase(), status: 'active' });
      if (referrer) data.referredBy = referrer._id;
    }
  }
  return { account: await Model.create(data), isNewUser: true };
}

api.post('/otp/send', {
  summary: 'Send a login OTP to a customer or driver',
  description: 'Creates no account. In development the OTP is echoed back as devOtp; in production it is only sent by SMS.',
  body: z.object({ phone, role }),
}, async (req, res) => {
  const devOtp = await sendOtp(req.body.phone, req.body.role);
  ok(res, { sent: true, expiresInSeconds: 300, devOtp }, 'OTP sent');
});

api.post('/otp/verify', {
  summary: 'Verify the OTP and log in (creates the account on first login)',
  body: z.object({
    phone,
    role,
    otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
    name: z.string().trim().max(80).optional(),
    referralCode: z.string().trim().max(20).optional(),
    deviceToken: z.string().max(500).optional(),
  }),
}, async (req, res) => {
  const { phone: mobile, role: accountRole, otp, deviceToken } = req.body;
  await verifyOtp(mobile, accountRole, otp);
  const { account, isNewUser } = await findOrCreate(accountRole, req.body);
  if (account.status !== 'active') throw forbidden('This account is not active. Please contact support.', 'ACCOUNT_INACTIVE');
  if (deviceToken) await account.updateOne({ $addToSet: { deviceTokens: deviceToken } });
  const tokens = await issueTokens(accountRole, account._id);
  ok(res, { ...tokens, isNewUser, user: accountView(account) }, 'Logged in');
});

api.post('/admin/login', {
  summary: 'Admin login with email and password',
  body: z.object({ email, password: z.string().min(1).max(200) }),
}, async (req, res) => {
  const admin = await Admin.findOne({ email: req.body.email }).select('+passwordHash');
  const valid = admin && await bcrypt.compare(req.body.password, admin.passwordHash);
  if (!valid) throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  if (admin.status !== 'active') throw forbidden('This admin account is disabled', 'ACCOUNT_INACTIVE');
  await Admin.updateOne({ _id: admin._id }, { lastLoginAt: new Date() });
  const tokens = await issueTokens('admin', admin._id);
  ok(res, {
    ...tokens,
    user: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role, permissions: adminPermissions(admin) },
  }, 'Logged in');
});

api.post('/refresh', {
  summary: 'Exchange a refresh token for a new token pair',
  description: 'Refresh tokens rotate: always store the new one. Reusing an old token ends the session.',
  body: z.object({ refreshToken: z.string().min(20) }),
}, async (req, res) => {
  ok(res, await rotateRefreshToken(req.body.refreshToken));
});

api.post('/logout', {
  summary: 'Revoke a refresh token',
  body: z.object({ refreshToken: z.string().min(20) }),
}, async (req, res) => {
  await revokeRefreshToken(req.body.refreshToken);
  ok(res, { loggedOut: true });
});

export default api;
