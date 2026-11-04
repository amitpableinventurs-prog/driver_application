import crypto from 'node:crypto';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import {
  ACTIVE_STATUSES, Booking, Car, City, Coupon, Customer, Driver, Pricing, Review, nextSequence,
} from '../models/index.js';
import { calculateFare, roadKm, splitEarnings, travelMinutes } from './fare.js';
import { getSettings } from './settings.js';
import { credit, debit } from './wallet.js';
import { notify, sendPush } from './notify.js';
import { emitTo, rooms } from './realtime.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const NEAR_TERM_MS = HOUR;
const EARLIEST_ARRIVAL_MS = 2 * HOUR;
const MONTH_DAYS = 30;
const DRIVER_STALE_MS = 15 * MINUTE;

const toPoint = ({ address, lat, lng }) => ({ address, location: { type: 'Point', coordinates: [lng, lat] } });
const toLatLng = (place) => ({ lng: place.location.coordinates[0], lat: place.location.coordinates[1] });

/* ------------------------------ views ------------------------------ */

const INTERNAL_FIELDS = ['notifiedDrivers', 'rejectedBy', 'assignedByAdmin', 'dispatchAt', 'searchExpiresAt', '__v'];

export function customerView(booking) {
  const view = booking.toObject();
  INTERNAL_FIELDS.forEach((field) => delete view[field]);
  delete view.commission;
  delete view.driverEarning;
  // The customer reads this code out to the driver; it has no use once the trip has started.
  if (!['pending', 'searching', 'accepted', 'arrived'].includes(view.status)) delete view.startOtp;
  if (view.driver && !ACTIVE_STATUSES.includes(view.status)) {
    delete view.driver.phone;
    delete view.driver.location;
  }
  return view;
}

export function driverView(booking, { offer = false } = {}) {
  const view = booking.toObject();
  INTERNAL_FIELDS.forEach((field) => delete view[field]);
  delete view.startOtp; // the driver must get this from the customer, it proves they are together
  delete view.commission;
  delete view.couponCode;
  if (view.customer && typeof view.customer === 'object') {
    if (offer || !ACTIVE_STATUSES.includes(view.status)) delete view.customer.phone;
  }
  if (offer) view.customer = view.customer?.name ? { name: view.customer.name, rating: view.customer.rating } : undefined;
  return view;
}

function announce(booking) {
  const payload = { bookingId: String(booking._id), bookingNo: booking.bookingNo, status: booking.status };
  emitTo(rooms.customer(booking.customer._id || booking.customer), 'booking:updated', payload);
  if (booking.driver) emitTo(rooms.driver(booking.driver._id || booking.driver), 'booking:updated', payload);
  emitTo(rooms.booking(booking._id), 'booking:updated', payload);
  emitTo(rooms.admins, 'booking:updated', payload);
}

/** Atomic status change: only one concurrent caller can win a given transition. */
async function transition(filter, fromStatuses, to, set, by) {
  const booking = await Booking.findOneAndUpdate(
    { ...filter, status: { $in: fromStatuses } },
    { $set: { status: to, ...set }, $push: { statusHistory: { status: to, at: new Date(), by } } },
    { returnDocument: 'after' },
  );
  if (booking) announce(booking);
  return booking;
}

/* ------------------------------ coupons ------------------------------ */

export async function findCoupon(code, customerId, subtotal) {
  const coupon = await Coupon.findOne({ code: code.trim().toUpperCase(), isActive: true });
  const now = new Date();
  if (!coupon || coupon.validFrom > now || coupon.validTo < now) throw badRequest('This coupon is not valid', 'COUPON_INVALID');
  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) throw badRequest('This coupon has been fully used', 'COUPON_EXHAUSTED');
  if (subtotal < coupon.minFare) throw badRequest(`This coupon needs a minimum fare of ₹${coupon.minFare}`, 'COUPON_MIN_FARE');
  if (coupon.perUserLimit > 0) {
    const used = await Booking.countDocuments({ customer: customerId, coupon: coupon._id, status: { $nin: ['cancelled', 'no_driver'] } });
    if (used >= coupon.perUserLimit) throw badRequest('You have already used this coupon', 'COUPON_ALREADY_USED');
  }
  return coupon;
}

async function reserveCoupon(coupon) {
  const reserved = await Coupon.findOneAndUpdate(
    { _id: coupon._id, $or: [{ usageLimit: 0 }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
    { $inc: { usedCount: 1 } },
  );
  if (!reserved) throw badRequest('This coupon has been fully used', 'COUPON_EXHAUSTED');
}

const releaseCoupon = (booking) => (booking.coupon
  ? Coupon.updateOne({ _id: booking.coupon, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } })
  : null);

/* ------------------------------ quote & create ------------------------------ */

function planTrip(input, settings) {
  const { type } = input;
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  const trip = { scheduledAt, km: 0, minutes: 0, days: 1, hoursPerDay: 0 };

  if (type === 'hourly') {
    if (!input.hours) throw badRequest('hours is required for an hourly booking');
    trip.minutes = input.hours * 60;
  } else if (type === 'oneway') {
    if (!input.drop) throw badRequest('drop location is required for a one way booking');
    trip.km = roadKm(input.pickup, input.drop);
    trip.minutes = travelMinutes(trip.km);
  } else if (type === 'outstation') {
    if (!input.drop) throw badRequest('drop location is required for an outstation booking');
    if (!input.days) throw badRequest('days is required for an outstation booking');
    trip.km = roadKm(input.pickup, input.drop);
    trip.days = input.days;
    trip.minutes = input.days * 1440;
  } else if (type === 'monthly') {
    if (!input.hoursPerDay) throw badRequest('hoursPerDay is required for a monthly booking');
    trip.hoursPerDay = input.hoursPerDay;
    trip.days = MONTH_DAYS;
    trip.minutes = MONTH_DAYS * 1440;
  }

  trip.endAt = new Date(scheduledAt.getTime() + trip.minutes * MINUTE);
  trip.settings = settings;
  return trip;
}

async function loadPlan(cityId, type) {
  const city = await City.findOne({ _id: cityId, isActive: true });
  if (!city) throw badRequest('We do not serve this city yet', 'CITY_NOT_SERVICEABLE');
  const plan = await Pricing.findOne({ city: cityId, bookingType: type, isActive: true });
  if (!plan) throw badRequest(`${type} booking is not available in ${city.name}`, 'PLAN_NOT_AVAILABLE');
  return plan;
}

export async function quote(customerId, input) {
  const settings = await getSettings();
  const plan = await loadPlan(input.cityId, input.type);
  const trip = planTrip(input, settings);
  const fareArgs = { type: input.type, plan, settings, ...trip, startAt: trip.scheduledAt };
  let coupon = null;
  if (input.couponCode) {
    const { subtotal } = calculateFare(fareArgs);
    coupon = await findCoupon(input.couponCode, customerId, subtotal);
  }
  return { fare: calculateFare({ ...fareArgs, coupon }), km: trip.km, minutes: trip.minutes, trip, plan, coupon, settings };
}

export async function createBooking(customer, input) {
  const instant = !input.scheduledAt;
  if (instant && input.type === 'monthly') throw badRequest('Monthly bookings need a start date', 'SCHEDULE_REQUIRED');

  const { fare, km, trip, coupon, settings } = await quote(customer._id, input);
  const now = Date.now();
  if (!instant && trip.scheduledAt.getTime() < now + settings.minScheduleLeadMinutes * MINUTE) {
    throw badRequest(`Scheduled bookings must be at least ${settings.minScheduleLeadMinutes} minutes ahead`, 'SCHEDULE_TOO_SOON');
  }

  const car = await Car.findOne({ _id: input.carId, customer: customer._id, deletedAt: null });
  if (!car) throw badRequest('Please select one of your cars', 'CAR_NOT_FOUND');

  if (instant) {
    const busy = await Booking.exists({ customer: customer._id, isInstant: true, status: { $in: ACTIVE_STATUSES } });
    if (busy) throw conflict('You already have a booking in progress', 'BOOKING_IN_PROGRESS');
  }
  if (input.paymentMethod === 'wallet' && customer.walletBalance < fare.total) {
    throw badRequest('Insufficient wallet balance for this booking', 'INSUFFICIENT_BALANCE');
  }

  if (coupon) await reserveCoupon(coupon);

  const dispatchAt = instant ? new Date(now) : new Date(trip.scheduledAt.getTime() - settings.dispatchLeadMinutes * MINUTE);
  const dispatchNow = dispatchAt.getTime() <= now;
  const { commission, driverEarning } = splitEarnings(fare, settings);

  const booking = await Booking.create({
    bookingNo: `DG${await nextSequence('booking')}`,
    customer: customer._id,
    city: input.cityId,
    car: car._id,
    carSnapshot: { name: car.name, registrationNumber: car.registrationNumber, transmission: car.transmission, category: car.category, fuel: car.fuel },
    type: input.type,
    pickup: toPoint(input.pickup),
    drop: input.drop ? toPoint(input.drop) : undefined,
    isInstant: instant,
    scheduledAt: trip.scheduledAt,
    plannedEndAt: trip.endAt,
    hours: input.hours,
    days: input.type === 'outstation' ? input.days : undefined,
    hoursPerDay: input.hoursPerDay,
    estimatedKm: km,
    notes: input.notes,
    status: dispatchNow ? 'searching' : 'pending',
    statusHistory: [{ status: dispatchNow ? 'searching' : 'pending', at: new Date(), by: 'customer' }],
    dispatchAt,
    searchExpiresAt: searchDeadline(trip.scheduledAt, instant, settings),
    startOtp: String(crypto.randomInt(1000, 10000)),
    fareEstimate: fare,
    commission,
    driverEarning,
    coupon: coupon?._id,
    couponCode: coupon?.code,
    paymentMethod: input.paymentMethod,
  });

  emitTo(rooms.admins, 'booking:updated', { bookingId: String(booking._id), bookingNo: booking.bookingNo, status: booking.status });
  if (dispatchNow) await dispatch(booking, settings);
  return booking;
}

function searchDeadline(scheduledAt, instant, settings) {
  const timeout = Date.now() + settings.searchTimeoutSeconds * 1000;
  return new Date(instant ? timeout : Math.max(timeout, scheduledAt.getTime()));
}

/* ------------------------------ dispatch ------------------------------ */

export function eligibleDrivers(booking, settings, { exclude = [], limit = settings.maxDriversPerDispatch } = {}) {
  return Driver.find({
    _id: { $nin: exclude },
    status: 'active',
    kycStatus: 'approved',
    isOnline: true,
    activeBooking: null,
    walletBalance: { $gte: settings.driverMinWalletBalance },
    transmissions: booking.carSnapshot.transmission,
    carCategories: booking.carSnapshot.category,
    locationUpdatedAt: { $gte: new Date(Date.now() - DRIVER_STALE_MS) },
    location: {
      $near: { $geometry: booking.pickup.location, $maxDistance: settings.searchRadiusKm * 1000 },
    },
  }).limit(limit);
}

/** Offers the booking to every eligible driver not yet offered it. The first to accept wins. */
export async function dispatch(booking, settings) {
  const exclude = [...booking.notifiedDrivers, ...booking.rejectedBy];
  const drivers = await eligibleDrivers(booking, settings, { exclude });
  if (!drivers.length) return 0;
  await Booking.updateOne({ _id: booking._id }, { $addToSet: { notifiedDrivers: { $each: drivers.map((d) => d._id) } } });
  const offer = driverView(booking, { offer: true });
  for (const driver of drivers) {
    emitTo(rooms.driver(driver._id), 'booking:offer', offer);
    await sendPush('driver', driver._id, { title: 'New booking request', body: booking.pickup.address, data: { bookingId: String(booking._id) } });
  }
  return drivers.length;
}

export async function availableForDriver(driver) {
  if (!driver.location?.coordinates?.length) return [];
  const settings = await getSettings();
  const bookings = await Booking.find({
    status: 'searching',
    rejectedBy: { $ne: driver._id },
    'carSnapshot.transmission': { $in: driver.transmissions },
    'carSnapshot.category': { $in: driver.carCategories },
    'pickup.location': { $near: { $geometry: driver.location, $maxDistance: settings.searchRadiusKm * 1000 } },
  }).limit(20).populate('customer', 'name rating');
  return bookings.map((booking) => driverView(booking, { offer: true }));
}

/* ------------------------------ driver actions ------------------------------ */

async function ensureCanTake(driver, booking, settings, adminId) {
  if (!['pending', 'searching'].includes(booking.status)) throw conflict('This booking is no longer available', 'BOOKING_TAKEN');
  if (booking.rejectedBy.some((id) => id.equals(driver._id)) && !adminId) throw conflict('You already passed on this booking', 'BOOKING_REJECTED');
  const { transmission, category } = booking.carSnapshot;
  if (!driver.transmissions.includes(transmission) || !driver.carCategories.includes(category)) {
    throw badRequest(`Driver is not set up for ${transmission} ${category} cars`, 'DRIVER_SKILL_MISMATCH');
  }
  if (!adminId) {
    if (!driver.isOnline) throw badRequest('Go online to accept bookings', 'DRIVER_OFFLINE');
    if (driver.walletBalance < settings.driverMinWalletBalance) throw forbidden('Clear your wallet dues to accept bookings', 'DRIVER_DUES_PENDING');
  }
  const nearTerm = booking.scheduledAt.getTime() - Date.now() < NEAR_TERM_MS;
  if (nearTerm && driver.activeBooking) throw conflict('You already have an active booking', 'DRIVER_BUSY');
  const overlap = await Booking.exists({
    driver: driver._id,
    status: { $in: ['accepted', 'arrived', 'in_progress'] },
    scheduledAt: { $lt: booking.plannedEndAt },
    plannedEndAt: { $gt: booking.scheduledAt },
  });
  if (overlap) throw conflict('This overlaps with another booking', 'DRIVER_SCHEDULE_CONFLICT');
  return nearTerm;
}

export async function acceptBooking(driverId, bookingId, { adminId } = {}) {
  const now = new Date();
  // A short per-driver lock stops one driver winning two bookings in parallel.
  const driver = await Driver.findOneAndUpdate(
    { _id: driverId, status: 'active', kycStatus: 'approved', $or: [{ acceptLockUntil: null }, { acceptLockUntil: { $lt: now } }] },
    { acceptLockUntil: new Date(now.getTime() + 10000) },
  );
  if (!driver) throw conflict('Driver is not available right now', 'DRIVER_UNAVAILABLE');

  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw notFound('Booking not found');
    const settings = await getSettings();
    const nearTerm = await ensureCanTake(driver, booking, settings, adminId);

    const set = { driver: driver._id, acceptedAt: new Date() };
    if (adminId) set.assignedByAdmin = adminId;
    const updated = await transition({ _id: bookingId, driver: null }, ['pending', 'searching'], 'accepted', set, adminId ? 'admin' : 'driver');
    if (!updated) throw conflict('Another driver accepted this booking first', 'BOOKING_TAKEN');
    if (nearTerm) await Driver.updateOne({ _id: driver._id }, { activeBooking: updated._id });

    for (const other of updated.notifiedDrivers) {
      if (!other.equals(driver._id)) emitTo(rooms.driver(other), 'booking:offer_closed', { bookingId: String(updated._id) });
    }
    await notify('customer', updated.customer, {
      title: 'Driver assigned',
      body: `${driver.name || 'Your driver'} is on the way. Share OTP ${updated.startOtp} only when the driver reaches you.`,
      type: 'booking',
      data: { bookingId: String(updated._id) },
    });
    if (adminId) {
      await notify('driver', driver._id, { title: 'Booking assigned', body: `${updated.bookingNo} has been assigned to you`, type: 'booking', data: { bookingId: String(updated._id) } });
    }
    return updated;
  } finally {
    await Driver.updateOne({ _id: driver._id }, { acceptLockUntil: null });
  }
}

export async function rejectBooking(driver, bookingId) {
  const result = await Booking.updateOne({ _id: bookingId, status: 'searching' }, { $addToSet: { rejectedBy: driver._id } });
  if (!result.matchedCount) throw conflict('This booking is no longer available', 'BOOKING_TAKEN');
}

export async function markArrived(driver, bookingId) {
  const booking = await Booking.findOne({ _id: bookingId, driver: driver._id });
  if (!booking) throw notFound('Booking not found');
  if (booking.scheduledAt.getTime() - Date.now() > EARLIEST_ARRIVAL_MS) throw badRequest('This booking is scheduled for later', 'TOO_EARLY');
  const updated = await transition({ _id: bookingId, driver: driver._id }, ['accepted'], 'arrived', { arrivedAt: new Date() }, 'driver');
  if (!updated) throw conflict('Booking is not in the accepted state', 'INVALID_STATE');
  await notify('customer', updated.customer, { title: 'Driver has arrived', body: `Share OTP ${updated.startOtp} to start your trip`, type: 'booking', data: { bookingId: String(updated._id) } });
  return updated;
}

export async function startTrip(driver, bookingId, otp) {
  const booking = await Booking.findOne({ _id: bookingId, driver: driver._id });
  if (!booking) throw notFound('Booking not found');
  if (booking.status !== 'arrived') throw conflict('Mark yourself as arrived first', 'INVALID_STATE');
  if (booking.startOtp !== otp) throw badRequest('Incorrect trip OTP', 'TRIP_OTP_INVALID');

  const claimed = await Driver.findOneAndUpdate(
    { _id: driver._id, $or: [{ activeBooking: null }, { activeBooking: booking._id }] },
    { activeBooking: booking._id },
  );
  if (!claimed) throw conflict('Finish your current trip first', 'DRIVER_BUSY');

  const updated = await transition({ _id: bookingId, driver: driver._id }, ['arrived'], 'in_progress', { startedAt: new Date() }, 'driver');
  if (!updated) throw conflict('Trip could not be started', 'INVALID_STATE');
  await notify('customer', updated.customer, { title: 'Trip started', body: `Your trip ${updated.bookingNo} has started`, type: 'booking', data: { bookingId: String(updated._id) } });
  return updated;
}

function finalFare(booking, plan, settings, { extraCharges, end, coupon }) {
  const endAt = new Date();
  const minutes = Math.floor((endAt - booking.startedAt) / MINUTE); // a part minute is never billed
  let km = booking.estimatedKm || 0;
  if (booking.type === 'oneway' && end) km = roadKm(toLatLng(booking.pickup), end);
  const days = booking.type === 'outstation' ? Math.max(booking.days, Math.ceil(minutes / 1440)) : 1;
  const fare = calculateFare({
    type: booking.type, plan, settings, minutes, km, days,
    hoursPerDay: booking.hoursPerDay, startAt: booking.startedAt, endAt, coupon, extraCharges,
  });
  return { fare, endAt, km };
}

export async function endTrip(driver, bookingId, { extraCharges = 0, lat, lng }) {
  const booking = await Booking.findOne({ _id: bookingId, driver: driver._id, status: 'in_progress' });
  if (!booking) throw conflict('This trip is not in progress', 'INVALID_STATE');
  const settings = await getSettings();
  const plan = await Pricing.findOne({ city: booking.city, bookingType: booking.type });
  const coupon = booking.coupon ? await Coupon.findById(booking.coupon) : null;
  const end = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const { fare, endAt, km } = finalFare(booking, plan, settings, { extraCharges, end, coupon });
  const { commission, driverEarning } = splitEarnings(fare, settings);

  const updated = await transition(
    { _id: bookingId, driver: driver._id },
    ['in_progress'],
    'completed',
    { endedAt: endAt, fareFinal: fare, commission, driverEarning, estimatedKm: km, paymentStatus: 'pending' },
    'driver',
  );
  if (!updated) throw conflict('This trip is not in progress', 'INVALID_STATE');

  await Driver.updateOne({ _id: driver._id }, { activeBooking: null, $inc: { totalTrips: 1 } });
  await Customer.updateOne({ _id: updated.customer }, { $inc: { totalBookings: 1 } });
  await collectPayment(updated);
  await rewardReferral(updated.customer);

  const finished = await Booking.findById(bookingId);
  await notify('customer', updated.customer, { title: 'Trip completed', body: `Total fare ₹${fare.total}. Thank you for using Driver IN.`, type: 'booking', data: { bookingId: String(updated._id) } });
  return finished;
}

/* ------------------------------ payment settlement ------------------------------ */

async function collectPayment(booking) {
  if (booking.paymentMethod === 'cash') return settleBooking(booking._id, 'cash');
  if (booking.paymentMethod === 'wallet') {
    try {
      await debit({
        role: 'customer', ownerId: booking.customer, amount: booking.fareFinal.total,
        category: 'trip_payment', key: `trip:${booking._id}:customer`, booking: booking._id, note: booking.bookingNo,
      });
      return settleBooking(booking._id, 'wallet');
    } catch (err) {
      if (err.code !== 'INSUFFICIENT_BALANCE') throw err;
      await Booking.updateOne({ _id: booking._id }, { paymentMethod: 'cash' });
      return settleBooking(booking._id, 'cash');
    }
  }
  return null; // online: stays pending until the customer pays or the driver collects cash
}

/** Moves a booking to paid exactly once and books the driver's side of the money. */
export async function settleBooking(bookingId, method) {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, paymentStatus: 'pending' },
    { paymentStatus: 'paid', paidAt: new Date(), paymentMethod: method },
    { returnDocument: 'after' },
  );
  if (!booking) return null;
  const common = { role: 'driver', ownerId: booking.driver, booking: booking._id, note: booking.bookingNo, key: `trip:${booking._id}:driver` };
  if (method === 'cash') {
    // The driver already holds the full fare in cash, so the wallet only records the difference.
    const owedToPlatform = booking.fareFinal.total - booking.driverEarning;
    if (owedToPlatform >= 0) await debit({ ...common, amount: owedToPlatform, category: 'cash_commission', allowNegative: true });
    else await credit({ ...common, amount: -owedToPlatform, category: 'trip_earning' });
  } else {
    await credit({ ...common, amount: booking.driverEarning, category: 'trip_earning' });
  }
  announce(booking);
  return booking;
}

export async function collectCash(driver, bookingId) {
  const booking = await Booking.findOne({ _id: bookingId, driver: driver._id, status: 'completed' });
  if (!booking) throw notFound('Booking not found');
  const settled = await settleBooking(bookingId, 'cash');
  if (!settled) throw conflict('This booking is already paid', 'ALREADY_PAID');
  return settled;
}

async function rewardReferral(customerId) {
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, referredBy: { $ne: null }, referralRewarded: false },
    { referralRewarded: true },
  );
  if (!customer) return;
  const settings = await getSettings();
  await credit({ role: 'customer', ownerId: customer._id, amount: settings.referralRewardReferee, category: 'referral_bonus', key: `referral:${customer._id}:referee`, note: 'Referral bonus' });
  await credit({ role: 'customer', ownerId: customer.referredBy, amount: settings.referralRewardReferrer, category: 'referral_bonus', key: `referral:${customer._id}:referrer`, note: 'Referral bonus' });
}

/* ------------------------------ cancellation ------------------------------ */

function cancellationFee(booking, settings) {
  if (!booking.acceptedAt) return 0;
  if (booking.scheduledAt.getTime() - Date.now() > NEAR_TERM_MS) return 0;
  const withinFreeWindow = Date.now() - booking.acceptedAt.getTime() <= settings.freeCancelMinutes * MINUTE;
  return booking.status === 'accepted' && withinFreeWindow ? 0 : settings.cancellationFee;
}

async function releaseDriver(booking) {
  if (booking.driver) await Driver.updateOne({ _id: booking.driver, activeBooking: booking._id }, { activeBooking: null });
}

export async function cancelByCustomer(customer, bookingId, reason) {
  const booking = await Booking.findOne({ _id: bookingId, customer: customer._id });
  if (!booking) throw notFound('Booking not found');
  const settings = await getSettings();
  const fee = cancellationFee(booking, settings);
  const cancelled = await transition(
    { _id: bookingId, customer: customer._id },
    ['pending', 'searching', 'accepted', 'arrived'],
    'cancelled',
    { cancellation: { by: 'customer', reason, fee: 0, at: new Date() } },
    'customer',
  );
  if (!cancelled) throw conflict('This booking can no longer be cancelled', 'INVALID_STATE');

  await releaseDriver(cancelled);
  await releaseCoupon(cancelled);

  // The fee is taken from wallet balance only, so a customer without balance is charged what is available.
  const fresh = await Customer.findById(customer._id).select('walletBalance');
  const charged = Math.min(fee, Math.max(0, fresh.walletBalance));
  if (charged > 0) {
    await debit({ role: 'customer', ownerId: customer._id, amount: charged, category: 'cancellation_fee', key: `cancel:${bookingId}:customer`, booking: bookingId, note: cancelled.bookingNo });
    await credit({ role: 'driver', ownerId: cancelled.driver, amount: Math.round((charged * settings.cancellationDriverSharePercent) / 100), category: 'cancellation_compensation', key: `cancel:${bookingId}:driver`, booking: bookingId, note: cancelled.bookingNo });
    await Booking.updateOne({ _id: bookingId }, { 'cancellation.fee': charged });
  }
  if (cancelled.driver) {
    await notify('driver', cancelled.driver, { title: 'Booking cancelled', body: `${cancelled.bookingNo} was cancelled by the customer`, type: 'booking', data: { bookingId: String(bookingId) } });
  }
  return Booking.findById(bookingId);
}

/** A driver backing out sends the booking back to search instead of failing the customer. */
export async function cancelByDriver(driver, bookingId, reason) {
  const settings = await getSettings();
  const current = await Booking.findOne({ _id: bookingId, driver: driver._id });
  if (!current) throw notFound('Booking not found');
  const now = new Date();
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, driver: driver._id, status: { $in: ['accepted', 'arrived'] } },
    {
      $set: { status: 'searching', searchExpiresAt: searchDeadline(current.scheduledAt, current.isInstant, settings), notifiedDrivers: [] },
      $unset: { driver: 1, acceptedAt: 1, arrivedAt: 1 },
      $addToSet: { rejectedBy: driver._id },
      $push: { statusHistory: { status: 'searching', at: now, by: `driver_cancelled: ${reason}` } },
    },
    { returnDocument: 'after' },
  );
  if (!booking) throw conflict('This booking can no longer be cancelled', 'INVALID_STATE');
  await Driver.updateOne({ _id: driver._id }, { $inc: { cancelledTrips: 1 } });
  await Driver.updateOne({ _id: driver._id, activeBooking: booking._id }, { activeBooking: null });
  announce(booking);
  await notify('customer', booking.customer, { title: 'Finding you another driver', body: 'Your driver had to cancel. We are assigning a new driver.', type: 'booking', data: { bookingId: String(booking._id) } });
  await dispatch(booking, settings);
  return booking;
}

export async function cancelByAdmin(admin, bookingId, reason) {
  const cancelled = await transition(
    { _id: bookingId },
    ACTIVE_STATUSES,
    'cancelled',
    { cancellation: { by: 'admin', reason, fee: 0, at: new Date() } },
    `admin:${admin.name}`,
  );
  if (!cancelled) throw conflict('This booking is already closed', 'INVALID_STATE');
  await releaseDriver(cancelled);
  await releaseCoupon(cancelled);
  await notify('customer', cancelled.customer, { title: 'Booking cancelled', body: `${cancelled.bookingNo} was cancelled: ${reason}`, type: 'booking', data: { bookingId: String(bookingId) } });
  if (cancelled.driver) await notify('driver', cancelled.driver, { title: 'Booking cancelled', body: `${cancelled.bookingNo} was cancelled by admin`, type: 'booking', data: { bookingId: String(bookingId) } });
  return cancelled;
}

/* ------------------------------ ratings ------------------------------ */

export async function refreshRating(role, id) {
  const fromRole = role === 'driver' ? 'customer' : 'driver';
  const [stats] = await Review.aggregate([
    { $match: { [role]: id, fromRole, hidden: false } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const Model = role === 'driver' ? Driver : Customer;
  await Model.updateOne({ _id: id }, { rating: stats ? Math.round(stats.average * 10) / 10 : 0, ratingCount: stats?.count || 0 });
}

export async function submitReview(fromRole, account, bookingId, { rating, comment }) {
  const owner = fromRole === 'customer' ? { customer: account._id } : { driver: account._id };
  const booking = await Booking.findOne({ _id: bookingId, ...owner, status: 'completed' });
  if (!booking) throw badRequest('You can rate only a completed trip', 'NOT_RATEABLE');
  const review = await Review.create({ booking: booking._id, fromRole, customer: booking.customer, driver: booking.driver, rating, comment });
  await refreshRating(fromRole === 'customer' ? 'driver' : 'customer', fromRole === 'customer' ? booking.driver : booking.customer);
  return review;
}

/* ------------------------------ background sweep ------------------------------ */

export async function runScheduledTick() {
  const settings = await getSettings();
  const now = new Date();

  const due = await Booking.find({ status: 'pending', dispatchAt: { $lte: now } }).limit(100);
  for (const booking of due) {
    const opened = await transition({ _id: booking._id }, ['pending'], 'searching', {}, 'system');
    if (opened) await dispatch(opened, settings);
  }

  const expired = await Booking.find({ status: 'searching', searchExpiresAt: { $lt: now } }).limit(100);
  for (const booking of expired) {
    const closed = await transition({ _id: booking._id }, ['searching'], 'no_driver', {}, 'system');
    if (!closed) continue;
    await releaseCoupon(closed);
    await notify('customer', closed.customer, { title: 'No driver available', body: `We could not find a driver for ${closed.bookingNo}. You were not charged.`, type: 'booking', data: { bookingId: String(closed._id) } });
  }

  // Drivers who came online after the first offer still get a chance at open bookings.
  const open = await Booking.find({ status: 'searching' }).limit(100);
  for (const booking of open) await dispatch(booking, settings);

  await Driver.updateMany(
    { isOnline: true, activeBooking: null, locationUpdatedAt: { $lt: new Date(now.getTime() - DRIVER_STALE_MS) } },
    { isOnline: false },
  );
}

export function startScheduler(intervalMs = 15000) {
  const timer = setInterval(() => runScheduledTick().catch((err) => console.error('[scheduler]', err)), intervalMs);
  timer.unref();
  return timer;
}
