import { z } from 'zod';
import { created, ok, paginate } from '../core/api.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { lat, lng, objectId, pageQuery } from '../core/schemas.js';
import { publicImage, publicUrlFor } from '../core/upload.js';
import { ACTIVE_STATUSES, Booking, Notification, SosAlert, Ticket, nextSequence } from '../models/index.js';
import { emitTo, rooms } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';

export function accountView(account) {
  const view = account.toObject();
  delete view.deviceTokens;
  delete view.acceptLockUntil;
  delete view.__v;
  if (view.documents) view.documents = view.documents.map(({ fileName, ...document }) => document);
  return view;
}

export function mountAccountBasics(api) {
  api.post('/me/avatar', { summary: 'Upload profile photo', upload: publicImage, fileField: 'file' }, async (req, res) => {
    if (!req.file) throw badRequest('Attach an image in the file field');
    req.user.avatar = publicUrlFor(req.file);
    await req.user.save();
    ok(res, { avatar: req.user.avatar });
  });

  api.post('/me/device', {
    summary: 'Register a push notification device token',
    body: z.object({ deviceToken: z.string().min(10).max(500) }),
  }, async (req, res) => {
    await req.user.updateOne({ $addToSet: { deviceTokens: req.body.deviceToken } });
    ok(res, { registered: true });
  });

  api.delete('/me/device', {
    summary: 'Remove a push token on logout',
    body: z.object({ deviceToken: z.string().min(10).max(500) }),
  }, async (req, res) => {
    await req.user.updateOne({ $pull: { deviceTokens: req.body.deviceToken } });
    ok(res, { removed: true });
  });
}

export function mountNotifications(api, role) {
  api.get('/notifications', { summary: 'List my notifications', tag: 'Notifications', query: pageQuery }, async (req, res) => {
    const filter = { role, recipient: req.user._id };
    const result = await paginate(Notification.find(filter).sort({ createdAt: -1 }), req.q);
    const unread = await Notification.countDocuments({ ...filter, readAt: null });
    ok(res, { ...result, unread });
  });

  api.post('/notifications/read', {
    summary: 'Mark notifications read (all when ids is omitted)',
    tag: 'Notifications',
    body: z.object({ ids: z.array(objectId).max(100).optional() }),
  }, async (req, res) => {
    const filter = { role, recipient: req.user._id, readAt: null };
    if (req.body.ids) filter._id = { $in: req.body.ids };
    const result = await Notification.updateMany(filter, { readAt: new Date() });
    ok(res, { updated: result.modifiedCount });
  });
}

export function mountSupport(api, role) {
  const mine = (req) => ({ role, raisedBy: req.user._id });

  api.get('/tickets', { summary: 'List my support tickets', tag: 'Support', query: pageQuery }, async (req, res) => {
    ok(res, await paginate(Ticket.find(mine(req)).sort({ updatedAt: -1 }), req.q));
  });

  api.post('/tickets', {
    summary: 'Open a support ticket',
    tag: 'Support',
    body: z.object({
      subject: z.string().trim().min(3).max(150),
      category: z.enum(['booking', 'payment', 'driver', 'app', 'account', 'other']).default('other'),
      message: z.string().trim().min(3).max(2000),
      bookingId: objectId.optional(),
    }),
  }, async (req, res) => {
    const { subject, category, message, bookingId } = req.body;
    if (bookingId && !(await Booking.exists({ _id: bookingId, [role]: req.user._id }))) throw notFound('Booking not found');
    const ticket = await Ticket.create({
      ticketNo: `TK${await nextSequence('ticket')}`,
      ...mine(req),
      raisedByName: req.user.name,
      raisedByPhone: req.user.phone,
      booking: bookingId,
      category,
      subject,
      messages: [{ from: 'user', text: message }],
    });
    emitTo(rooms.admins, 'ticket:new', { ticketId: String(ticket._id), ticketNo: ticket.ticketNo });
    created(res, ticket, 'Ticket created');
  });

  api.get('/tickets/:id', { summary: 'Ticket detail with messages', tag: 'Support' }, async (req, res) => {
    const ticket = await Ticket.findOne({ _id: req.params.id, ...mine(req) });
    if (!ticket) throw notFound('Ticket not found');
    ok(res, ticket);
  });

  api.post('/tickets/:id/messages', {
    summary: 'Reply on a ticket',
    tag: 'Support',
    body: z.object({ text: z.string().trim().min(1).max(2000) }),
  }, async (req, res) => {
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, ...mine(req), status: { $ne: 'closed' } },
      { $push: { messages: { from: 'user', text: req.body.text } }, status: 'open' },
      { returnDocument: 'after' },
    );
    if (!ticket) throw notFound('Ticket not found or already closed');
    ok(res, ticket);
  });
}

export function mountSos(api, role) {
  api.post('/bookings/:id/sos', {
    summary: 'Raise an SOS alert on an active booking',
    tag: 'Safety',
    body: z.object({ lat: lat.optional(), lng: lng.optional(), message: z.string().trim().max(500).optional() }),
  }, async (req, res) => {
    const booking = await Booking.findOne({ _id: req.params.id, [role]: req.user._id });
    if (!booking) throw notFound('Booking not found');
    if (!ACTIVE_STATUSES.includes(booking.status)) throw conflict('SOS is available only on active bookings', 'INVALID_STATE');
    const alert = await SosAlert.create({ booking: booking._id, raisedByRole: role, raisedBy: req.user._id, ...req.body });
    emitTo(rooms.admins, 'sos:new', { sosId: String(alert._id), bookingNo: booking.bookingNo, role, lat: alert.lat, lng: alert.lng });
    const { sosPhone } = await getSettings();
    created(res, { alert, emergencyNumber: sosPhone }, 'Our safety team has been alerted');
  });
}
