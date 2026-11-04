import { z } from 'zod';
import { createApi, created, ok, paginate } from '../core/api.js';
import { badRequest } from '../core/errors.js';
import { date, lat, lng, money, objectId, pageQuery } from '../core/schemas.js';
import { publicImage, publicUrlFor } from '../core/upload.js';
import { Banner, BOOKING_TYPES, Broadcast, City, Coupon, Customer, Driver, Notification, Page, Pricing } from '../models/index.js';
import { emitTo, rooms } from '../services/realtime.js';
import { audit, crud } from './admin-helpers.js';

const api = createApi({ prefix: '/admin', tag: 'Admin', auth: 'admin' });
const CATALOG = 'Admin: Catalog';
const CONTENT = 'Admin: Content';

const cityBody = z.object({
  name: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  lat: lat.optional(),
  lng: lng.optional(),
  isActive: z.boolean().default(true),
}).transform(({ lat: latitude, lng: longitude, ...city }) => (
  latitude !== undefined && longitude !== undefined
    ? { ...city, center: { type: 'Point', coordinates: [longitude, latitude] } }
    : city
));

api.get('/cities', { summary: 'List cities', tag: CATALOG, perm: 'pricing', query: pageQuery }, async (req, res) => {
  ok(res, await paginate(City.find().sort({ name: 1 }), req.q));
});

api.post('/cities', { summary: 'Create city', tag: CATALOG, perm: 'pricing', body: cityBody }, async (req, res) => {
  const city = await City.create(req.body);
  await audit(req, 'create', 'city', city._id);
  created(res, city);
});

api.patch('/cities/:id', { summary: 'Update city', tag: CATALOG, perm: 'pricing', body: cityBody }, async (req, res) => {
  const city = await City.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!city) throw badRequest('City not found');
  await audit(req, 'update', 'city', city._id, req.body);
  ok(res, city);
});

crud(api, '/pricing', Pricing, {
  perm: 'pricing',
  tag: CATALOG,
  entity: 'pricing plan',
  sort: { city: 1, bookingType: 1 },
  populate: { path: 'city', select: 'name' },
  body: z.object({
    city: objectId,
    bookingType: z.enum(BOOKING_TYPES),
    baseFare: money.default(0),
    includedHours: z.number().min(0).max(24).default(0),
    extraHourRate: money.default(0),
    includedKm: z.number().min(0).max(1000).default(0),
    perKmRate: money.default(0),
    returnAllowance: money.default(0),
    perDayRate: money.default(0),
    foodAllowancePerDay: money.default(0),
    stayAllowancePerNight: money.default(0),
    monthlyRate: money.default(0),
    nightCharge: money.default(0),
    isActive: z.boolean().default(true),
  }),
});

crud(api, '/coupons', Coupon, {
  perm: 'coupons',
  tag: CATALOG,
  entity: 'coupon',
  body: z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/, 'Use 3 to 20 letters or digits'),
    description: z.string().trim().max(200).optional(),
    discountType: z.enum(['flat', 'percent']),
    value: z.number().int().min(1).max(100000),
    maxDiscount: money.default(0),
    minFare: money.default(0),
    validFrom: date,
    validTo: date,
    usageLimit: z.number().int().min(0).default(0),
    perUserLimit: z.number().int().min(0).default(1),
    isActive: z.boolean().default(true),
  }),
});

crud(api, '/banners', Banner, {
  perm: 'content',
  tag: CONTENT,
  entity: 'banner',
  sort: { sortOrder: 1 },
  body: z.object({
    title: z.string().trim().min(2).max(100),
    subtitle: z.string().trim().max(200).optional(),
    imageUrl: z.string().trim().max(500).optional(),
    linkUrl: z.string().trim().max(500).optional(),
    audience: z.enum(['customer', 'driver', 'all']).default('customer'),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
});

api.post('/uploads/image', { summary: 'Upload an image and get its public URL', tag: CONTENT, perm: 'content', upload: publicImage, fileField: 'file' }, (req, res) => {
  if (!req.file) throw badRequest('Attach an image in the file field');
  created(res, { url: publicUrlFor(req.file) });
});

crud(api, '/pages', Page, {
  perm: 'content',
  tag: CONTENT,
  entity: 'page',
  sort: { slug: 1 },
  body: z.object({
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,50}$/, 'Use lowercase letters, digits and hyphens'),
    title: z.string().trim().min(2).max(120),
    content: z.string().max(100000).default(''),
    isPublished: z.boolean().default(true),
  }),
});

/* ------------------------------ broadcast ------------------------------ */

api.get('/broadcasts', { summary: 'Sent broadcasts', tag: CONTENT, perm: 'content', query: pageQuery }, async (req, res) => {
  ok(res, await paginate(Broadcast.find().sort({ createdAt: -1 }).populate('sentBy', 'name'), req.q));
});

api.post('/broadcasts', {
  summary: 'Send a notification to all customers, drivers or everyone',
  tag: CONTENT,
  perm: 'content',
  body: z.object({
    audience: z.enum(['customers', 'drivers', 'all']),
    title: z.string().trim().min(2).max(100),
    body: z.string().trim().min(2).max(500),
  }),
}, async (req, res) => {
  const { audience, title, body } = req.body;
  const groups = [];
  if (audience !== 'drivers') groups.push(['customer', Customer]);
  if (audience !== 'customers') groups.push(['driver', Driver]);

  let recipientCount = 0;
  for (const [role, Model] of groups) {
    const ids = await Model.find({ status: 'active' }).select('_id').lean();
    recipientCount += ids.length;
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000).map(({ _id }) => ({ role, recipient: _id, title, body, type: 'broadcast' }));
      const saved = await Notification.insertMany(batch);
      saved.forEach((notification) => emitTo(rooms[role](notification.recipient), 'notification', notification));
    }
  }
  const broadcast = await Broadcast.create({ audience, title, body, recipientCount, sentBy: req.user._id });
  await audit(req, 'send', 'broadcast', broadcast._id, { audience, recipientCount });
  created(res, broadcast, `Sent to ${recipientCount} users`);
});

export default api;
