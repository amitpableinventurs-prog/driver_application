import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { z } from 'zod';
import { createApi, created, ok, paginate } from '../core/api.js';
import { revokeAllSessions } from '../core/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { date, email, lat, lng, money, objectId, pageQuery } from '../core/schemas.js';
import { privateDocument, privatePathFor } from '../core/upload.js';
import { ACTIVE_STATUSES, Booking, DOCUMENT_TYPES, Payout, REQUIRED_DOCUMENTS, Transaction } from '../models/index.js';
import {
  acceptBooking, availableForDriver, cancelByDriver, collectCash, driverView, endTrip, markArrived, rejectBooking, startTrip, submitReview,
} from '../services/bookings.js';
import { createPaymentOrder, verifyPayment } from '../services/payments.js';
import { emitTo, rooms, updateDriverLocation } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { debit } from '../services/wallet.js';
import { accountView, mountAccountBasics, mountNotifications, mountSos, mountSupport } from './shared.js';

const api = createApi({ prefix: '/driver', tag: 'Driver', auth: 'driver' });
const CUSTOMER_FIELDS = 'name phone avatar rating';

/* ------------------------------ profile ------------------------------ */

api.get('/me', { summary: 'My profile, KYC and wallet summary', tag: 'Driver: Profile' }, (req, res) => ok(res, accountView(req.user)));

api.patch('/me', {
  summary: 'Update profile and driving preferences',
  tag: 'Driver: Profile',
  body: z.object({
    name: z.string().trim().min(2).max(80),
    email,
    dateOfBirth: date,
    gender: z.enum(['male', 'female', 'other']),
    address: z.string().trim().max(300),
    city: objectId,
    languages: z.array(z.string().trim().max(30)).max(10),
    experienceYears: z.number().int().min(0).max(60),
    transmissions: z.array(z.enum(['manual', 'automatic'])).min(1),
    carCategories: z.array(z.enum(['hatchback', 'sedan', 'suv', 'luxury'])).min(1),
  }).partial(),
}, async (req, res) => {
  Object.assign(req.user, req.body);
  await req.user.save();
  ok(res, accountView(req.user));
});

api.patch('/me/bank', {
  summary: 'Update payout bank details',
  tag: 'Driver: Profile',
  body: z.object({
    accountHolder: z.string().trim().min(2).max(80),
    accountNumber: z.string().regex(/^\d{9,18}$/, 'Enter a valid account number'),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC'),
    upiId: z.string().trim().max(60).optional(),
  }),
}, async (req, res) => {
  req.user.bank = req.body;
  await req.user.save();
  ok(res, req.user.bank);
});

api.delete('/me', { summary: 'Delete my account (anonymises personal data)', tag: 'Driver: Profile' }, async (req, res) => {
  const active = await Booking.exists({ driver: req.user._id, status: { $in: ACTIVE_STATUSES } });
  if (active) throw conflict('Finish your active bookings first', 'ACTIVE_BOOKINGS');
  await req.user.updateOne({
    $set: { name: 'Deleted driver', phone: `deleted_${req.user._id}`, status: 'deleted', isOnline: false, deviceTokens: [] },
    $unset: { email: 1, avatar: 1, bank: 1, address: 1 },
  });
  await revokeAllSessions('driver', req.user._id);
  ok(res, { deleted: true });
});

mountAccountBasics(api);

/* ------------------------------ KYC ------------------------------ */

api.get('/documents', { summary: 'My KYC documents', tag: 'Driver: KYC' }, (req, res) => {
  const { documents, kycStatus, kycRejectionReason } = accountView(req.user);
  ok(res, { kycStatus, kycRejectionReason, requiredDocuments: REQUIRED_DOCUMENTS, documents });
});

api.post('/documents', {
  summary: 'Upload or replace a KYC document',
  tag: 'Driver: KYC',
  upload: privateDocument,
  fileField: 'file',
  body: z.object({
    type: z.enum(DOCUMENT_TYPES),
    number: z.string().trim().max(40).optional(),
    expiryDate: date.optional(),
  }),
}, async (req, res) => {
  if (!req.file) throw badRequest('Attach the document in the file field');
  const previous = req.user.documents.find((document) => document.type === req.body.type);
  if (previous) {
    await fs.rm(privatePathFor(previous.fileName), { force: true });
    req.user.documents.pull(previous._id);
  }
  req.user.documents.push({ ...req.body, fileName: req.file.filename, mimeType: req.file.mimetype });
  await req.user.save();
  created(res, accountView(req.user).documents);
});

api.post('/kyc/submit', { summary: 'Submit KYC for review', tag: 'Driver: KYC' }, async (req, res) => {
  if (req.user.kycStatus === 'approved') throw conflict('Your KYC is already approved', 'KYC_APPROVED');
  const uploaded = req.user.documents.map((document) => document.type);
  const missing = REQUIRED_DOCUMENTS.filter((type) => !uploaded.includes(type));
  if (missing.length) throw badRequest(`Missing documents: ${missing.join(', ')}`, 'DOCUMENTS_MISSING', { missing });
  if (!req.user.name || !req.user.city) throw badRequest('Complete your name and city first', 'PROFILE_INCOMPLETE');
  req.user.kycStatus = 'submitted';
  req.user.kycRejectionReason = undefined;
  await req.user.save();
  emitTo(rooms.admins, 'kyc:submitted', { driverId: String(req.user._id), name: req.user.name });
  ok(res, { kycStatus: req.user.kycStatus });
});

/* ------------------------------ availability ------------------------------ */

api.post('/status', {
  summary: 'Go online or offline',
  tag: 'Driver: Availability',
  body: z.object({ online: z.boolean(), lat: lat.optional(), lng: lng.optional() }),
}, async (req, res) => {
  const { online, lat: latitude, lng: longitude } = req.body;
  if (online) {
    if (req.user.kycStatus !== 'approved') throw forbidden('Your KYC must be approved to go online', 'KYC_NOT_APPROVED');
    const settings = await getSettings();
    if (req.user.walletBalance < settings.driverMinWalletBalance) throw forbidden('Clear your wallet dues to go online', 'DRIVER_DUES_PENDING');
    if (latitude === undefined || longitude === undefined) throw badRequest('lat and lng are required to go online');
    await updateDriverLocation(req.user, { lat: latitude, lng: longitude });
  }
  await req.user.updateOne({ isOnline: online });
  ok(res, { isOnline: online });
});

api.post('/location', {
  summary: 'Update live location (REST fallback for the socket event)',
  tag: 'Driver: Availability',
  body: z.object({ lat, lng, heading: z.number().min(0).max(360).optional() }),
}, async (req, res) => {
  await updateDriverLocation(req.user, req.body);
  ok(res, { updated: true });
});

/* ------------------------------ bookings ------------------------------ */

api.get('/bookings/available', { summary: 'Open bookings near me', tag: 'Driver: Bookings' }, async (req, res) => {
  ok(res, await availableForDriver(req.user));
});

api.get('/bookings/active', { summary: 'My current and upcoming bookings', tag: 'Driver: Bookings' }, async (req, res) => {
  const bookings = await Booking.find({ driver: req.user._id, status: { $in: ACTIVE_STATUSES } })
    .sort({ scheduledAt: 1 }).populate('customer', CUSTOMER_FIELDS);
  ok(res, bookings.map((booking) => driverView(booking)));
});

api.get('/bookings', {
  summary: 'My booking history',
  tag: 'Driver: Bookings',
  query: pageQuery.extend({ status: z.enum(['completed', 'cancelled']).optional() }),
}, async (req, res) => {
  const filter = { driver: req.user._id };
  if (req.q.status) filter.status = req.q.status;
  const result = await paginate(Booking.find(filter).sort({ createdAt: -1 }).populate('customer', CUSTOMER_FIELDS), req.q);
  ok(res, { ...result, items: result.items.map((booking) => driverView(booking)) });
});

api.get('/bookings/:id', { summary: 'Booking detail', tag: 'Driver: Bookings' }, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, driver: req.user._id }).populate('customer', CUSTOMER_FIELDS);
  if (!booking) throw notFound('Booking not found');
  ok(res, driverView(booking));
});

const populated = (booking) => booking.populate('customer', CUSTOMER_FIELDS);

api.post('/bookings/:id/accept', { summary: 'Accept an offer (first driver wins)', tag: 'Driver: Bookings' }, async (req, res) => {
  ok(res, driverView(await populated(await acceptBooking(req.user._id, req.params.id))), 'Booking accepted');
});

api.post('/bookings/:id/reject', { summary: 'Pass on an offer', tag: 'Driver: Bookings' }, async (req, res) => {
  await rejectBooking(req.user, req.params.id);
  ok(res, { rejected: true });
});

api.post('/bookings/:id/arrived', { summary: 'Mark arrived at pickup', tag: 'Driver: Bookings' }, async (req, res) => {
  ok(res, driverView(await populated(await markArrived(req.user, req.params.id))));
});

api.post('/bookings/:id/start', {
  summary: 'Start the trip with the customer OTP',
  tag: 'Driver: Bookings',
  body: z.object({ otp: z.string().regex(/^\d{4}$/, 'OTP must be 4 digits') }),
}, async (req, res) => {
  ok(res, driverView(await populated(await startTrip(req.user, req.params.id, req.body.otp))), 'Trip started');
});

api.post('/bookings/:id/end', {
  summary: 'End the trip; returns the final fare and amount to collect',
  tag: 'Driver: Bookings',
  body: z.object({ extraCharges: money.max(5000).default(0), lat: lat.optional(), lng: lng.optional() }),
}, async (req, res) => {
  const booking = await populated(await endTrip(req.user, req.params.id, req.body));
  const collect = booking.paymentMethod === 'cash' ? booking.fareFinal.total : 0;
  ok(res, { ...driverView(booking), amountToCollect: collect }, 'Trip completed');
});

api.post('/bookings/:id/collect-cash', { summary: 'Record cash taken for an unpaid online trip', tag: 'Driver: Bookings' }, async (req, res) => {
  ok(res, driverView(await collectCash(req.user, req.params.id)), 'Payment recorded');
});

api.post('/bookings/:id/cancel', {
  summary: 'Back out of an accepted booking (it returns to search)',
  tag: 'Driver: Bookings',
  body: z.object({ reason: z.string().trim().min(2).max(300) }),
}, async (req, res) => {
  await cancelByDriver(req.user, req.params.id, req.body.reason);
  ok(res, { cancelled: true });
});

api.post('/bookings/:id/rate', {
  summary: 'Rate the customer after a completed trip',
  tag: 'Driver: Bookings',
  body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }),
}, async (req, res) => {
  created(res, await submitReview('driver', req.user, req.params.id, req.body));
});

mountSos(api, 'driver');

/* ------------------------------ earnings & wallet ------------------------------ */

api.get('/earnings', {
  summary: 'Earnings summary and day-wise breakdown',
  tag: 'Driver: Earnings',
  query: z.object({ from: date.optional(), to: date.optional() }),
}, async (req, res) => {
  const { timezone } = await getSettings();
  const to = req.q.to || new Date();
  const from = req.q.from || new Date(to.getTime() - 30 * 86400000);
  const match = { driver: new mongoose.Types.ObjectId(String(req.user._id)), status: 'completed', endedAt: { $gte: from, $lte: to } };
  const days = await Booking.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$endedAt', timezone } },
        trips: { $sum: 1 },
        earnings: { $sum: '$driverEarning' },
        commission: { $sum: '$commission' },
      },
    },
    { $sort: { _id: -1 } },
  ]);
  const summary = days.reduce((acc, day) => ({
    trips: acc.trips + day.trips,
    earnings: acc.earnings + day.earnings,
    commission: acc.commission + day.commission,
  }), { trips: 0, earnings: 0, commission: 0 });
  ok(res, { from, to, summary, days: days.map(({ _id, ...day }) => ({ date: _id, ...day })) });
});

api.get('/wallet', { summary: 'Wallet balance and history', tag: 'Driver: Earnings', query: pageQuery }, async (req, res) => {
  const history = await paginate(Transaction.find({ ownerRole: 'driver', owner: req.user._id }).sort({ createdAt: -1 }), req.q);
  ok(res, { balance: req.user.walletBalance, ...history });
});

api.post('/wallet/pay-dues', {
  summary: 'Pay platform dues online',
  tag: 'Driver: Earnings',
  body: z.object({ amount: z.number().int().min(10).max(50000) }),
}, async (req, res) => {
  ok(res, await createPaymentOrder({ ownerRole: 'driver', owner: req.user._id, purpose: 'driver_dues', amount: req.body.amount }));
});

api.post('/payments/verify', {
  summary: 'Confirm a dues payment after gateway checkout',
  tag: 'Driver: Earnings',
  body: z.object({ orderId: objectId, gatewayPaymentId: z.string().min(3).max(100), signature: z.string().max(200).optional() }),
}, async (req, res) => {
  const order = await verifyPayment({ ownerRole: 'driver', owner: req.user._id, ...req.body });
  ok(res, { status: order.status, amount: order.amount }, 'Payment confirmed');
});

api.get('/payouts', { summary: 'My payout requests', tag: 'Driver: Earnings', query: pageQuery }, async (req, res) => {
  ok(res, await paginate(Payout.find({ driver: req.user._id }).sort({ createdAt: -1 }), req.q));
});

api.post('/payouts', {
  summary: 'Request a payout; the amount is held from the wallet immediately',
  tag: 'Driver: Earnings',
  body: z.object({ amount: z.number().int().min(1).max(500000) }),
}, async (req, res) => {
  const settings = await getSettings();
  const { amount } = req.body;
  if (amount < settings.minPayoutAmount) throw badRequest(`Minimum payout is ₹${settings.minPayoutAmount}`, 'PAYOUT_TOO_LOW');
  if (!req.user.bank?.accountNumber) throw badRequest('Add your bank details first', 'BANK_MISSING');
  if (await Payout.exists({ driver: req.user._id, status: 'requested' })) throw conflict('You already have a pending payout', 'PAYOUT_PENDING');
  const payout = new Payout({ driver: req.user._id, amount, bankSnapshot: req.user.bank });
  await debit({ role: 'driver', ownerId: req.user._id, amount, category: 'payout', key: `payout:${payout._id}`, note: 'Payout requested' });
  await payout.save();
  emitTo(rooms.admins, 'payout:requested', { payoutId: String(payout._id), amount });
  created(res, payout, 'Payout requested');
});

mountNotifications(api, 'driver');
mountSupport(api, 'driver');

export default api;
