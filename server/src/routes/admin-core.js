import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createApi, escapeRegex, ok, created, paginate } from '../core/api.js';
import { adminPermissions, revokeAllSessions } from '../core/auth.js';
import { badRequest, conflict, notFound, unauthorized } from '../core/errors.js';
import { ROLES } from '../core/permissions.js';
import { date, email, money, pageQuery } from '../core/schemas.js';
import {
  ACTIVE_STATUSES, Admin, AuditLog, Booking, Customer, Driver, Payout, SosAlert, Ticket,
} from '../models/index.js';
import { getSettings } from '../services/settings.js';
import { audit } from './admin-helpers.js';

const api = createApi({ prefix: '/admin', tag: 'Admin', auth: 'admin' });

const dayKey = (value, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);

/* ------------------------------ session ------------------------------ */

api.get('/me', { summary: 'Logged-in admin with permissions', tag: 'Admin: Account' }, (req, res) => {
  const { _id, name, email: mail, role } = req.user;
  ok(res, { _id, name, email: mail, role, roleLabel: ROLES[role]?.label, permissions: adminPermissions(req.user) });
});

const password = z.string().min(8, 'Use at least 8 characters').max(100);

api.post('/me/password', {
  summary: 'Change my password',
  tag: 'Admin: Account',
  body: z.object({ currentPassword: z.string().min(1), newPassword: password }),
}, async (req, res) => {
  const admin = await Admin.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.body.currentPassword, admin.passwordHash))) throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  admin.passwordHash = await bcrypt.hash(req.body.newPassword, 11);
  await admin.save();
  await revokeAllSessions('admin', admin._id);
  await audit(req, 'change_password', 'admin', admin._id);
  ok(res, { changed: true }, 'Password changed. Please log in again.');
});

/* ------------------------------ dashboard ------------------------------ */

async function dailySeries(from, to, timezone) {
  const rows = await Booking.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } },
        bookings: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $in: ['$status', ['cancelled', 'no_driver']] }, 1, 0] } },
        gross: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$fareFinal.total', 0] } },
        commission: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$commission', 0] } },
        tax: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$fareFinal.tax', 0] } },
        discount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$fareFinal.discount', 0] } },
        driverEarnings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$driverEarning', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const byDay = new Map(rows.map(({ _id, ...row }) => [_id, row]));
  const empty = { bookings: 0, completed: 0, cancelled: 0, gross: 0, commission: 0, tax: 0, discount: 0, driverEarnings: 0 };
  const series = [];
  const addDay = (at) => {
    const key = dayKey(new Date(at), timezone);
    if (series.at(-1)?.date !== key) series.push({ date: key, ...(byDay.get(key) || empty) });
  };
  for (let at = from.getTime(); at <= to.getTime(); at += 86400000) addDay(at);
  addDay(to.getTime());
  return series;
}

api.get('/dashboard', { summary: 'Live KPIs, 14 day trend and status mix', tag: 'Admin: Dashboard', perm: 'dashboard' }, async (_req, res) => {
  const { timezone } = await getSettings();
  const now = new Date();
  const trendFrom = new Date(now.getTime() - 13 * 86400000);

  const [customers, drivers, onlineDrivers, busyDrivers, pendingKyc, activeBookings, openTickets, openSos, pendingPayouts, statusRows, trend] = await Promise.all([
    Customer.countDocuments({ status: { $ne: 'deleted' } }),
    Driver.countDocuments({ status: { $ne: 'deleted' } }),
    Driver.countDocuments({ isOnline: true }),
    Driver.countDocuments({ activeBooking: { $ne: null } }),
    Driver.countDocuments({ kycStatus: 'submitted' }),
    Booking.countDocuments({ status: { $in: ACTIVE_STATUSES } }),
    Ticket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
    SosAlert.countDocuments({ status: 'open' }),
    Payout.countDocuments({ status: 'requested' }),
    Booking.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    dailySeries(trendFrom, now, timezone),
  ]);
  const today = trend.find((day) => day.date === dayKey(now, timezone)) || trend.at(-1);

  ok(res, {
    counts: { customers, drivers, onlineDrivers, busyDrivers, pendingKyc, activeBookings, openTickets, openSos, pendingPayouts },
    today,
    trend,
    statusMix: statusRows.map((row) => ({ status: row._id, count: row.count })),
  });
});

api.get('/reports/revenue', {
  summary: 'Day-wise revenue report',
  tag: 'Admin: Dashboard',
  perm: 'finance',
  query: z.object({ from: date.optional(), to: date.optional() }),
}, async (req, res) => {
  const { timezone } = await getSettings();
  const to = req.q.to || new Date();
  const from = req.q.from || new Date(to.getTime() - 29 * 86400000);
  if (to - from > 366 * 86400000) throw badRequest('Choose a range of up to one year');
  const days = await dailySeries(from, to, timezone);
  const totals = days.reduce((sum, day) => {
    Object.keys(sum).forEach((key) => { sum[key] += day[key]; });
    return sum;
  }, { bookings: 0, completed: 0, cancelled: 0, gross: 0, commission: 0, tax: 0, discount: 0, driverEarnings: 0 });
  ok(res, { from, to, totals, days });
});

/* ------------------------------ settings ------------------------------ */

const whole = (max) => z.number().int().min(0).max(max);

api.get('/settings', { summary: 'Platform settings', tag: 'Admin: Settings', perm: 'settings' }, async (_req, res) => {
  ok(res, await getSettings());
});

api.put('/settings', {
  summary: 'Update platform settings',
  tag: 'Admin: Settings',
  perm: 'settings',
  body: z.object({
    commissionPercent: whole(100),
    taxPercent: whole(100),
    searchRadiusKm: z.number().int().min(1).max(100),
    maxDriversPerDispatch: z.number().int().min(1).max(100),
    searchTimeoutSeconds: z.number().int().min(30).max(3600),
    dispatchLeadMinutes: z.number().int().min(10).max(1440),
    minScheduleLeadMinutes: whole(1440),
    freeCancelMinutes: whole(120),
    cancellationFee: money,
    cancellationDriverSharePercent: whole(100),
    nightStartHour: whole(23),
    nightEndHour: whole(23),
    driverMinWalletBalance: z.number().int().min(-100000).max(0),
    minPayoutAmount: money,
    referralRewardReferrer: money,
    referralRewardReferee: money,
    supportPhone: z.string().trim().max(20),
    supportEmail: z.string().trim().max(120),
    sosPhone: z.string().trim().max(20),
  }).partial(),
}, async (req, res) => {
  const settings = await getSettings();
  Object.assign(settings, req.body);
  await settings.save();
  await audit(req, 'update', 'settings', settings._id, req.body);
  ok(res, settings);
});

/* ------------------------------ admin users ------------------------------ */

const roleEnum = z.enum(Object.keys(ROLES));

api.get('/roles', { summary: 'Roles and their permissions', tag: 'Admin: Team', perm: 'admins' }, (_req, res) => {
  ok(res, Object.entries(ROLES).map(([key, role]) => ({ key, ...role })));
});

api.get('/admins', { summary: 'List admin users', tag: 'Admin: Team', perm: 'admins', query: pageQuery }, async (req, res) => {
  ok(res, await paginate(Admin.find().sort({ createdAt: -1 }), req.q));
});

api.post('/admins', {
  summary: 'Create an admin user',
  tag: 'Admin: Team',
  perm: 'admins',
  body: z.object({ name: z.string().trim().min(2).max(80), email, password, role: roleEnum }),
}, async (req, res) => {
  const { password: plain, ...data } = req.body;
  const admin = await Admin.create({ ...data, passwordHash: await bcrypt.hash(plain, 11) });
  await audit(req, 'create', 'admin', admin._id, { email: admin.email, role: admin.role });
  const { passwordHash, ...view } = admin.toObject();
  created(res, view);
});

api.patch('/admins/:id', {
  summary: 'Update an admin role, status or password',
  tag: 'Admin: Team',
  perm: 'admins',
  body: z.object({ name: z.string().trim().min(2).max(80), role: roleEnum, status: z.enum(['active', 'disabled']), password }).partial(),
}, async (req, res) => {
  const isSelf = req.user._id.equals(req.params.id);
  if (isSelf && (req.body.status === 'disabled' || (req.body.role && req.body.role !== req.user.role))) {
    throw conflict('You cannot change your own role or disable yourself', 'SELF_CHANGE');
  }
  const { password: plain, ...changes } = req.body;
  if (plain) changes.passwordHash = await bcrypt.hash(plain, 11);
  const admin = await Admin.findByIdAndUpdate(req.params.id, changes, { returnDocument: 'after' });
  if (!admin) throw notFound('Admin not found');
  if (plain || changes.status === 'disabled') await revokeAllSessions('admin', admin._id);
  await audit(req, 'update', 'admin', admin._id, { role: changes.role, status: changes.status, passwordChanged: Boolean(plain) });
  ok(res, admin);
});

/* ------------------------------ audit log ------------------------------ */

api.get('/audit-logs', {
  summary: 'Admin activity log',
  tag: 'Admin: Team',
  perm: 'audit',
  query: pageQuery.extend({ entity: z.string().trim().max(40).optional(), action: z.string().trim().max(40).optional() }),
}, async (req, res) => {
  const filter = {};
  if (req.q.entity) filter.entity = new RegExp(`^${escapeRegex(req.q.entity)}`, 'i');
  if (req.q.action) filter.action = req.q.action;
  ok(res, await paginate(AuditLog.find(filter).sort({ createdAt: -1 }), req.q));
});

export default api;
