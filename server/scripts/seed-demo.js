/**
 * Demo data for every section of the admin and customer panels.
 *
 *   npm run seed:demo             fills an empty database with ~45 days of history plus live bookings
 *   npm run seed:demo -- --online puts the demo drivers back online (idle drivers drop off the map after 15 minutes)
 *
 * History is written directly with back-dated timestamps, using the real fare engine and the same
 * ledger keys as the services, so every wallet balance equals the sum of its transactions.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { privatePathFor } from '../src/core/upload.js';
import {
  Address, Admin, AuditLog, Banner, Booking, Broadcast, Car, City, Coupon, Customer, Driver, Notification,
  PaymentOrder, Payout, Pricing, Review, SosAlert, Ticket, Transaction, nextSequence,
} from '../src/models/index.js';
import { calculateFare, roadKm, splitEarnings, travelMinutes } from '../src/services/fare.js';
import { getSettings } from '../src/services/settings.js';

if (env.isProd) throw new Error('Demo data must not be seeded in production');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const HISTORY_DAYS = 45;
const oid = () => new mongoose.Types.ObjectId();

/* ------------------------------ deterministic random ------------------------------ */

let seed = 20261112;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => Math.floor(min + rnd() * (max - min + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const weighted = (pairs) => {
  let roll = rnd() * pairs.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of pairs) { roll -= weight; if (roll <= 0) return value; }
  return pairs.at(-1)[0];
};
const jitter = (place, km = 0.6) => ({
  ...place,
  lat: place.lat + (rnd() - 0.5) * (km / 55),
  lng: place.lng + (rnd() - 0.5) * (km / 55),
});

/* ------------------------------ source data ------------------------------ */

const P = (address, lat, lng) => ({ address, lat, lng });
const CITY_DATA = [
  {
    name: 'Indore', reg: 'MP09',
    places: [
      P('Vijay Nagar Square, Indore', 22.7533, 75.8937), P('56 Dukan, New Palasia, Indore', 22.7244, 75.8839),
      P('Rajwada Palace, Indore', 22.7185, 75.8553), P('Bhawarkuan Square, Indore', 22.6926, 75.8676),
      P('Devi Ahilyabai Holkar Airport, Indore', 22.7217, 75.8011), P('Rau Circle, Indore', 22.637, 75.811),
      P('TCS Campus, Super Corridor, Indore', 22.779, 75.823), P('LIG Square, AB Road, Indore', 22.7372, 75.8905),
    ],
    outstation: [P('Mahakaleshwar Temple, Ujjain', 23.1828, 75.7682), P('Omkareshwar, Khandwa', 22.2456, 76.151)],
  },
  {
    name: 'Bhopal', reg: 'MP04',
    places: [
      P('MP Nagar Zone 1, Bhopal', 23.2332, 77.4343), P('New Market, TT Nagar, Bhopal', 23.2334, 77.4),
      P('E-7 Arera Colony, Bhopal', 23.212, 77.433), P('Rani Kamlapati Station, Bhopal', 23.2291, 77.4398),
      P('Kolar Road, Bhopal', 23.169, 77.419), P('Lalghati Square, Bhopal', 23.276, 77.365),
    ],
    outstation: [P('Sanchi Stupa, Raisen', 23.4873, 77.7418)],
  },
  {
    name: 'Mumbai', reg: 'MH02',
    places: [
      P('Lokhandwala, Andheri West, Mumbai', 19.1364, 72.8296), P('Linking Road, Bandra West, Mumbai', 19.0596, 72.8295),
      P('Hiranandani Gardens, Powai, Mumbai', 19.1176, 72.906), P('Dadar TT Circle, Mumbai', 19.0178, 72.8478),
      P('Lower Parel, Mumbai', 18.998, 72.83), P('Terminal 2, CSMI Airport, Mumbai', 19.0974, 72.8745),
    ],
    outstation: [P('Koregaon Park, Pune', 18.5362, 73.894), P('Lonavala Market, Lonavala', 18.7546, 73.4062)],
  },
];

const CAR_POOL = [
  ['Maruti Swift', 'manual', 'hatchback', 'petrol'], ['Hyundai i20', 'manual', 'hatchback', 'petrol'],
  ['Tata Tiago', 'manual', 'hatchback', 'cng'], ['Honda City', 'automatic', 'sedan', 'petrol'],
  ['Maruti Dzire', 'manual', 'sedan', 'cng'], ['Hyundai Verna', 'automatic', 'sedan', 'diesel'],
  ['Hyundai Creta', 'automatic', 'suv', 'diesel'], ['Mahindra XUV700', 'manual', 'suv', 'diesel'],
  ['Tata Nexon EV', 'automatic', 'suv', 'ev'], ['Toyota Fortuner', 'automatic', 'suv', 'diesel'],
  ['Mercedes C-Class', 'automatic', 'luxury', 'petrol'], ['BMW 3 Series', 'automatic', 'luxury', 'diesel'],
];

// [name, city index]
const CUSTOMER_DATA = [
  ['Aarav Sharma', 0], ['Priya Verma', 0], ['Rohit Jain', 0], ['Sneha Patel', 0], ['Vikram Singh Chouhan', 0],
  ['Ananya Gupta', 0], ['Karan Mehta', 0], ['Neha Agrawal', 0], ['Aditya Joshi', 0], ['Pooja Tiwari', 0],
  ['Rahul Dubey', 0], ['Kavita Malviya', 0], ['Siddharth Rao', 0], ['Manish Soni', 0],
  ['Meera Nair', 1], ['Arjun Kapoor', 1], ['Divya Saxena', 1], ['Ritu Bansal', 1], ['Imran Khan', 1],
  ['Nikhil Deshmukh', 2], ['Shreya Kulkarni', 2], ['Farah Sheikh', 2], ['Harpreet Kaur', 2], ['Tanvi Shah', 2],
];
const REFERRALS = { 3: 0, 9: 0, 16: 14, 21: 19 }; // referee index -> referrer index
const BLOCKED_CUSTOMER = 13;

// [name, city index, kyc status]. The order inside a city decides the demo role, see ROLE below.
const DRIVER_DATA = [
  ['Ramesh Yadav', 0, 'approved'], ['Suresh Patidar', 0, 'approved'], ['Mahesh Chouhan', 0, 'approved'],
  ['Dinesh Kushwah', 0, 'approved'], ['Rajesh Solanki', 0, 'approved'], ['Mukesh Prajapati', 0, 'approved'],
  ['Santosh Verma', 0, 'approved'], ['Anil Rathore', 0, 'approved'], ['Deepak Sen', 0, 'approved'],
  ['Vijay Thakur', 0, 'approved'], ['Pankaj Malviya', 0, 'submitted'], ['Govind Pawar', 0, 'rejected'],
  ['Irfan Qureshi', 1, 'approved'], ['Lokesh Sahu', 1, 'approved'], ['Ajay Vishwakarma', 1, 'submitted'],
  ['Sachin Gaikwad', 2, 'approved'], ['Prakash Shinde', 2, 'approved'], ['Ganesh More', 2, 'not_submitted'],
];
const ROLE = { accepted: 0, arrived: 1, hourlyTrip: 2, monthlyTrip: 3, scheduled: 4, idleA: 5, idleB: 6, dues: 7, suspended: 8, bhopalIdle: 12, mumbaiTrip: 15 };
const ONLINE_ROLES = ['accepted', 'arrived', 'hourlyTrip', 'monthlyTrip', 'scheduled', 'idleA', 'idleB', 'bhopalIdle', 'mumbaiTrip'];
const customerPhone = (index) => `90000001${String(index + 1).padStart(2, '0')}`;
const driverPhone = (index) => `80000001${String(index + 1).padStart(2, '0')}`;

const COUPONS = [
  { code: 'SAVE20', description: '20% off, up to ₹150', discountType: 'percent', value: 20, maxDiscount: 150, minFare: 300, perUserLimit: 3, from: -60, to: 60 },
  { code: 'FLAT100', description: '₹100 off on fares above ₹500', discountType: 'flat', value: 100, minFare: 500, perUserLimit: 2, usageLimit: 200, from: -60, to: 30 },
  { code: 'OUTSTATION10', description: '10% off outstation trips, up to ₹500', discountType: 'percent', value: 10, maxDiscount: 500, minFare: 1500, perUserLimit: 2, from: -60, to: 90 },
  { code: 'DIWALI150', description: 'Festive offer: ₹150 off (expired)', discountType: 'flat', value: 150, minFare: 600, perUserLimit: 1, from: -40, to: -10 },
  { code: 'TESTOFF', description: 'Internal test coupon (inactive)', discountType: 'percent', value: 50, maxDiscount: 200, perUserLimit: 1, from: -5, to: 30, isActive: false },
];

const CUSTOMER_COMMENTS = {
  5: ['Very polite and punctual driver.', 'Smooth driving, reached on time.', 'Excellent service, will book again.', 'Driver knew all the routes. Great trip.', 'Safe driving with my family on board.', ''],
  4: ['Good trip overall.', 'Driver was good, arrived a little late.', 'Nice experience.', ''],
  3: ['Average. Driver was on a phone call for a while.', 'Okay trip, took a longer route.'],
  2: ['Driver arrived 25 minutes late.', 'Rash driving on the highway.'],
  1: ['Very rude behaviour. Not acceptable.'],
};
const DRIVER_COMMENTS = ['Good customer, car in great condition.', 'Polite and cooperative.', 'Paid on time.', 'Customer was ready at pickup.', '', ''];
const CANCEL_REASONS = ['Plans changed', 'Booked by mistake', 'Found another driver', 'Driver is taking too long', 'Trip postponed to next week', 'Wrong pickup location selected'];
const ADMIN_CANCEL_REASONS = ['Customer requested cancellation on call', 'Duplicate booking', 'Driver unreachable, booking closed by operations'];

/* ------------------------------ guards ------------------------------ */

await connectDb();

if (process.argv.includes('--online')) {
  const phones = ONLINE_ROLES.map((role) => driverPhone(ROLE[role]));
  const result = await Driver.updateMany({ phone: { $in: phones }, status: 'active', kycStatus: 'approved' }, { isOnline: true, locationUpdatedAt: new Date() });
  console.log(`${result.modifiedCount} demo drivers are online again`);
  await mongoose.disconnect();
  process.exit(0);
}

if (await Customer.exists({ phone: customerPhone(0) }) || await Booking.exists({})) {
  console.log('Demo data was not added: this database already has bookings or demo accounts.');
  await mongoose.disconnect();
  process.exit(0);
}

const settings = await getSettings();
const admins = Object.fromEntries((await Admin.find()).map((admin) => [admin.role, admin]));
for (const role of ['super_admin', 'operations', 'finance', 'support', 'content']) {
  if (!admins[role]) throw new Error('Run "npm run seed" first: the admin accounts are missing');
}

const cities = [];
const plans = new Map();
for (const data of CITY_DATA) {
  const city = await City.findOne({ name: data.name });
  if (!city) throw new Error(`Run "npm run seed" first: city ${data.name} is missing`);
  cities.push({ ...data, _id: city._id });
  for (const plan of await Pricing.find({ city: city._id })) plans.set(`${city._id}:${plan.bookingType}`, plan);
}

for (const { from, to, ...coupon } of COUPONS) {
  await Coupon.updateOne(
    { code: coupon.code },
    { $setOnInsert: { ...coupon, validFrom: new Date(NOW + from * DAY), validTo: new Date(NOW + to * DAY) } },
    { upsert: true, setDefaultsOnInsert: true },
  );
}
const coupons = await Coupon.find({ code: { $in: ['SAVE20', 'FLAT100', 'OUTSTATION10'] } });
const couponUse = new Map(); // `${couponId}:${customerId}` and couponId -> count

/* ------------------------------ collections built in memory ------------------------------ */

const out = {
  customers: [], cars: [], addresses: [], drivers: [], bookings: [], transactions: [], orders: [], payouts: [],
  reviews: [], tickets: [], sos: [], notifications: [], broadcasts: [], audits: [], banners: [],
};

/* ------------------------------ ledger ------------------------------ */

const balance = new Map();
const lastMove = new Map();
const balanceOf = (id) => balance.get(String(id)) || 0;

/** Same shape and keys as services/wallet.js, with a back-dated timestamp. */
function move(role, ownerId, direction, amount, category, key, at, { booking, note } = {}) {
  if (amount <= 0) return;
  const id = String(ownerId);
  // A wallet's entries must stay in time order so "balance after" reads correctly in the statement.
  const when = Math.min(Math.max(at, (lastMove.get(id) || 0) + MIN), NOW);
  lastMove.set(id, when);
  balance.set(id, balanceOf(id) + (direction === 'credit' ? amount : -amount));
  out.transactions.push({
    ownerRole: role, owner: ownerId, direction, amount, category, booking: booking?._id, bookingRef: booking,
    note, idempotencyKey: key, balanceAfter: balanceOf(id), createdAt: new Date(when),
  });
}

function paymentOrder(ownerRole, owner, purpose, amount, at, { booking, status = 'paid' } = {}) {
  const order = {
    _id: oid(), ownerRole, owner, purpose, booking: booking?._id, amount, gateway: 'mock',
    gatewayOrderId: `mock_${crypto.randomUUID()}`, status, createdAt: new Date(at),
    gatewayPaymentId: status === 'paid' ? `pay_demo_${crypto.randomBytes(6).toString('hex')}` : undefined,
  };
  out.orders.push(order);
  return order;
}

function topUp(customer, amount, at) {
  const order = paymentOrder('customer', customer._id, 'wallet_topup', amount, at);
  move('customer', customer._id, 'credit', amount, 'topup', `order:${order._id}`, at, { note: 'Wallet top-up' });
}

/* ------------------------------ customers ------------------------------ */

CUSTOMER_DATA.forEach(([name, cityIndex], index) => {
  const city = cities[cityIndex];
  const joined = NOW - int(HISTORY_DAYS + 2, HISTORY_DAYS + 40) * DAY;
  const customer = {
    _id: oid(), name, phone: customerPhone(index), email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
    referralCode: `DG${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status: index === BLOCKED_CUSTOMER ? 'blocked' : 'active',
    totalBookings: 0, createdAt: new Date(joined), cityIndex, cars: [], usedCoupon: 0,
  };
  out.customers.push(customer);

  const carIndexes = index % 3 === 0 ? [(index * 5) % 12, (index * 7 + 3) % 12] : [(index * 5) % 12];
  carIndexes.forEach((carIndex, position) => {
    const [carName, transmission, category, fuel] = CAR_POOL[carIndex];
    const car = {
      _id: oid(), customer: customer._id, name: carName, transmission, category, fuel, isDefault: position === 0,
      registrationNumber: `${city.reg}${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(66 + (carIndex % 24))}${1000 + index * 137 + carIndex * 11}`,
      createdAt: new Date(joined + HOUR),
    };
    customer.cars.push(car);
    out.cars.push(car);
  });

  const home = jitter(city.places[index % city.places.length], 1.5);
  out.addresses.push({ customer: customer._id, label: 'Home', address: home.address, lat: home.lat, lng: home.lng, createdAt: new Date(joined + HOUR) });
  if (index % 2 === 0) {
    const office = jitter(city.places[(index + 3) % city.places.length], 1);
    out.addresses.push({ customer: customer._id, label: 'Office', address: office.address, lat: office.lat, lng: office.lng, createdAt: new Date(joined + 2 * HOUR) });
  }
});
for (const [referee, referrer] of Object.entries(REFERRALS)) {
  out.customers[referee].referredBy = out.customers[referrer]._id;
  out.customers[referee].referralRewarded = false;
}

/* ------------------------------ drivers and KYC files ------------------------------ */

function placeholderPng([r, g, b]) {
  const width = 480; const height = 300;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const DOC_COLORS = { driving_license: [66, 133, 244], aadhaar: [244, 160, 0], pan: [15, 157, 88], police_verification: [120, 94, 240], photo: [219, 68, 55] };
const files = []; // written only once everything has validated

function kycDocument(type, index, status, at, rejectionReason) {
  const fileName = `${crypto.randomUUID()}.png`;
  files.push({ fileName, color: DOC_COLORS[type] });
  const numbers = {
    driving_license: `MP09 2015${String(1000000 + index * 7919).slice(0, 7)}`, aadhaar: `XXXX XXXX ${4000 + index * 37}`,
    pan: `ABCPD${1200 + index}K`, police_verification: `PV/2026/${3100 + index}`,
  };
  return {
    type, number: numbers[type], fileName, mimeType: 'image/png', status, rejectionReason,
    expiryDate: type === 'driving_license' ? new Date(NOW + (400 + index * 90) * DAY) : undefined,
    reviewedAt: status === 'pending' ? undefined : new Date(at + DAY), createdAt: new Date(at), updatedAt: new Date(at + DAY),
  };
}

DRIVER_DATA.forEach(([name, cityIndex, kycStatus], index) => {
  const city = cities[cityIndex];
  const approved = kycStatus === 'approved';
  const joined = approved ? NOW - int(HISTORY_DAYS + 5, HISTORY_DAYS + 60) * DAY : NOW - int(1, 6) * DAY;
  const allRounder = [0, 1, 2, 3, 4, 12, 15, 16].includes(index);
  const base = jitter(city.places[index % city.places.length], 2);
  const driver = {
    _id: oid(), name, phone: driverPhone(index), email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
    dateOfBirth: new Date(Date.UTC(1978 + (index * 3) % 18, index % 12, 1 + (index * 5) % 27)), gender: 'male',
    address: city.places[(index + 2) % city.places.length].address, city: city._id,
    languages: cityIndex === 2 ? ['Hindi', 'Marathi', 'English'] : ['Hindi', 'English'].slice(0, 1 + (index % 2)),
    experienceYears: 3 + (index * 5) % 14,
    transmissions: [7, 9].includes(index) ? ['manual'] : ['manual', 'automatic'],
    carCategories: allRounder ? ['hatchback', 'sedan', 'suv', 'luxury'] : ['hatchback', 'sedan', 'suv'],
    documents: [], kycStatus, isOnline: false, status: 'active', totalTrips: 0, cancelledTrips: 0,
    location: { type: 'Point', coordinates: [base.lng, base.lat] }, heading: int(0, 359),
    locationUpdatedAt: new Date(NOW - int(2, 30) * HOUR), createdAt: new Date(joined),
    cityIndex, index, busyUntil: 0, unavailableAfter: Infinity,
  };
  if (kycStatus !== 'not_submitted') {
    driver.bank = { accountHolder: name, accountNumber: `50100${String(23456700 + index * 4391)}`, ifsc: pick(['HDFC0000404', 'SBIN0030015', 'ICIC0000041', 'UTIB0000043']), upiId: `${name.split(' ')[0].toLowerCase()}${index}@upi` };
    const types = approved && index % 2 === 0 ? ['driving_license', 'aadhaar', 'photo', 'pan', 'police_verification'] : ['driving_license', 'aadhaar', 'photo'];
    driver.documents = types.map((type) => kycDocument(type, index, approved ? 'approved' : 'pending', joined + HOUR));
  }
  if (kycStatus === 'rejected') {
    driver.documents[0].status = 'rejected';
    driver.documents[0].rejectionReason = 'Licence photo is blurred, number is not readable';
    driver.documents[0].reviewedAt = new Date(joined + DAY);
    driver.documents[1].status = 'approved';
    driver.documents[1].reviewedAt = new Date(joined + DAY);
    driver.kycRejectionReason = 'Driving licence is not readable. Please upload a clear photo.';
  }
  if (kycStatus === 'not_submitted') { delete driver.location; delete driver.locationUpdatedAt; delete driver.heading; }
  out.drivers.push(driver);
});
const driverFor = (role) => out.drivers[ROLE[role]];
const SUSPENDED_AT = NOW - 5 * DAY;
const MONTHLY_START = NOW - 9 * DAY;
for (const role of ['accepted', 'arrived', 'hourlyTrip', 'mumbaiTrip']) driverFor(role).unavailableAfter = NOW - 3 * HOUR;
driverFor('monthlyTrip').unavailableAfter = MONTHLY_START - DAY;
driverFor('suspended').unavailableAfter = SUSPENDED_AT;
driverFor('suspended').status = 'suspended';

/* ------------------------------ bookings ------------------------------ */

const point = ({ address, lat, lng }) => ({ address, location: { type: 'Point', coordinates: [lng, lat] } });
const history = (booking, status, at, by) => booking.statusHistory.push({ status, at: new Date(at), by });

function chooseCoupon(customer, subtotal, type, createdAt) {
  const options = coupons.filter((coupon) => subtotal >= coupon.minFare
    && createdAt >= coupon.validFrom.getTime()
    && (coupon.code !== 'OUTSTATION10' || type === 'outstation')
    && (couponUse.get(`${coupon._id}:${customer._id}`) || 0) < coupon.perUserLimit);
  return options.length ? pick(options) : null;
}

/** A booking as createBooking() would write it, at a chosen point in time. */
function draftBooking({ customer, type, createdAt, scheduledAt, pickup, drop, hours, days, hoursPerDay, paymentMethod, withCoupon, notes }) {
  const city = cities[customer.cityIndex];
  const plan = plans.get(`${city._id}:${type}`);
  const car = customer.cars[int(0, customer.cars.length - 1)];
  const instant = !scheduledAt;
  const startAt = scheduledAt || createdAt;
  const km = drop ? roadKm(pickup, drop) : 0;
  const minutes = { hourly: (hours || 0) * 60, oneway: travelMinutes(km), outstation: (days || 0) * 1440, monthly: 30 * 1440 }[type];
  const fareArgs = { type, plan, settings, minutes, km, days: type === 'monthly' ? 30 : days || 1, hoursPerDay: hoursPerDay || 0, startAt: new Date(startAt) };
  const coupon = withCoupon ? chooseCoupon(customer, calculateFare(fareArgs).subtotal, type, createdAt) : null;
  const fare = calculateFare({ ...fareArgs, coupon });
  const dispatchAt = instant ? createdAt : startAt - settings.dispatchLeadMinutes * MIN;
  const firstStatus = dispatchAt <= createdAt ? 'searching' : 'pending';
  const booking = {
    _id: oid(), customer: customer._id, city: city._id, car: car._id,
    carSnapshot: { name: car.name, registrationNumber: car.registrationNumber, transmission: car.transmission, category: car.category, fuel: car.fuel },
    type, pickup: point(pickup), drop: drop ? point(drop) : undefined, isInstant: instant,
    scheduledAt: new Date(startAt), plannedEndAt: new Date(startAt + minutes * MIN),
    hours, days: type === 'outstation' ? days : undefined, hoursPerDay, estimatedKm: km, notes,
    status: firstStatus, statusHistory: [{ status: firstStatus, at: new Date(createdAt), by: 'customer' }],
    dispatchAt: new Date(dispatchAt),
    searchExpiresAt: new Date(instant ? createdAt + settings.searchTimeoutSeconds * 1000 : Math.max(createdAt + settings.searchTimeoutSeconds * 1000, startAt)),
    notifiedDrivers: [], rejectedBy: [], startOtp: String(int(1000, 9999)),
    fareEstimate: fare, ...splitEarnings(fare, settings), coupon: coupon?._id, couponCode: coupon?.code,
    paymentMethod, paymentStatus: 'unpaid', createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    ref: { customer, plan, coupon, km, pickup },
  };
  if (firstStatus === 'pending' && dispatchAt <= NOW) history(booking, 'searching', dispatchAt, 'system');
  out.bookings.push(booking);
  return booking;
}

function countCoupon(booking) {
  const { coupon, customer } = booking.ref;
  if (!coupon) return;
  for (const key of [`${coupon._id}:${customer._id}`, String(coupon._id)]) couponUse.set(key, (couponUse.get(key) || 0) + 1);
}

function findDriver(booking, from, until) {
  const { transmission, category } = booking.carSnapshot;
  const free = out.drivers.filter((driver) => driver.kycStatus === 'approved'
    && driver.cityIndex === booking.ref.customer.cityIndex
    && driver.createdAt.getTime() < from
    && driver.transmissions.includes(transmission) && driver.carCategories.includes(category)
    && driver.busyUntil <= from && until <= driver.unavailableAfter);
  return free.length ? pick(free) : null;
}

function assign(booking, driver, at, by = 'driver') {
  booking.driver = driver._id;
  booking.ref.driver = driver;
  booking.acceptedAt = new Date(at);
  booking.notifiedDrivers = [driver._id];
  booking.status = 'accepted';
  history(booking, 'accepted', at, by);
  booking.updatedAt = new Date(at);
}

function cancel(booking, at, by, reason, historyBy = by) {
  booking.status = 'cancelled';
  booking.cancellation = { by, reason, fee: 0, at: new Date(at) };
  history(booking, 'cancelled', at, historyBy);
  booking.updatedAt = new Date(at);
}

const completedBookings = [];
const payoutCount = { total: 0 };

function requestPayout(driver, at, { settle = true } = {}) {
  const amount = Math.floor(balanceOf(driver._id) / 100) * 100;
  if (amount < settings.minPayoutAmount) return;
  payoutCount.total += 1;
  const payout = { _id: oid(), driver: driver._id, amount, status: 'requested', bankSnapshot: driver.bank, createdAt: new Date(at), updatedAt: new Date(at), ref: { driver } };
  move('driver', driver._id, 'debit', amount, 'payout', `payout:${payout._id}`, at, { note: 'Payout requested' });
  const processedAt = at + int(6, 30) * HOUR;
  if (settle && processedAt < NOW - HOUR) {
    payout.processedBy = admins.finance._id;
    payout.processedAt = new Date(processedAt);
    payout.updatedAt = payout.processedAt;
    if (payoutCount.total === 3) {
      payout.status = 'rejected';
      payout.note = 'Bank account number does not match the account holder name';
      move('driver', driver._id, 'credit', amount, 'payout_reversal', `payout-reversal:${payout._id}`, processedAt, { note: payout.note });
      driver.busyUntil = Math.max(driver.busyUntil, processedAt);
    } else {
      payout.status = 'paid';
      payout.reference = `UTR${int(100000, 999999)}${int(100000, 999999)}`;
    }
  }
  out.payouts.push(payout);
}

function settleTrip(booking, driver, customer, endedAt) {
  const { fareFinal: fare, driverEarning } = booking;
  const key = `trip:${booking._id}:driver`;
  const method = driver === driverFor('dues') ? 'cash' : booking.paymentMethod;
  booking.paymentMethod = method;
  booking.paymentStatus = 'paid';
  let paidAt = endedAt;

  if (method === 'cash') {
    const owed = fare.total - driverEarning;
    if (owed >= 0) move('driver', driver._id, 'debit', owed, 'cash_commission', key, endedAt, { booking });
    else move('driver', driver._id, 'credit', -owed, 'trip_earning', key, endedAt, { booking });
  } else if (method === 'wallet') {
    const short = fare.total - balanceOf(customer._id);
    if (short > 0) topUp(customer, Math.ceil(short / 500) * 500, booking.createdAt.getTime() - 30 * MIN);
    move('customer', customer._id, 'debit', fare.total, 'trip_payment', `trip:${booking._id}:customer`, endedAt, { booking });
    move('driver', driver._id, 'credit', driverEarning, 'trip_earning', key, endedAt, { booking });
  } else if (endedAt > NOW - 2 * DAY && chance(0.4)) {
    // Online trip the customer has not paid yet: the driver can still collect cash.
    booking.paymentStatus = 'pending';
    paymentOrder('customer', customer._id, 'booking', fare.total, endedAt + 2 * MIN, { booking, status: 'created' });
    return;
  } else {
    paidAt = endedAt + int(2, 20) * MIN;
    paymentOrder('customer', customer._id, 'booking', fare.total, paidAt - MIN, { booking });
    move('driver', driver._id, 'credit', driverEarning, 'trip_earning', key, paidAt, { booking });
  }
  booking.paidAt = new Date(paidAt);
  if (driver === driverFor('dues')) return;
  if (balanceOf(driver._id) >= 1500 && chance(0.6)) requestPayout(driver, paidAt + int(1, 5) * HOUR);
  if (balanceOf(driver._id) < -300) {
    // Cash commission has built up: the driver clears the dues online to stay eligible for bookings.
    const amount = -balanceOf(driver._id);
    const at = Math.min(paidAt + int(1, 6) * HOUR, NOW - 30 * MIN);
    const order = paymentOrder('driver', driver._id, 'driver_dues', amount, at);
    move('driver', driver._id, 'credit', amount, 'dues_payment', `order:${order._id}`, at, { note: 'Dues payment' });
  }
}

function review(booking, fromRole, rating, comment, at) {
  out.reviews.push({
    _id: oid(), booking: booking._id, fromRole, customer: booking.customer, driver: booking.driver, rating,
    comment: comment || undefined, hidden: false, createdAt: new Date(Math.min(at, NOW)), ref: { booking },
  });
}

function historicBooking(createdAt) {
  const customer = pick(out.customers.filter((candidate) => candidate.createdAt.getTime() < createdAt));
  const city = cities[customer.cityIndex];
  const type = weighted([['hourly', 50], ['oneway', 35], ['outstation', 15]]);
  const pickup = jitter(pick(city.places));
  const shape = { customer, type, createdAt, pickup, withCoupon: chance(0.25), paymentMethod: weighted([['cash', 50], ['wallet', 25], ['online', 25]]) };
  if (type === 'hourly') shape.hours = weighted([[2, 40], [3, 25], [4, 20], [6, 10], [8, 5]]);
  if (type === 'oneway') shape.drop = jitter(pick(city.places.filter((place) => place.address !== pickup.address)));
  if (type === 'outstation') { shape.drop = pick(city.outstation); shape.days = weighted([[1, 45], [2, 40], [3, 15]]); }
  if (type === 'outstation' || chance(0.3)) {
    const scheduledAt = createdAt + int(3, 30) * HOUR;
    if (scheduledAt < NOW - 3 * HOUR) shape.scheduledAt = scheduledAt; // history must not reach into the future
  }
  if (chance(0.15)) shape.notes = pick(['Please call on arrival', 'Senior citizen travelling, drive carefully', 'Gate number 2', 'Child seat in the car']);

  const booking = draftBooking(shape);
  const startAt = booking.scheduledAt.getTime();
  const instant = booking.isInstant;
  let outcome = weighted([['completed', 76], ['cancelled', 16], ['no_driver', 8]]);

  // Planned trip timeline, used to check the driver is free and the trip is over before "now".
  const acceptedAt = instant ? createdAt + int(1, 4) * MIN : Math.max(createdAt + 2 * MIN, booking.dispatchAt.getTime() + int(1, 5) * MIN);
  const arrivedAt = instant ? acceptedAt + int(8, 22) * MIN : startAt - int(0, 10) * MIN;
  const startedAt = arrivedAt + int(2, 7) * MIN;
  const minutes = {
    hourly: () => booking.hours * 60 + int(-20, 50),
    oneway: () => travelMinutes(booking.ref.km) + int(0, 25),
    outstation: () => booking.days * 1440 - int(60, 300),
  }[type]();
  const endedAt = startedAt + minutes * MIN;

  const cancelsEarly = outcome === 'cancelled' && chance(0.5);
  const driver = outcome === 'no_driver' || cancelsEarly ? null : findDriver(booking, acceptedAt, endedAt + 20 * MIN);
  if (outcome === 'completed' && endedAt > NOW - HOUR) outcome = 'cancelled';
  if (!driver && outcome === 'completed') outcome = 'no_driver';

  if (outcome === 'no_driver') {
    const at = booking.searchExpiresAt.getTime();
    if (booking.status === 'pending' && booking.statusHistory.length === 1) history(booking, 'searching', booking.dispatchAt.getTime(), 'system');
    booking.status = 'no_driver';
    history(booking, 'no_driver', at, 'system');
    booking.updatedAt = new Date(at);
    return;
  }

  if (outcome === 'cancelled' && (!driver || cancelsEarly)) {
    const at = Math.min(createdAt + (instant ? int(40, 150) * 1000 : int(10, 90) * MIN), NOW - 10 * MIN);
    booking.statusHistory.length = 1; // cancelled before dispatch opened
    if (booking.statusHistory[0].status === 'pending' && booking.dispatchAt.getTime() < at) history(booking, 'searching', booking.dispatchAt.getTime(), 'system');
    cancel(booking, at, 'customer', pick(CANCEL_REASONS));
    return;
  }

  assign(booking, driver, acceptedAt);

  if (outcome === 'cancelled') {
    const at = Math.min(acceptedAt + int(6, 16) * MIN, NOW - 10 * MIN);
    driver.busyUntil = at;
    if (chance(0.3)) {
      cancel(booking, at, 'admin', pick(ADMIN_CANCEL_REASONS), `admin:${admins.operations.name}`);
      out.audits.push({ admin: admins.operations, action: 'cancel', entity: 'booking', entityId: booking._id, meta: { reason: booking.cancellation.reason }, at });
      return;
    }
    cancel(booking, at, 'customer', pick(CANCEL_REASONS));
    const fee = instant ? Math.min(settings.cancellationFee, Math.max(0, balanceOf(customer._id))) : 0;
    if (fee > 0) {
      booking.cancellation.fee = fee;
      move('customer', customer._id, 'debit', fee, 'cancellation_fee', `cancel:${booking._id}:customer`, at, { booking });
      move('driver', driver._id, 'credit', Math.round((fee * settings.cancellationDriverSharePercent) / 100), 'cancellation_compensation', `cancel:${booking._id}:driver`, at, { booking });
    }
    return;
  }

  const extraCharges = type !== 'hourly' && chance(0.35) ? int(1, 6) * 50 : 0;
  const fare = calculateFare({
    type, plan: booking.ref.plan, settings, minutes, km: booking.ref.km, days: booking.days || 1,
    startAt: new Date(startedAt), endAt: new Date(endedAt), coupon: booking.ref.coupon, extraCharges,
  });
  Object.assign(booking, {
    status: 'completed', arrivedAt: new Date(arrivedAt), startedAt: new Date(startedAt), endedAt: new Date(endedAt),
    fareFinal: fare, ...splitEarnings(fare, settings), updatedAt: new Date(endedAt),
  });
  history(booking, 'arrived', arrivedAt, 'driver');
  history(booking, 'in_progress', startedAt, 'driver');
  history(booking, 'completed', endedAt, 'driver');
  countCoupon(booking);
  driver.busyUntil = endedAt + 20 * MIN;
  driver.totalTrips += 1;
  customer.totalBookings += 1;
  completedBookings.push(booking);

  settleTrip(booking, driver, customer, endedAt);

  if (customer.referredBy && !customer.referralRewarded) {
    customer.referralRewarded = true;
    move('customer', customer._id, 'credit', settings.referralRewardReferee, 'referral_bonus', `referral:${customer._id}:referee`, endedAt, { note: 'Referral bonus' });
    move('customer', customer.referredBy, 'credit', settings.referralRewardReferrer, 'referral_bonus', `referral:${customer._id}:referrer`, endedAt, { note: 'Referral bonus' });
  }

  if (chance(0.75)) {
    const rating = weighted([[5, 62], [4, 28], [3, 6], [2, 3], [1, 1]]);
    review(booking, 'customer', rating, pick(CUSTOMER_COMMENTS[rating]), endedAt + int(5, 600) * MIN);
  }
  if (chance(0.5)) review(booking, 'driver', weighted([[5, 70], [4, 25], [3, 5]]), pick(DRIVER_COMMENTS), endedAt + int(3, 120) * MIN);
}

/* ------------------------------ live bookings ------------------------------ */

function liveBookings() {
  const indore = cities[0].places;
  const place = (cityIndex, index) => jitter(cities[cityIndex].places[index], 0.4);
  const goOnline = (driver, at, { lat, lng }, booking) => {
    Object.assign(driver, { isOnline: true, location: { type: 'Point', coordinates: [lng, lat] }, locationUpdatedAt: new Date(at), heading: int(0, 359) });
    if (booking) driver.activeBooking = booking._id;
  };
  const C = out.customers;
  const longSearch = (booking) => { booking.searchExpiresAt = new Date(NOW + 12 * HOUR); };
  // Wallet bookings are only accepted when the balance covers the estimate.
  topUp(C[2], 2000, NOW - 26 * HOUR);
  topUp(C[6], 5000, NOW - 27 * HOUR);

  // Looking for a driver right now. Kept open for 12 hours so "Assign driver" can be tried from the admin panel.
  longSearch(draftBooking({ customer: C[0], type: 'hourly', hours: 3, createdAt: NOW - 2 * MIN, pickup: place(0, 2), paymentMethod: 'cash' }));
  longSearch(draftBooking({ customer: C[14], type: 'oneway', createdAt: NOW - MIN, pickup: place(1, 0), drop: place(1, 5), paymentMethod: 'online' }));

  // Driver on the way.
  const accepted = draftBooking({ customer: C[1], type: 'oneway', createdAt: NOW - 9 * MIN, pickup: place(0, 1), drop: place(0, 4), paymentMethod: 'cash', withCoupon: true });
  assign(accepted, driverFor('accepted'), NOW - 7 * MIN);
  goOnline(driverFor('accepted'), NOW - MIN, jitter(indore[7], 0.5), accepted);

  // Driver waiting at the pickup point.
  const arrived = draftBooking({ customer: C[2], type: 'hourly', hours: 4, createdAt: NOW - 24 * MIN, pickup: place(0, 0), paymentMethod: 'wallet' });
  assign(arrived, driverFor('arrived'), NOW - 21 * MIN);
  arrived.status = 'arrived';
  arrived.arrivedAt = new Date(NOW - 3 * MIN);
  history(arrived, 'arrived', NOW - 3 * MIN, 'driver');
  goOnline(driverFor('arrived'), NOW - MIN, arrived.ref.pickup, arrived);

  const start = (booking, driver, acceptedAt, arrivedAt, startedAt) => {
    assign(booking, driver, acceptedAt);
    Object.assign(booking, { status: 'in_progress', arrivedAt: new Date(arrivedAt), startedAt: new Date(startedAt), updatedAt: new Date(startedAt) });
    history(booking, 'arrived', arrivedAt, 'driver');
    history(booking, 'in_progress', startedAt, 'driver');
  };

  // Trips in progress.
  const hourly = draftBooking({ customer: C[3], type: 'hourly', hours: 2, createdAt: NOW - 65 * MIN, pickup: place(0, 3), paymentMethod: 'online' });
  start(hourly, driverFor('hourlyTrip'), NOW - 62 * MIN, NOW - 47 * MIN, NOW - 42 * MIN);
  goOnline(driverFor('hourlyTrip'), NOW - MIN, jitter(indore[5], 1.5), hourly);

  const mumbai = draftBooking({ customer: C[19], type: 'oneway', createdAt: NOW - 40 * MIN, pickup: place(2, 0), drop: place(2, 4), paymentMethod: 'cash' });
  start(mumbai, driverFor('mumbaiTrip'), NOW - 38 * MIN, NOW - 22 * MIN, NOW - 17 * MIN);
  goOnline(driverFor('mumbaiTrip'), NOW - MIN, jitter(cities[2].places[1], 1), mumbai);

  const monthly = draftBooking({ customer: C[4], type: 'monthly', hoursPerDay: 10, createdAt: MONTHLY_START - 2 * DAY, scheduledAt: MONTHLY_START, pickup: place(0, 6), paymentMethod: 'online', notes: 'Office pick and drop, Monday to Saturday' });
  start(monthly, driverFor('monthlyTrip'), MONTHLY_START - DAY, MONTHLY_START - 5 * MIN, MONTHLY_START + 4 * MIN);
  goOnline(driverFor('monthlyTrip'), NOW - 2 * MIN, monthly.ref.pickup, monthly);

  // Scheduled for later.
  const tomorrow = NOW + 20 * HOUR;
  draftBooking({ customer: C[5], type: 'hourly', hours: 6, createdAt: NOW - 3 * HOUR, scheduledAt: tomorrow, pickup: place(0, 7), paymentMethod: 'cash', notes: 'Wedding function, formal dress preferred' });
  draftBooking({ customer: C[6], type: 'outstation', days: 2, createdAt: NOW - 26 * HOUR, scheduledAt: NOW + 3 * DAY, pickup: place(0, 1), drop: cities[0].outstation[0], paymentMethod: 'wallet', withCoupon: true });
  draftBooking({ customer: C[7], type: 'monthly', hoursPerDay: 8, createdAt: NOW - 2 * DAY, scheduledAt: NOW + 5 * DAY, pickup: place(0, 0), paymentMethod: 'online' });
  draftBooking({ customer: C[20], type: 'oneway', createdAt: NOW - 5 * HOUR, scheduledAt: NOW + 9 * HOUR, pickup: place(2, 2), drop: place(2, 5), paymentMethod: 'cash', notes: 'Early morning flight' });

  const assigned = draftBooking({ customer: C[8], type: 'outstation', days: 1, createdAt: NOW - 30 * HOUR, scheduledAt: NOW + 28 * HOUR, pickup: place(0, 2), drop: cities[0].outstation[1], paymentMethod: 'cash' });
  assign(assigned, driverFor('scheduled'), NOW - 28 * HOUR, 'admin');
  assigned.assignedByAdmin = admins.operations._id;
  out.audits.push({ admin: admins.operations, action: 'assign_driver', entity: 'booking', entityId: assigned._id, meta: { driverId: String(assigned.driver) }, at: NOW - 28 * HOUR });

  // Idle drivers waiting for work.
  goOnline(driverFor('scheduled'), NOW - MIN, jitter(indore[4], 1));
  goOnline(driverFor('idleA'), NOW - MIN, jitter(indore[2], 1));
  goOnline(driverFor('idleB'), NOW - 2 * MIN, jitter(indore[0], 1.5));
  goOnline(driverFor('bhopalIdle'), NOW - MIN, jitter(cities[1].places[0], 1));

  for (const booking of [accepted, arrived, hourly, mumbai, monthly, assigned]) countCoupon(booking);
  for (const booking of out.bookings.filter((item) => ['pending', 'searching'].includes(item.status))) countCoupon(booking);
  return { accepted, arrived, hourly, mumbai, monthly, assigned };
}

/* ------------------------------ run the timeline ------------------------------ */

const events = [];
for (let i = 0; i < 170; i += 1) {
  const at = NOW - 3 * HOUR - (rnd() ** 1.25) * (HISTORY_DAYS * DAY - 3 * HOUR);
  events.push({ at, run: () => historicBooking(at) });
}
for (let i = 0; i < 16; i += 1) {
  const at = NOW - int(1, HISTORY_DAYS) * DAY - int(0, 20) * HOUR;
  const customer = pick(out.customers);
  events.push({ at, run: () => topUp(customer, pick([500, 500, 1000, 1000, 2000]), at) });
}
events.sort((a, b) => a.at - b.at);
for (const event of events) event.run();

const live = liveBookings();

/* ------------------------------ money events after the trips ------------------------------ */

// Refunds: one full, one partial.
const refundable = completedBookings.filter((booking) => booking.paymentStatus === 'paid' && booking.paymentMethod !== 'cash' && booking.endedAt.getTime() < NOW - 3 * DAY);
const refunds = [refundable.at(-1), refundable.at(-6)].filter(Boolean).map((booking, index) => {
  const amount = index === 0 ? booking.fareFinal.total : Math.round(booking.fareFinal.total / 2);
  const note = index === 0 ? 'Driver arrived very late, full refund approved' : 'Partial refund for AC not working complaint';
  const at = booking.endedAt.getTime() + int(20, 44) * HOUR;
  booking.paymentStatus = 'refunded';
  move('customer', booking.customer, 'credit', amount, 'refund', `refund:${booking._id}`, at, { booking, note });
  out.audits.push({ admin: admins.finance, action: 'refund', entity: 'booking', entityId: booking._id, meta: { amount, note }, at });
  return { booking, amount, at };
});

// A goodwill credit and a correction, as the admin wallet screen would write them.
const adjust = (role, account, direction, amount, note, at) => {
  move(role, account._id, direction, amount, 'admin_adjustment', `admin:${admins.finance._id}:${Math.round(at)}:${account._id}`, at, { note });
  out.audits.push({ admin: admins.finance, action: `wallet_${direction}`, entity: role, entityId: account._id, meta: { amount, note }, at });
};
adjust('customer', out.customers[1], 'credit', 200, 'Goodwill credit for delayed pickup', NOW - 6 * DAY);
adjust('customer', out.customers[15], 'credit', 150, 'Compensation for app issue during booking', NOW - 12 * DAY);

// One driver deep in dues (cannot go online), and payouts waiting for finance.
const duesDriver = driverFor('dues');
const duesGap = balanceOf(duesDriver._id) - (settings.driverMinWalletBalance - 140);
if (duesGap > 0) adjust('driver', duesDriver, 'debit', duesGap, 'Penalty: three no-shows this month', NOW - 2 * DAY);

out.drivers
  .filter((driver) => driver !== duesDriver && driver.status === 'active' && balanceOf(driver._id) >= 300)
  .slice(0, 4)
  .forEach((driver) => requestPayout(driver, NOW - int(1, 20) * HOUR, { settle: false }));

/* ------------------------------ numbering ------------------------------ */

out.bookings.sort((a, b) => a.createdAt - b.createdAt);
for (const booking of out.bookings) booking.bookingNo = `DG${await nextSequence('booking')}`;
for (const tx of out.transactions) if (tx.bookingRef && !tx.note) tx.note = tx.bookingRef.bookingNo;

/* ------------------------------ ratings ------------------------------ */

const lowReviews = out.reviews.filter((item) => item.fromRole === 'customer' && item.rating === 1);
if (lowReviews[0]) {
  lowReviews[0].hidden = true;
  out.audits.push({ admin: admins.operations, action: 'update', entity: 'review', entityId: lowReviews[0]._id, meta: { hidden: true }, at: lowReviews[0].createdAt.getTime() + 5 * HOUR });
}
function applyRatings(accounts, field, fromRole) {
  for (const account of accounts) {
    const ratings = out.reviews.filter((item) => item.fromRole === fromRole && !item.hidden && item[field].equals(account._id)).map((item) => item.rating);
    account.ratingCount = ratings.length;
    account.rating = ratings.length ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 10) / 10 : 0;
  }
}
applyRatings(out.drivers, 'driver', 'customer');
applyRatings(out.customers, 'customer', 'driver');

/* ------------------------------ notifications ------------------------------ */

function notifyAt(role, recipient, title, body, type, at, data) {
  out.notifications.push({ role, recipient, title, body, type, data, createdAt: new Date(at), readAt: at < NOW - DAY || chance(0.3) ? new Date(at + int(2, 90) * MIN) : undefined });
}
for (const booking of completedBookings.filter((item) => item.endedAt.getTime() > NOW - 10 * DAY)) {
  notifyAt('customer', booking.customer, 'Trip completed', `Total fare ₹${booking.fareFinal.total}. Thank you for using Driver IN.`, 'booking', booking.endedAt.getTime(), { bookingId: String(booking._id) });
}
for (const booking of [live.accepted, live.arrived, live.hourly, live.mumbai, live.monthly, live.assigned]) {
  notifyAt('customer', booking.customer, 'Driver assigned', `${booking.ref.driver.name} is on the way. Share OTP ${booking.startOtp} only when the driver reaches you.`, 'booking', booking.acceptedAt.getTime(), { bookingId: String(booking._id) });
}
notifyAt('customer', live.arrived.customer, 'Driver has arrived', `Share OTP ${live.arrived.startOtp} to start your trip`, 'booking', live.arrived.arrivedAt.getTime(), { bookingId: String(live.arrived._id) });
notifyAt('driver', live.assigned.driver, 'Booking assigned', `${live.assigned.bookingNo} has been assigned to you`, 'booking', live.assigned.acceptedAt.getTime(), { bookingId: String(live.assigned._id) });
for (const { booking, amount, at } of refunds) {
  notifyAt('customer', booking.customer, 'Refund processed', `₹${amount} has been added to your wallet for ${booking.bookingNo}`, 'payment', at);
}
for (const payout of out.payouts.filter((item) => item.status !== 'requested')) {
  const paid = payout.status === 'paid';
  notifyAt('driver', payout.driver, paid ? 'Payout sent' : 'Payout rejected', paid ? `₹${payout.amount} has been transferred. Reference ${payout.reference}` : `₹${payout.amount} was returned to your wallet. ${payout.note}`, 'payment', payout.processedAt.getTime());
  out.audits.push({ admin: admins.finance, action: paid ? 'mark_paid' : 'reject', entity: 'payout', entityId: payout._id, meta: paid ? { reference: payout.reference } : { note: payout.note }, at: payout.processedAt.getTime() });
}
for (const driver of out.drivers) {
  if (driver.kycStatus === 'approved') {
    const at = driver.createdAt.getTime() + DAY;
    notifyAt('driver', driver._id, 'KYC approved', 'You can now go online and accept bookings.', 'kyc', at);
    if (at > NOW - 60 * DAY) out.audits.push({ admin: admins.operations, action: 'kyc_approved', entity: 'driver', entityId: driver._id, meta: {}, at });
  } else if (driver.kycStatus === 'rejected') {
    const at = driver.createdAt.getTime() + DAY;
    notifyAt('driver', driver._id, 'KYC rejected', `Reason: ${driver.kycRejectionReason}`, 'kyc', at);
    out.audits.push({ admin: admins.operations, action: 'document_rejected', entity: 'driver', entityId: driver._id, meta: { type: 'driving_license' }, at: at - 5 * MIN });
    out.audits.push({ admin: admins.operations, action: 'kyc_rejected', entity: 'driver', entityId: driver._id, meta: { reason: driver.kycRejectionReason }, at });
  }
}

const BROADCASTS = [
  ['customers', 'Festive offer is live', 'Use code SAVE20 and get 20% off on your next booking. Valid for a limited time.', 8 * DAY],
  ['drivers', 'Weekend incentive', 'Complete 8 trips this weekend and earn a ₹500 bonus in your wallet.', 4 * DAY],
  ['all', 'Scheduled maintenance', 'The app will be under maintenance on Sunday from 2 AM to 4 AM. Bookings already placed are not affected.', 30 * HOUR],
];
for (const [audience, title, body, ago] of BROADCASTS) {
  const at = NOW - ago;
  const recipients = [
    ...(audience !== 'drivers' ? out.customers.filter((item) => item.status === 'active').map((item) => ['customer', item._id]) : []),
    ...(audience !== 'customers' ? out.drivers.filter((item) => item.status === 'active').map((item) => ['driver', item._id]) : []),
  ];
  const broadcast = { _id: oid(), audience, title, body, recipientCount: recipients.length, sentBy: admins.content._id, createdAt: new Date(at) };
  out.broadcasts.push(broadcast);
  for (const [role, recipient] of recipients) notifyAt(role, recipient, title, body, 'broadcast', at);
  out.audits.push({ admin: admins.content, action: 'send', entity: 'broadcast', entityId: broadcast._id, meta: { audience, recipients: recipients.length }, at });
}

/* ------------------------------ support tickets and SOS ------------------------------ */

const lastTripOf = (customer) => completedBookings.filter((booking) => booking.customer.equals(customer._id)).at(-1);
const supportName = admins.support.name;
// [role, account, category, subject, status, days ago, linked booking, [from, text, hours after]...]
const TICKETS = [
  ['customer', out.customers[1], 'payment', 'Charged twice for my trip', 'in_progress', 1.2, lastTripOf(out.customers[1]),
    ['user', 'I paid online and the driver also collected cash from me. Please refund one payment.', 0],
    ['admin', 'Sorry for the trouble. We are checking with the driver and will update you within 24 hours.', 3]],
  ['customer', out.customers[5], 'driver', 'Driver arrived 30 minutes late', 'resolved', 9, lastTripOf(out.customers[5]),
    ['user', 'The driver reached half an hour late and I missed my appointment.', 0],
    ['admin', 'We apologise. The driver has been warned and ₹100 has been added to your wallet.', 5],
    ['user', 'Thank you for the quick action.', 7]],
  ['customer', out.customers[10], 'app', 'Unable to add a second car', 'open', 0.3, null,
    ['user', 'The app shows an error when I try to add my second car with registration MP09CD4521.', 0]],
  ['customer', out.customers[19], 'booking', 'Need GST invoice for outstation trip', 'closed', 20, lastTripOf(out.customers[19]),
    ['user', 'Please share a GST invoice for my Pune trip for office reimbursement.', 0],
    ['admin', 'The invoice has been emailed to your registered email address.', 20]],
  ['driver', out.drivers[5], 'payment', 'Payout not received yet', 'open', 0.6, null,
    ['user', 'I requested a payout two days ago and the amount has not reached my bank account.', 0]],
  ['driver', out.drivers[11], 'account', 'KYC rejected, need help', 'in_progress', 2, null,
    ['user', 'My KYC was rejected. I have uploaded the licence photo again, please check.', 0],
    ['admin', 'Please upload the front side of the licence in good light. The number must be readable.', 6]],
  ['customer', out.customers[16], 'account', 'Change my registered phone number', 'resolved', 14, null,
    ['user', 'I have a new number. How do I move my account and wallet balance to it?', 0],
    ['admin', 'Your account has been moved to the new number after verification. Please log in again.', 26]],
  ['driver', out.drivers[13], 'app', 'Location not updating in the app', 'open', 0.1, null,
    ['user', 'My location is stuck at the old place and I am not getting new bookings.', 0]],
  ['customer', out.customers[22], 'other', 'Monthly driver plan enquiry', 'open', 0.8, null,
    ['user', 'I need a driver for 10 hours a day for 3 months. Is there a discount on a longer plan?', 0]],
].sort((a, b) => b[5] - a[5]);

for (const [role, account, category, subject, status, daysAgo, booking, ...messages] of TICKETS) {
  const at = NOW - daysAgo * DAY;
  const ticket = {
    _id: oid(), ticketNo: `TK${await nextSequence('ticket')}`, role, raisedBy: account._id, raisedByName: account.name, raisedByPhone: account.phone,
    booking: booking?._id, category, subject, status, createdAt: new Date(at),
    messages: messages.map(([from, text, hours]) => ({ from, text, adminName: from === 'admin' ? supportName : undefined, at: new Date(Math.min(at + hours * HOUR, NOW - 5 * MIN)) })),
  };
  ticket.updatedAt = ticket.messages.at(-1).at;
  out.tickets.push(ticket);
  for (const message of ticket.messages.filter((item) => item.from === 'admin')) {
    notifyAt(role, account._id, `Reply on ${ticket.ticketNo}`, message.text.slice(0, 120), 'support', message.at.getTime(), { ticketId: String(ticket._id) });
  }
}

const [pickupLng, pickupLat] = live.hourly.pickup.location.coordinates;
out.sos.push({ booking: live.hourly._id, raisedByRole: 'customer', raisedBy: live.hourly.customer, lat: pickupLat + 0.012, lng: pickupLng - 0.008, message: 'Car has broken down on the bypass, need help', status: 'open', createdAt: new Date(NOW - 6 * MIN) });
[[completedBookings.at(-8), 'driver', 'Minor accident, no one is hurt', 'Called the driver and customer. Both safe, insurance team informed.'],
  [completedBookings.at(-30), 'customer', 'Driver is feeling unwell', 'Replacement driver sent, trip completed safely.']]
  .filter(([booking]) => booking)
  .forEach(([booking, raisedByRole, message, resolutionNote]) => {
    const at = booking.startedAt.getTime() + 20 * MIN;
    const [lng, lat] = booking.pickup.location.coordinates;
    const alert = { _id: oid(), booking: booking._id, raisedByRole, raisedBy: raisedByRole === 'customer' ? booking.customer : booking.driver, lat, lng, message, status: 'resolved', resolvedBy: admins.operations._id, resolutionNote, resolvedAt: new Date(at + 18 * MIN), createdAt: new Date(at), updatedAt: new Date(at + 18 * MIN) };
    out.sos.push(alert);
    out.audits.push({ admin: admins.operations, action: 'resolve', entity: 'sos', entityId: alert._id, meta: { note: resolutionNote }, at: at + 18 * MIN });
  });

/* ------------------------------ content and remaining audit trail ------------------------------ */

out.banners.push(
  { title: 'Outstation trips made easy', subtitle: 'Book a driver for 1 to 7 days. Use code OUTSTATION10', audience: 'customer', sortOrder: 1, createdAt: new Date(NOW - 20 * DAY) },
  { title: 'Earn more this month', subtitle: 'Complete 60 trips and get a ₹2,000 bonus', audience: 'driver', sortOrder: 2, createdAt: new Date(NOW - 15 * DAY) },
  { title: 'Refer a friend, earn ₹100', subtitle: 'Your friend gets ₹50 after the first trip', audience: 'all', sortOrder: 3, createdAt: new Date(NOW - 10 * DAY) },
  { title: 'Monsoon offer (ended)', subtitle: 'Flat ₹150 off on hourly bookings', audience: 'customer', sortOrder: 4, isActive: false, createdAt: new Date(NOW - 40 * DAY) },
);
for (const banner of out.banners) {
  banner._id = oid();
  out.audits.push({ admin: admins.content, action: 'create', entity: 'banner', entityId: banner._id, at: banner.createdAt.getTime() });
}
for (const coupon of await Coupon.find({ code: { $in: COUPONS.map((item) => item.code) } })) {
  out.audits.push({ admin: admins.content, action: 'create', entity: 'coupon', entityId: coupon._id, at: NOW - int(20, 44) * DAY });
}
out.audits.push(
  { admin: admins.operations, action: 'set_status', entity: 'driver', entityId: driverFor('suspended')._id, meta: { status: 'suspended', reason: 'Multiple complaints of rash driving' }, at: SUSPENDED_AT },
  { admin: admins.support, action: 'set_status', entity: 'customer', entityId: out.customers[BLOCKED_CUSTOMER]._id, meta: { status: 'blocked', reason: 'Repeated fake bookings' }, at: NOW - 7 * DAY },
  { admin: admins.super_admin, action: 'update', entity: 'settings', entityId: settings._id, meta: { commissionPercent: settings.commissionPercent, cancellationFee: settings.cancellationFee }, at: NOW - 30 * DAY },
  { admin: admins.super_admin, action: 'update', entity: 'settings', entityId: settings._id, meta: { supportPhone: '07314001234', supportEmail: 'support@driverin.example' }, at: NOW - HOUR },
  { admin: admins.finance, action: 'export', entity: 'bookings', meta: { rows: completedBookings.length }, at: NOW - 3 * DAY },
  { admin: admins.operations, action: 'view_document', entity: 'driver', entityId: out.drivers[10]._id, meta: { type: 'driving_license' }, at: NOW - 4 * HOUR },
);

/* ------------------------------ write ------------------------------ */

for (const account of [...out.customers, ...out.drivers]) account.walletBalance = balanceOf(account._id);

/** Validates through the Mongoose schema (defaults, casting, enums) and inserts with the back-dated timestamps. */
async function prepare(Model, items) {
  const rows = [];
  for (const { createdAt, updatedAt, ...item } of items) {
    const doc = new Model(item);
    await doc.validate();
    const row = doc.toObject({ depopulate: true });
    row.createdAt = createdAt || new Date(NOW);
    row.updatedAt = updatedAt || row.createdAt;
    row.__v = 0;
    rows.push(row);
  }
  return () => (rows.length ? Model.collection.insertMany(rows) : null);
}

const audits = out.audits
  .sort((a, b) => a.at - b.at)
  .map(({ admin, at, entityId, ...entry }) => ({ ...entry, admin: admin._id, adminName: admin.name, entityId: entityId ? String(entityId) : undefined, ip: '127.0.0.1', createdAt: new Date(Math.min(at, NOW)) }));

const writers = [
  await prepare(Customer, out.customers), await prepare(Car, out.cars), await prepare(Address, out.addresses),
  await prepare(Driver, out.drivers), await prepare(Booking, out.bookings), await prepare(Transaction, out.transactions),
  await prepare(PaymentOrder, out.orders), await prepare(Payout, out.payouts), await prepare(Review, out.reviews),
  await prepare(Ticket, out.tickets), await prepare(SosAlert, out.sos), await prepare(Notification, out.notifications),
  await prepare(Broadcast, out.broadcasts), await prepare(Banner, out.banners), await prepare(AuditLog, audits),
];

for (const { fileName, color } of files) fs.writeFileSync(privatePathFor(fileName), placeholderPng(color));
for (const write of writers) await write();
for (const coupon of coupons) await Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: couponUse.get(String(coupon._id)) || 0 } });
if (!settings.supportPhone) settings.supportPhone = '07314001234';
if (!settings.supportEmail) settings.supportEmail = 'support@driverin.example';
await settings.save();

const byStatus = out.bookings.reduce((counts, booking) => ({ ...counts, [booking.status]: (counts[booking.status] || 0) + 1 }), {});
console.log('Demo data added:');
console.table({
  customers: out.customers.length, cars: out.cars.length, addresses: out.addresses.length, drivers: out.drivers.length,
  bookings: out.bookings.length, transactions: out.transactions.length, paymentOrders: out.orders.length, payouts: out.payouts.length,
  reviews: out.reviews.length, tickets: out.tickets.length, sosAlerts: out.sos.length, notifications: out.notifications.length,
  broadcasts: out.broadcasts.length, banners: out.banners.length, auditLogs: audits.length, kycFiles: files.length,
});
console.log('Bookings by status:', byStatus);
console.log(`Customer logins (phone OTP): ${customerPhone(0)} to ${customerPhone(out.customers.length - 1)}`);
console.log(`Driver logins (phone OTP):   ${driverPhone(0)} to ${driverPhone(out.drivers.length - 1)}`);
await mongoose.disconnect();
