import { z } from 'zod';
import { createApi, escapeRegex, ok, paginate } from '../core/api.js';
import { conflict, notFound } from '../core/errors.js';
import { date, objectId, pageQuery, searchQuery } from '../core/schemas.js';
import { Booking, BOOKING_TYPES, Customer, Driver, Payout, Review, SosAlert, Ticket, Transaction } from '../models/index.js';
import { acceptBooking, cancelByAdmin, eligibleDrivers, refreshRating } from '../services/bookings.js';
import { notify } from '../services/notify.js';
import { getSettings } from '../services/settings.js';
import { credit } from '../services/wallet.js';
import { audit, csvCell } from './admin-helpers.js';

const api = createApi({ prefix: '/admin', tag: 'Admin', auth: 'admin' });
const BOOKINGS = 'Admin: Bookings';
const FINANCE = 'Admin: Finance';
const SUPPORT = 'Admin: Support';

/* ------------------------------ bookings ------------------------------ */

const bookingFilters = searchQuery.extend({
  status: z.string().trim().max(20).optional(),
  type: z.enum(BOOKING_TYPES).optional(),
  from: date.optional(),
  to: date.optional(),
});

async function bookingFilter(q) {
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.type) filter.type = q.type;
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = q.from;
    if (q.to) filter.createdAt.$lte = q.to;
  }
  if (q.search) {
    const pattern = new RegExp(escapeRegex(q.search), 'i');
    const people = { $or: [{ name: pattern }, { phone: pattern }] };
    const [customers, drivers] = await Promise.all([
      Customer.find(people).select('_id').limit(200),
      Driver.find(people).select('_id').limit(200),
    ]);
    filter.$or = [
      { bookingNo: pattern },
      { customer: { $in: customers.map((c) => c._id) } },
      { driver: { $in: drivers.map((d) => d._id) } },
    ];
  }
  return filter;
}

api.get('/bookings', { summary: 'List bookings with filters', tag: BOOKINGS, perm: 'bookings', query: bookingFilters }, async (req, res) => {
  const query = Booking.find(await bookingFilter(req.q))
    .select('-startOtp -notifiedDrivers -rejectedBy')
    .sort({ createdAt: -1 })
    .populate('customer', 'name phone')
    .populate('driver', 'name phone')
    .populate('city', 'name');
  ok(res, await paginate(query, req.q));
});

api.get('/bookings/export', {
  summary: 'Export bookings as CSV (up to 10,000 rows)',
  tag: BOOKINGS,
  perm: 'bookings',
  query: bookingFilters.omit({ page: true, limit: true }),
}, async (req, res) => {
  const bookings = await Booking.find(await bookingFilter(req.q))
    .sort({ createdAt: -1 }).limit(10000)
    .populate('customer', 'name phone').populate('driver', 'name phone').populate('city', 'name').lean();
  const header = ['Booking', 'Created', 'Type', 'Status', 'City', 'Customer', 'Customer phone', 'Driver', 'Driver phone', 'Fare', 'Commission', 'Driver earning', 'Payment', 'Payment status'];
  const rows = bookings.map((b) => [
    b.bookingNo, b.createdAt?.toISOString(), b.type, b.status, b.city?.name, b.customer?.name, b.customer?.phone,
    b.driver?.name, b.driver?.phone, b.fareFinal?.total ?? b.fareEstimate?.total, b.commission, b.driverEarning, b.paymentMethod, b.paymentStatus,
  ].map(csvCell).join(','));
  await audit(req, 'export', 'bookings', undefined, { rows: rows.length });
  res.type('text/csv').attachment('bookings.csv').send([header.join(','), ...rows].join('\n'));
});

api.get('/bookings/:id', { summary: 'Booking detail', tag: BOOKINGS, perm: 'bookings' }, async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .select('-startOtp')
    .populate('customer', 'name phone email rating')
    .populate('driver', 'name phone rating location')
    .populate('city', 'name')
    .populate('assignedByAdmin', 'name');
  if (!booking) throw notFound('Booking not found');
  const [reviews, sos] = await Promise.all([
    Review.find({ booking: booking._id }),
    SosAlert.find({ booking: booking._id }).sort({ createdAt: -1 }),
  ]);
  ok(res, { booking, reviews, sos });
});

api.get('/bookings/:id/candidates', { summary: 'Nearest eligible drivers for manual assignment', tag: BOOKINGS, perm: 'bookings' }, async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw notFound('Booking not found');
  const settings = await getSettings();
  const drivers = await eligibleDrivers(booking, settings, { exclude: booking.rejectedBy, limit: 20 }).select('name phone rating totalTrips location');
  ok(res, drivers);
});

api.post('/bookings/:id/assign', {
  summary: 'Manually assign a driver',
  tag: BOOKINGS,
  perm: 'bookings',
  body: z.object({ driverId: objectId }),
}, async (req, res) => {
  const booking = await acceptBooking(req.body.driverId, req.params.id, { adminId: req.user._id });
  await audit(req, 'assign_driver', 'booking', booking._id, { driverId: req.body.driverId });
  ok(res, { status: booking.status, driver: booking.driver }, 'Driver assigned');
});

api.post('/bookings/:id/cancel', {
  summary: 'Cancel a booking without a fee',
  tag: BOOKINGS,
  perm: 'bookings',
  body: z.object({ reason: z.string().trim().min(3).max(300) }),
}, async (req, res) => {
  const booking = await cancelByAdmin(req.user, req.params.id, req.body.reason);
  await audit(req, 'cancel', 'booking', booking._id, req.body);
  ok(res, { status: booking.status }, 'Booking cancelled');
});

api.post('/bookings/:id/refund', {
  summary: 'Refund a paid booking to the customer wallet',
  tag: BOOKINGS,
  perm: 'finance',
  body: z.object({ amount: z.number().int().min(1).optional(), note: z.string().trim().min(3).max(200) }),
}, async (req, res) => {
  const booking = await Booking.findOneAndUpdate({ _id: req.params.id, paymentStatus: 'paid' }, { paymentStatus: 'refunded' }, { returnDocument: 'after' });
  if (!booking) throw conflict('Only a paid booking can be refunded', 'NOT_REFUNDABLE');
  const amount = Math.min(req.body.amount ?? booking.fareFinal.total, booking.fareFinal.total);
  await credit({ role: 'customer', ownerId: booking.customer, amount, category: 'refund', key: `refund:${booking._id}`, booking: booking._id, note: req.body.note });
  await audit(req, 'refund', 'booking', booking._id, { amount, note: req.body.note });
  await notify('customer', booking.customer, { title: 'Refund processed', body: `₹${amount} has been added to your wallet for ${booking.bookingNo}`, type: 'payment' });
  ok(res, { refunded: amount });
});

/* ------------------------------ reviews ------------------------------ */

api.get('/reviews', {
  summary: 'List ratings and reviews',
  tag: BOOKINGS,
  perm: 'bookings',
  query: pageQuery.extend({ maxRating: z.coerce.number().int().min(1).max(5).optional() }),
}, async (req, res) => {
  const filter = req.q.maxRating ? { rating: { $lte: req.q.maxRating } } : {};
  const query = Review.find(filter).sort({ createdAt: -1 })
    .populate('customer', 'name').populate('driver', 'name').populate('booking', 'bookingNo');
  ok(res, await paginate(query, req.q));
});

api.patch('/reviews/:id', {
  summary: 'Hide or restore a review',
  tag: BOOKINGS,
  perm: 'bookings',
  body: z.object({ hidden: z.boolean() }),
}, async (req, res) => {
  const review = await Review.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
  if (!review) throw notFound('Review not found');
  const target = review.fromRole === 'customer' ? 'driver' : 'customer';
  await refreshRating(target, review[target]);
  await audit(req, req.body.hidden ? 'hide' : 'restore', 'review', review._id);
  ok(res, review);
});

/* ------------------------------ SOS ------------------------------ */

api.get('/sos', {
  summary: 'SOS alerts',
  tag: SUPPORT,
  perm: 'support',
  query: pageQuery.extend({ status: z.enum(['open', 'resolved']).optional() }),
}, async (req, res) => {
  const filter = req.q.status ? { status: req.q.status } : {};
  const query = SosAlert.find(filter).sort({ status: 1, createdAt: -1 }).populate({
    path: 'booking',
    select: 'bookingNo customer driver pickup status',
    populate: [{ path: 'customer', select: 'name phone' }, { path: 'driver', select: 'name phone' }],
  });
  ok(res, await paginate(query, req.q));
});

api.post('/sos/:id/resolve', {
  summary: 'Resolve an SOS alert',
  tag: SUPPORT,
  perm: 'support',
  body: z.object({ resolutionNote: z.string().trim().min(3).max(500) }),
}, async (req, res) => {
  const alert = await SosAlert.findOneAndUpdate(
    { _id: req.params.id, status: 'open' },
    { status: 'resolved', resolvedBy: req.user._id, resolvedAt: new Date(), resolutionNote: req.body.resolutionNote },
    { returnDocument: 'after' },
  );
  if (!alert) throw notFound('Open alert not found');
  await audit(req, 'resolve', 'sos', alert._id, req.body);
  ok(res, alert);
});

/* ------------------------------ tickets ------------------------------ */

api.get('/tickets', {
  summary: 'Support tickets',
  tag: SUPPORT,
  perm: 'support',
  query: searchQuery.extend({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional() }),
}, async (req, res) => {
  const filter = {};
  if (req.q.status) filter.status = req.q.status;
  if (req.q.search) {
    const pattern = new RegExp(escapeRegex(req.q.search), 'i');
    filter.$or = [{ ticketNo: pattern }, { subject: pattern }, { raisedByPhone: pattern }, { raisedByName: pattern }];
  }
  ok(res, await paginate(Ticket.find(filter).select('-messages').sort({ updatedAt: -1 }), req.q));
});

api.get('/tickets/:id', { summary: 'Ticket with conversation', tag: SUPPORT, perm: 'support' }, async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).populate('booking', 'bookingNo status');
  if (!ticket) throw notFound('Ticket not found');
  ok(res, ticket);
});

api.post('/tickets/:id/reply', {
  summary: 'Reply to a ticket and optionally change its status',
  tag: SUPPORT,
  perm: 'support',
  body: z.object({ text: z.string().trim().min(1).max(2000), status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional() }),
}, async (req, res) => {
  const ticket = await Ticket.findByIdAndUpdate(req.params.id, {
    $push: { messages: { from: 'admin', text: req.body.text, adminName: req.user.name } },
    status: req.body.status || 'in_progress',
  }, { returnDocument: 'after' });
  if (!ticket) throw notFound('Ticket not found');
  await notify(ticket.role, ticket.raisedBy, { title: `Reply on ${ticket.ticketNo}`, body: req.body.text.slice(0, 120), type: 'support', data: { ticketId: String(ticket._id) } });
  ok(res, ticket);
});

api.patch('/tickets/:id', {
  summary: 'Change ticket status',
  tag: SUPPORT,
  perm: 'support',
  body: z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']) }),
}, async (req, res) => {
  const ticket = await Ticket.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
  if (!ticket) throw notFound('Ticket not found');
  ok(res, ticket);
});

/* ------------------------------ finance ------------------------------ */

api.get('/transactions', {
  summary: 'All wallet transactions',
  tag: FINANCE,
  perm: 'finance',
  query: pageQuery.extend({ ownerRole: z.enum(['customer', 'driver']).optional(), category: z.string().trim().max(40).optional() }),
}, async (req, res) => {
  const filter = {};
  if (req.q.ownerRole) filter.ownerRole = req.q.ownerRole;
  if (req.q.category) filter.category = req.q.category;
  const result = await paginate(Transaction.find(filter).sort({ createdAt: -1 }).populate('booking', 'bookingNo').lean(), req.q);
  const ids = (role) => result.items.filter((tx) => tx.ownerRole === role).map((tx) => tx.owner);
  const [customers, drivers] = await Promise.all([
    Customer.find({ _id: { $in: ids('customer') } }).select('name phone').lean(),
    Driver.find({ _id: { $in: ids('driver') } }).select('name phone').lean(),
  ]);
  const people = new Map([...customers, ...drivers].map((person) => [String(person._id), person]));
  ok(res, { ...result, items: result.items.map((tx) => ({ ...tx, ownerInfo: people.get(String(tx.owner)) })) });
});

api.get('/payouts', {
  summary: 'Driver payout requests',
  tag: FINANCE,
  perm: 'finance',
  query: pageQuery.extend({ status: z.enum(['requested', 'paid', 'rejected']).optional() }),
}, async (req, res) => {
  const filter = req.q.status ? { status: req.q.status } : {};
  ok(res, await paginate(Payout.find(filter).sort({ createdAt: -1 }).populate('driver', 'name phone walletBalance'), req.q));
});

api.post('/payouts/:id/mark-paid', {
  summary: 'Mark a payout paid after the bank transfer',
  tag: FINANCE,
  perm: 'finance',
  body: z.object({ reference: z.string().trim().min(3).max(100) }),
}, async (req, res) => {
  const payout = await Payout.findOneAndUpdate(
    { _id: req.params.id, status: 'requested' },
    { status: 'paid', reference: req.body.reference, processedBy: req.user._id, processedAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!payout) throw conflict('This payout is already processed', 'PAYOUT_PROCESSED');
  await audit(req, 'mark_paid', 'payout', payout._id, req.body);
  await notify('driver', payout.driver, { title: 'Payout sent', body: `₹${payout.amount} has been sent. Ref: ${payout.reference}`, type: 'payment' });
  ok(res, payout);
});

api.post('/payouts/:id/reject', {
  summary: 'Reject a payout and return the amount to the wallet',
  tag: FINANCE,
  perm: 'finance',
  body: z.object({ note: z.string().trim().min(3).max(200) }),
}, async (req, res) => {
  const payout = await Payout.findOneAndUpdate(
    { _id: req.params.id, status: 'requested' },
    { status: 'rejected', note: req.body.note, processedBy: req.user._id, processedAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!payout) throw conflict('This payout is already processed', 'PAYOUT_PROCESSED');
  await credit({ role: 'driver', ownerId: payout.driver, amount: payout.amount, category: 'payout_reversal', key: `payout-reversal:${payout._id}`, note: req.body.note });
  await audit(req, 'reject', 'payout', payout._id, req.body);
  await notify('driver', payout.driver, { title: 'Payout rejected', body: `₹${payout.amount} is back in your wallet. ${req.body.note}`, type: 'payment' });
  ok(res, payout);
});

export default api;
