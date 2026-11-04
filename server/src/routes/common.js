import { z } from 'zod';
import { createApi, ok } from '../core/api.js';
import { notFound } from '../core/errors.js';
import { Banner, BOOKING_TYPES, City, DOCUMENT_TYPES, Page, PAYMENT_METHODS, Pricing, REQUIRED_DOCUMENTS } from '../models/index.js';
import { env } from '../config/env.js';
import { getSettings } from '../services/settings.js';

const api = createApi({ prefix: '/common', tag: 'Common (public)' });

api.get('/config', { summary: 'App bootstrap configuration' }, async (_req, res) => {
  const settings = await getSettings();
  ok(res, {
    bookingTypes: BOOKING_TYPES,
    paymentMethods: PAYMENT_METHODS,
    paymentGateway: env.paymentGateway,
    documentTypes: DOCUMENT_TYPES,
    requiredDocuments: REQUIRED_DOCUMENTS,
    supportPhone: settings.supportPhone,
    supportEmail: settings.supportEmail,
    sosPhone: settings.sosPhone,
    minScheduleLeadMinutes: settings.minScheduleLeadMinutes,
    freeCancelMinutes: settings.freeCancelMinutes,
    cancellationFee: settings.cancellationFee,
    minPayoutAmount: settings.minPayoutAmount,
    referralRewardReferrer: settings.referralRewardReferrer,
    referralRewardReferee: settings.referralRewardReferee,
  });
});

api.get('/cities', { summary: 'Active service cities with their available booking types' }, async (_req, res) => {
  const cities = await City.find({ isActive: true }).sort({ name: 1 }).lean();
  const plans = await Pricing.find({ isActive: true }).select('city bookingType').lean();
  ok(res, cities.map((city) => ({
    ...city,
    bookingTypes: plans.filter((plan) => plan.city.equals(city._id)).map((plan) => plan.bookingType),
  })));
});

api.get('/plans', {
  summary: 'Published rate card for a city',
  query: z.object({ cityId: z.string().regex(/^[a-f\d]{24}$/i) }),
}, async (req, res) => {
  ok(res, await Pricing.find({ city: req.q.cityId, isActive: true }).select('-__v -createdAt -updatedAt'));
});

api.get('/banners', {
  summary: 'Active promotional banners',
  query: z.object({ audience: z.enum(['customer', 'driver']).default('customer') }),
}, async (req, res) => {
  ok(res, await Banner.find({ isActive: true, audience: { $in: [req.q.audience, 'all'] } }).sort({ sortOrder: 1 }));
});

api.get('/pages/:slug', { summary: 'CMS page by slug (terms, privacy, about, faq)' }, async (req, res) => {
  const page = await Page.findOne({ slug: req.params.slug, isPublished: true });
  if (!page) throw notFound('Page not found');
  ok(res, page);
});

export default api;
