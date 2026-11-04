import { z } from 'zod';
import { createApi, escapeRegex, ok, paginate } from '../core/api.js';
import { revokeAllSessions } from '../core/auth.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { searchQuery } from '../core/schemas.js';
import { privatePathFor } from '../core/upload.js';
import { ACTIVE_STATUSES, Booking, Car, Customer, Driver, REQUIRED_DOCUMENTS, Transaction } from '../models/index.js';
import { notify } from '../services/notify.js';
import { credit, debit } from '../services/wallet.js';
import { audit } from './admin-helpers.js';

const api = createApi({ prefix: '/admin', tag: 'Admin', auth: 'admin' });
const CUSTOMERS = 'Admin: Customers';
const DRIVERS = 'Admin: Drivers';

const nameOrPhone = (search) => {
  if (!search) return {};
  const pattern = new RegExp(escapeRegex(search), 'i');
  return { $or: [{ name: pattern }, { phone: pattern }] };
};

const walletBody = z.object({
  direction: z.enum(['credit', 'debit']),
  amount: z.number().int().min(1).max(100000),
  note: z.string().trim().min(3).max(200),
});

async function adjustWallet(req, role) {
  const { direction, amount, note } = req.body;
  const entry = {
    role,
    ownerId: req.params.id,
    amount,
    category: 'admin_adjustment',
    key: `admin:${req.user._id}:${Date.now()}:${req.params.id}`,
    note,
    allowNegative: role === 'driver',
  };
  await (direction === 'credit' ? credit(entry) : debit(entry));
  await audit(req, `wallet_${direction}`, role, req.params.id, { amount, note });
}

/* ------------------------------ customers ------------------------------ */

api.get('/customers', {
  summary: 'List customers',
  tag: CUSTOMERS,
  perm: 'customers',
  query: searchQuery.extend({ status: z.enum(['active', 'blocked', 'deleted']).optional() }),
}, async (req, res) => {
  const filter = nameOrPhone(req.q.search);
  if (req.q.status) filter.status = req.q.status;
  ok(res, await paginate(Customer.find(filter).select('-deviceTokens').sort({ createdAt: -1 }), req.q));
});

api.get('/customers/:id', { summary: 'Customer detail with cars and recent bookings', tag: CUSTOMERS, perm: 'customers' }, async (req, res) => {
  const customer = await Customer.findById(req.params.id).select('-deviceTokens');
  if (!customer) throw notFound('Customer not found');
  const [cars, bookings, transactions] = await Promise.all([
    Car.find({ customer: customer._id, deletedAt: null }),
    Booking.find({ customer: customer._id }).sort({ createdAt: -1 }).limit(20).select('-startOtp').populate('driver', 'name phone'),
    Transaction.find({ ownerRole: 'customer', owner: customer._id }).sort({ createdAt: -1 }).limit(20),
  ]);
  ok(res, { customer, cars, bookings, transactions });
});

api.patch('/customers/:id/status', {
  summary: 'Block or unblock a customer',
  tag: CUSTOMERS,
  perm: 'customers',
  body: z.object({ status: z.enum(['active', 'blocked']), reason: z.string().trim().max(200).optional() }),
}, async (req, res) => {
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, status: { $ne: 'deleted' } }, { status: req.body.status }, { returnDocument: 'after' });
  if (!customer) throw notFound('Customer not found');
  if (req.body.status === 'blocked') await revokeAllSessions('customer', customer._id);
  await audit(req, 'set_status', 'customer', customer._id, req.body);
  ok(res, { status: customer.status });
});

api.post('/customers/:id/wallet', { summary: 'Credit or debit a customer wallet', tag: CUSTOMERS, perm: 'finance', body: walletBody }, async (req, res) => {
  if (!(await Customer.exists({ _id: req.params.id }))) throw notFound('Customer not found');
  await adjustWallet(req, 'customer');
  ok(res, { walletBalance: (await Customer.findById(req.params.id)).walletBalance });
});

/* ------------------------------ drivers ------------------------------ */

api.get('/drivers/live', { summary: 'Online drivers with location for the live map', tag: DRIVERS, perm: 'drivers' }, async (_req, res) => {
  const drivers = await Driver.find({ isOnline: true, location: { $exists: true } })
    .select('name phone location heading locationUpdatedAt activeBooking rating').limit(1000);
  ok(res, drivers);
});

api.get('/drivers', {
  summary: 'List drivers',
  tag: DRIVERS,
  perm: 'drivers',
  query: searchQuery.extend({
    status: z.enum(['active', 'suspended', 'deleted']).optional(),
    kycStatus: z.enum(['not_submitted', 'submitted', 'approved', 'rejected']).optional(),
    online: z.enum(['true', 'false']).optional(),
  }),
}, async (req, res) => {
  const filter = nameOrPhone(req.q.search);
  if (req.q.status) filter.status = req.q.status;
  if (req.q.kycStatus) filter.kycStatus = req.q.kycStatus;
  if (req.q.online) filter.isOnline = req.q.online === 'true';
  ok(res, await paginate(Driver.find(filter).select('-deviceTokens -documents -bank').populate('city', 'name').sort({ createdAt: -1 }), req.q));
});

api.get('/drivers/:id', { summary: 'Driver detail with documents and recent trips', tag: DRIVERS, perm: 'drivers' }, async (req, res) => {
  const driver = await Driver.findById(req.params.id).select('-deviceTokens').populate('city', 'name');
  if (!driver) throw notFound('Driver not found');
  const [bookings, transactions] = await Promise.all([
    Booking.find({ driver: driver._id }).sort({ createdAt: -1 }).limit(20).select('-startOtp').populate('customer', 'name phone'),
    Transaction.find({ ownerRole: 'driver', owner: driver._id }).sort({ createdAt: -1 }).limit(20),
  ]);
  ok(res, { driver, bookings, transactions, requiredDocuments: REQUIRED_DOCUMENTS });
});

api.patch('/drivers/:id/status', {
  summary: 'Suspend or reactivate a driver',
  tag: DRIVERS,
  perm: 'drivers',
  body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(200).optional() }),
}, async (req, res) => {
  const driver = await Driver.findOne({ _id: req.params.id, status: { $ne: 'deleted' } });
  if (!driver) throw notFound('Driver not found');
  if (req.body.status === 'suspended') {
    const active = await Booking.exists({ driver: driver._id, status: { $in: ['arrived', 'in_progress'] } });
    if (active) throw conflict('This driver is on a trip right now', 'DRIVER_ON_TRIP');
    driver.isOnline = false;
    await revokeAllSessions('driver', driver._id);
  }
  driver.status = req.body.status;
  await driver.save();
  await audit(req, 'set_status', 'driver', driver._id, req.body);
  ok(res, { status: driver.status });
});

api.get('/drivers/:id/documents/:documentId/file', { summary: 'Download a KYC document', tag: DRIVERS, perm: 'drivers' }, async (req, res) => {
  const driver = await Driver.findById(req.params.id).select('documents');
  const document = driver?.documents.id(req.params.documentId);
  if (!document) throw notFound('Document not found');
  await audit(req, 'view_document', 'driver', driver._id, { type: document.type });
  res.type(document.mimeType).sendFile(privatePathFor(document.fileName));
});

api.patch('/drivers/:id/documents/:documentId', {
  summary: 'Approve or reject one KYC document',
  tag: DRIVERS,
  perm: 'drivers',
  body: z.object({ status: z.enum(['approved', 'rejected']), rejectionReason: z.string().trim().max(200).optional() }),
}, async (req, res) => {
  if (req.body.status === 'rejected' && !req.body.rejectionReason) throw badRequest('Give a reason for rejecting the document');
  const driver = await Driver.findById(req.params.id);
  const document = driver?.documents.id(req.params.documentId);
  if (!document) throw notFound('Document not found');
  document.status = req.body.status;
  document.rejectionReason = req.body.status === 'rejected' ? req.body.rejectionReason : undefined;
  document.reviewedAt = new Date();
  await driver.save();
  await audit(req, `document_${req.body.status}`, 'driver', driver._id, { type: document.type });
  ok(res, { _id: document._id, type: document.type, status: document.status, rejectionReason: document.rejectionReason });
});

api.post('/drivers/:id/kyc', {
  summary: 'Final KYC decision',
  tag: DRIVERS,
  perm: 'drivers',
  body: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().max(300).optional() }),
}, async (req, res) => {
  const { decision, reason } = req.body;
  const driver = await Driver.findById(req.params.id);
  if (!driver) throw notFound('Driver not found');
  if (decision === 'approved') {
    const approved = driver.documents.filter((document) => document.status === 'approved').map((document) => document.type);
    const missing = REQUIRED_DOCUMENTS.filter((type) => !approved.includes(type));
    if (missing.length) throw badRequest(`Approve these documents first: ${missing.join(', ')}`, 'DOCUMENTS_NOT_APPROVED', { missing });
  } else if (!reason) {
    throw badRequest('Give a reason for rejecting the KYC');
  }
  driver.kycStatus = decision;
  driver.kycRejectionReason = decision === 'rejected' ? reason : undefined;
  if (decision === 'rejected') driver.isOnline = false;
  await driver.save();
  await audit(req, `kyc_${decision}`, 'driver', driver._id, { reason });
  await notify('driver', driver._id, {
    title: decision === 'approved' ? 'KYC approved' : 'KYC rejected',
    body: decision === 'approved' ? 'You can now go online and accept bookings.' : `Reason: ${reason}`,
    type: 'kyc',
  });
  ok(res, { kycStatus: driver.kycStatus });
});

api.post('/drivers/:id/wallet', { summary: 'Credit or debit a driver wallet', tag: DRIVERS, perm: 'finance', body: walletBody }, async (req, res) => {
  if (!(await Driver.exists({ _id: req.params.id }))) throw notFound('Driver not found');
  await adjustWallet(req, 'driver');
  ok(res, { walletBalance: (await Driver.findById(req.params.id)).walletBalance });
});

export default api;
