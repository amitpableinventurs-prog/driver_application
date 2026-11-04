import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized, forbidden } from './errors.js';
import { Customer, Driver, Admin, RefreshToken } from '../models/index.js';
import { ROLES } from './permissions.js';

const ACCOUNT_MODELS = { customer: Customer, driver: Driver, admin: Admin };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function signAccessToken(role, id) {
  return jwt.sign({ role }, env.jwtAccessSecret, { subject: String(id), expiresIn: env.accessTokenTtl, algorithm: 'HS256' });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'] });
}

export async function issueTokens(role, id, family = crypto.randomUUID()) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    tokenHash: sha256(refreshToken),
    role,
    subject: id,
    family,
    expiresAt: new Date(Date.now() + env.refreshTokenDays * 86400000),
  });
  return { accessToken: signAccessToken(role, id), refreshToken, tokenType: 'Bearer', expiresIn: env.accessTokenTtl };
}

async function loadAccount(role, id) {
  const account = await ACCOUNT_MODELS[role]?.findById(id);
  if (!account) throw unauthorized('Account not found');
  if (account.status !== 'active') throw forbidden('This account is not active. Please contact support.', 'ACCOUNT_INACTIVE');
  return account;
}

/** Rotates a refresh token. Replaying an already-used token revokes the whole family. */
export async function rotateRefreshToken(refreshToken) {
  const record = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
  if (!record || record.expiresAt < new Date()) throw unauthorized('Session expired, please log in again', 'INVALID_REFRESH_TOKEN');
  const claimed = await RefreshToken.findOneAndUpdate({ _id: record._id, revokedAt: null }, { revokedAt: new Date() });
  if (!claimed) {
    await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
    throw unauthorized('Session expired, please log in again', 'INVALID_REFRESH_TOKEN');
  }
  await loadAccount(record.role, record.subject);
  return issueTokens(record.role, record.subject, record.family);
}

export async function revokeRefreshToken(refreshToken) {
  await RefreshToken.updateOne({ tokenHash: sha256(refreshToken), revokedAt: null }, { revokedAt: new Date() });
}

export async function revokeAllSessions(role, id) {
  await RefreshToken.updateMany({ role, subject: id, revokedAt: null }, { revokedAt: new Date() });
}

export async function authenticate(token) {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw unauthorized('Access token is invalid or expired', 'INVALID_TOKEN');
  }
  const account = await loadAccount(payload.role, payload.sub);
  return { role: payload.role, account };
}

export function requireAuth(role) {
  return async (req, _res, next) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw unauthorized();
    const session = await authenticate(header.slice(7));
    if (session.role !== role) throw forbidden();
    req.user = session.account;
    req.role = session.role;
    next();
  };
}

export function adminPermissions(admin) {
  return ROLES[admin.role]?.permissions || [];
}

export function requirePermission(permission) {
  return (req, _res, next) => {
    if (!adminPermissions(req.user).includes(permission)) throw forbidden('Your role does not have this permission');
    next();
  };
}
