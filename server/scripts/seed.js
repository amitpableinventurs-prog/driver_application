import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { Admin, Banner, City, Coupon, Page, Pricing } from '../src/models/index.js';
import { getSettings } from '../src/services/settings.js';

const adminPassword = process.env.SEED_ADMIN_PASSWORD;
if (!adminPassword) throw new Error('Set SEED_ADMIN_PASSWORD in server/.env before seeding');

const CITIES = [
  { name: 'Indore', state: 'Madhya Pradesh', lat: 22.7196, lng: 75.8577 },
  { name: 'Bhopal', state: 'Madhya Pradesh', lat: 23.2599, lng: 77.4126 },
  { name: 'Mumbai', state: 'Maharashtra', lat: 19.076, lng: 72.8777 },
];

const PLANS = [
  { bookingType: 'hourly', baseFare: 299, includedHours: 2, extraHourRate: 99, nightCharge: 100 },
  { bookingType: 'oneway', baseFare: 249, includedHours: 1, includedKm: 10, perKmRate: 12, extraHourRate: 99, returnAllowance: 100, nightCharge: 100 },
  { bookingType: 'outstation', baseFare: 200, perDayRate: 1200, foodAllowancePerDay: 300, stayAllowancePerNight: 400 },
  { bookingType: 'monthly', includedHours: 8, extraHourRate: 60, monthlyRate: 22000 },
];

const ADMINS = [
  { name: 'Super Admin', email: 'super@drivergo.demo', role: 'super_admin' },
  { name: 'Operations Admin', email: 'ops@drivergo.demo', role: 'operations' },
  { name: 'Finance Admin', email: 'finance@drivergo.demo', role: 'finance' },
  { name: 'Support Admin', email: 'support@drivergo.demo', role: 'support' },
  { name: 'Content Admin', email: 'content@drivergo.demo', role: 'content' },
];

const PAGES = [
  { slug: 'terms', title: 'Terms and Conditions', content: 'Replace this text with your terms and conditions from the admin panel.' },
  { slug: 'privacy', title: 'Privacy Policy', content: 'Replace this text with your privacy policy from the admin panel.' },
  { slug: 'about', title: 'About Driver IN', content: 'Driver IN connects car owners with verified professional drivers.' },
  { slug: 'faq', title: 'Frequently Asked Questions', content: 'How do I start a trip?\nShare the 4 digit OTP with your driver when they reach you.' },
];

await connectDb();
await getSettings();

const passwordHash = await bcrypt.hash(adminPassword, 11);
for (const admin of ADMINS) {
  await Admin.updateOne({ email: admin.email }, { $setOnInsert: { ...admin, passwordHash } }, { upsert: true });
}

for (const { lat, lng, ...city } of CITIES) {
  const saved = await City.findOneAndUpdate(
    { name: city.name },
    { $setOnInsert: { ...city, center: { type: 'Point', coordinates: [lng, lat] } } },
    { upsert: true, returnDocument: 'after' },
  );
  for (const plan of PLANS) {
    await Pricing.updateOne({ city: saved._id, bookingType: plan.bookingType }, { $setOnInsert: plan }, { upsert: true, setDefaultsOnInsert: true });
  }
}

for (const page of PAGES) await Page.updateOne({ slug: page.slug }, { $setOnInsert: page }, { upsert: true });

await Banner.updateOne(
  { title: 'Your car, our driver' },
  { $setOnInsert: { title: 'Your car, our driver', subtitle: 'Verified drivers by the hour, day or month', audience: 'customer' } },
  { upsert: true },
);

const now = Date.now();
await Coupon.updateOne(
  { code: 'WELCOME50' },
  {
    $setOnInsert: {
      code: 'WELCOME50', description: '₹50 off your first booking', discountType: 'flat', value: 50, minFare: 200,
      validFrom: new Date(now), validTo: new Date(now + 365 * 86400000), perUserLimit: 1,
    },
  },
  { upsert: true },
);

console.log(`Seeded ${env.mongoUri.replace(/\/\/[^@/]*@/, '//***@')}`);
console.log(`Admin logins: ${ADMINS.map((admin) => admin.email).join(', ')}`);
await mongoose.disconnect();
