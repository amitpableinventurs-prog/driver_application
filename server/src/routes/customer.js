import { z } from 'zod';
import { createApi, created, ok, paginate } from '../core/api.js';
import { revokeAllSessions } from '../core/auth.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { date, email, lat, lng, objectId, pageQuery, patchOf, place } from '../core/schemas.js';
import { ACTIVE_STATUSES, Address, Booking, BOOKING_TYPES, Car, Coupon, PAYMENT_METHODS, Transaction } from '../models/index.js';
import { cancelByCustomer, createBooking, customerView, quote, submitReview } from '../services/bookings.js';
import { createPaymentOrder, verifyPayment } from '../services/payments.js';
import { getSettings } from '../services/settings.js';
import { accountView, mountAccountBasics, mountNotifications, mountSos, mountSupport } from './shared.js';

const api = createApi({ prefix: '/customer', tag: 'Customer', auth: 'customer' });
const DRIVER_FIELDS = 'name phone avatar rating ratingCount experienceYears languages location totalTrips';

/* ------------------------------ profile ------------------------------ */

api.get('/me', { summary: 'My profile', tag: 'Customer: Profile' }, (req, res) => ok(res, accountView(req.user)));

api.patch('/me', {
  summary: 'Update profile',
  tag: 'Customer: Profile',
  body: z.object({ name: z.string().trim().min(2).max(80).optional(), email: email.optional() }),
}, async (req, res) => {
  Object.assign(req.user, req.body);
  await req.user.save();
  ok(res, accountView(req.user));
});

api.delete('/me', { summary: 'Delete my account (anonymises personal data)', tag: 'Customer: Profile' }, async (req, res) => {
  const active = await Booking.exists({ customer: req.user._id, status: { $in: ACTIVE_STATUSES } });
  if (active) throw conflict('Finish or cancel your active bookings first', 'ACTIVE_BOOKINGS');
  await req.user.updateOne({
    $set: { name: 'Deleted user', phone: `deleted_${req.user._id}`, status: 'deleted', deviceTokens: [] },
    $unset: { email: 1, avatar: 1 },
  });
  await revokeAllSessions('customer', req.user._id);
  ok(res, { deleted: true });
});

mountAccountBasics(api);

api.get('/referral', { summary: 'My referral code and rewards', tag: 'Customer: Profile' }, async (req, res) => {
  const settings = await getSettings();
  ok(res, {
    code: req.user.referralCode,
    youEarn: settings.referralRewardReferrer,
    friendEarns: settings.referralRewardReferee,
  });
});

/* ------------------------------ cars ------------------------------ */

const carBody = z.object({
  name: z.string().trim().min(2).max(80),
  registrationNumber: z.string().trim().min(4).max(15),
  transmission: z.enum(['manual', 'automatic']),
  category: z.enum(['hatchback', 'sedan', 'suv', 'luxury']),
  fuel: z.enum(['petrol', 'diesel', 'cng', 'ev']).default('petrol'),
  isDefault: z.boolean().optional(),
});

api.get('/cars', { summary: 'My cars', tag: 'Customer: Cars' }, async (req, res) => {
  ok(res, await Car.find({ customer: req.user._id, deletedAt: null }).sort({ isDefault: -1, createdAt: -1 }));
});

async function clearDefaultIfNeeded(customerId, isDefault) {
  if (isDefault) await Car.updateMany({ customer: customerId }, { isDefault: false });
}

api.post('/cars', { summary: 'Add a car', tag: 'Customer: Cars', body: carBody }, async (req, res) => {
  await clearDefaultIfNeeded(req.user._id, req.body.isDefault);
  created(res, await Car.create({ ...req.body, customer: req.user._id }));
});

api.patch('/cars/:id', { summary: 'Update a car', tag: 'Customer: Cars', body: patchOf(carBody) }, async (req, res) => {
  await clearDefaultIfNeeded(req.user._id, req.body.isDefault);
  const car = await Car.findOneAndUpdate({ _id: req.params.id, customer: req.user._id, deletedAt: null }, req.body, { returnDocument: 'after', runValidators: true });
  if (!car) throw notFound('Car not found');
  ok(res, car);
});

api.delete('/cars/:id', { summary: 'Remove a car', tag: 'Customer: Cars' }, async (req, res) => {
  const car = await Car.findOneAndUpdate({ _id: req.params.id, customer: req.user._id, deletedAt: null }, { deletedAt: new Date() });
  if (!car) throw notFound('Car not found');
  ok(res, { deleted: true });
});

/* ------------------------------ addresses ------------------------------ */

const addressBody = z.object({ label: z.string().trim().min(1).max(40), address: z.string().trim().min(3).max(300), lat, lng });

api.get('/addresses', { summary: 'Saved addresses', tag: 'Customer: Addresses' }, async (req, res) => {
  ok(res, await Address.find({ customer: req.user._id }).sort({ createdAt: -1 }));
});

api.post('/addresses', { summary: 'Save an address', tag: 'Customer: Addresses', body: addressBody }, async (req, res) => {
  created(res, await Address.create({ ...req.body, customer: req.user._id }));
});

api.patch('/addresses/:id', { summary: 'Update an address', tag: 'Customer: Addresses', body: patchOf(addressBody) }, async (req, res) => {
  const address = await Address.findOneAndUpdate({ _id: req.params.id, customer: req.user._id }, req.body, { returnDocument: 'after' });
  if (!address) throw notFound('Address not found');
  ok(res, address);
});

api.delete('/addresses/:id', { summary: 'Delete an address', tag: 'Customer: Addresses' }, async (req, res) => {
  const result = await Address.deleteOne({ _id: req.params.id, customer: req.user._id });
  if (!result.deletedCount) throw notFound('Address not found');
  ok(res, { deleted: true });
});

/* ------------------------------ estimate & coupons ------------------------------ */

const tripBody = z.object({
  type: z.enum(BOOKING_TYPES),
  cityId: objectId,
  pickup: place,
  drop: place.optional(),
  scheduledAt: date.optional(),
  hours: z.number().int().min(1).max(24).optional(),
  days: z.number().int().min(1).max(30).optional(),
  hoursPerDay: z.number().int().min(1).max(14).optional(),
  couponCode: z.string().trim().max(30).optional(),
});

api.post('/estimate', { summary: 'Fare estimate before booking', tag: 'Customer: Bookings', body: tripBody }, async (req, res) => {
  const { fare, km, minutes, coupon } = await quote(req.user._id, req.body);
  ok(res, { fare, estimatedKm: km, estimatedMinutes: minutes, couponApplied: coupon?.code || null });
});

api.get('/coupons', { summary: 'Coupons available right now', tag: 'Customer: Bookings' }, async (_req, res) => {
  const now = new Date();
  ok(res, await Coupon.find({ isActive: true, validFrom: { $lte: now }, validTo: { $gte: now } })
    .select('code description discountType value maxDiscount minFare validTo'));
});

/* ------------------------------ bookings ------------------------------ */

api.post('/bookings', {
  summary: 'Create a booking (instant when scheduledAt is omitted)',
  tag: 'Customer: Bookings',
  body: tripBody.extend({
    carId: objectId,
    paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
    notes: z.string().trim().max(500).optional(),
  }),
}, async (req, res) => {
  const booking = await createBooking(req.user, req.body);
  created(res, customerView(booking), 'Booking created');
});

api.get('/bookings', {
  summary: 'My bookings',
  tag: 'Customer: Bookings',
  query: pageQuery.extend({ scope: z.enum(['active', 'past', 'all']).default('all') }),
}, async (req, res) => {
  const filter = { customer: req.user._id };
  if (req.q.scope === 'active') filter.status = { $in: ACTIVE_STATUSES };
  if (req.q.scope === 'past') filter.status = { $nin: ACTIVE_STATUSES };
  const result = await paginate(Booking.find(filter).sort({ createdAt: -1 }).populate('driver', DRIVER_FIELDS), req.q);
  ok(res, { ...result, items: result.items.map(customerView) });
});

async function ownBooking(req) {
  const booking = await Booking.findOne({ _id: req.params.id, customer: req.user._id }).populate('driver', DRIVER_FIELDS);
  if (!booking) throw notFound('Booking not found');
  return booking;
}

api.get('/bookings/:id', { summary: 'Booking detail', tag: 'Customer: Bookings' }, async (req, res) => {
  ok(res, customerView(await ownBooking(req)));
});

api.post('/bookings/:id/cancel', {
  summary: 'Cancel a booking (a fee may apply after a driver is assigned)',
  tag: 'Customer: Bookings',
  body: z.object({ reason: z.string().trim().min(2).max(300) }),
}, async (req, res) => {
  const booking = await cancelByCustomer(req.user, req.params.id, req.body.reason);
  ok(res, customerView(booking), 'Booking cancelled');
});

api.post('/bookings/:id/rate', {
  summary: 'Rate the driver after a completed trip',
  tag: 'Customer: Bookings',
  body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }),
}, async (req, res) => {
  created(res, await submitReview('customer', req.user, req.params.id, req.body));
});

api.get('/bookings/:id/invoice', { summary: 'Invoice for a completed trip', tag: 'Customer: Bookings' }, async (req, res) => {
  const booking = await ownBooking(req);
  if (booking.status !== 'completed') throw badRequest('Invoice is available after the trip is completed', 'INVALID_STATE');
  ok(res, {
    invoiceNo: `INV-${booking.bookingNo}`,
    issuedAt: booking.endedAt,
    customer: { name: req.user.name, phone: req.user.phone },
    driver: { name: booking.driver?.name },
    car: booking.carSnapshot,
    trip: { type: booking.type, pickup: booking.pickup?.address, drop: booking.drop?.address, startedAt: booking.startedAt, endedAt: booking.endedAt },
    fare: booking.fareFinal,
    paymentMethod: booking.paymentMethod,
    paymentStatus: booking.paymentStatus,
  });
});

api.post('/bookings/:id/pay', { summary: 'Start online payment for a completed trip', tag: 'Customer: Payments' }, async (req, res) => {
  const booking = await ownBooking(req);
  if (booking.status !== 'completed' || booking.paymentStatus !== 'pending') throw conflict('Nothing to pay for this booking', 'NOT_PAYABLE');
  ok(res, await createPaymentOrder({ ownerRole: 'customer', owner: req.user._id, purpose: 'booking', amount: booking.fareFinal.total, booking: booking._id }));
});

mountSos(api, 'customer');

/* ------------------------------ wallet & payments ------------------------------ */

api.get('/wallet', { summary: 'Wallet balance and history', tag: 'Customer: Payments', query: pageQuery }, async (req, res) => {
  const history = await paginate(Transaction.find({ ownerRole: 'customer', owner: req.user._id }).sort({ createdAt: -1 }), req.q);
  ok(res, { balance: req.user.walletBalance, ...history });
});

api.post('/wallet/topup', {
  summary: 'Start a wallet top-up',
  tag: 'Customer: Payments',
  body: z.object({ amount: z.number().int().min(10).max(50000) }),
}, async (req, res) => {
  ok(res, await createPaymentOrder({ ownerRole: 'customer', owner: req.user._id, purpose: 'wallet_topup', amount: req.body.amount }));
});

api.post('/payments/verify', {
  summary: 'Confirm a payment after the gateway checkout',
  description: 'Send the orderId from /wallet/topup or /bookings/:id/pay with the gateway payment id and signature.',
  tag: 'Customer: Payments',
  body: z.object({ orderId: objectId, gatewayPaymentId: z.string().min(3).max(100), signature: z.string().max(200).optional() }),
}, async (req, res) => {
  const order = await verifyPayment({ ownerRole: 'customer', owner: req.user._id, ...req.body });
  ok(res, { status: order.status, purpose: order.purpose, amount: order.amount }, 'Payment confirmed');
});

mountNotifications(api, 'customer');
mountSupport(api, 'customer');

export default api;
