const ROAD_FACTOR = 1.3;
const AVG_CITY_KMPH = 30;
const WORKING_DAYS_PER_MONTH = 26;

export function haversineKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Straight-line distance scaled to approximate road distance. */
export const roadKm = (a, b) => Math.round(haversineKm(a, b) * ROAD_FACTOR * 10) / 10;
export const travelMinutes = (km) => Math.ceil((km / AVG_CITY_KMPH) * 60);

export function hourInZone(date, timeZone) {
  const hour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(date);
  return Number(hour);
}

export function isNight(date, settings) {
  const hour = hourInZone(date, settings.timezone);
  const { nightStartHour: start, nightEndHour: end } = settings;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

export function couponDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  const raw = coupon.discountType === 'flat' ? coupon.value : (subtotal * coupon.value) / 100;
  const capped = coupon.maxDiscount > 0 ? Math.min(raw, coupon.maxDiscount) : raw;
  return Math.round(Math.min(capped, subtotal));
}

/**
 * Single source of truth for fares, used for the estimate and the final bill.
 * All amounts are whole rupees.
 */
export function calculateFare({ type, plan, settings, minutes = 0, km = 0, days = 1, hoursPerDay = 0, startAt, endAt, coupon, extraCharges = 0 }) {
  const fare = { base: 0, extraTime: 0, extraDistance: 0, allowances: 0, nightCharge: 0 };
  const includedMinutes = plan.includedHours * 60;

  if (type === 'hourly') {
    const extraMinutes = Math.ceil(Math.max(0, minutes - includedMinutes) / 15) * 15;
    fare.base = plan.baseFare;
    fare.extraTime = Math.round((extraMinutes / 60) * plan.extraHourRate);
  } else if (type === 'oneway') {
    const extraMinutes = Math.ceil(Math.max(0, minutes - includedMinutes) / 15) * 15;
    fare.base = plan.baseFare;
    fare.extraDistance = Math.round(Math.max(0, km - plan.includedKm) * plan.perKmRate);
    fare.extraTime = Math.round((extraMinutes / 60) * plan.extraHourRate);
    fare.allowances = plan.returnAllowance;
  } else if (type === 'outstation') {
    fare.base = plan.baseFare + days * plan.perDayRate;
    fare.allowances = days * plan.foodAllowancePerDay + Math.max(0, days - 1) * plan.stayAllowancePerNight;
  } else if (type === 'monthly') {
    fare.base = plan.monthlyRate;
    fare.extraTime = Math.round(Math.max(0, hoursPerDay - plan.includedHours) * plan.extraHourRate * WORKING_DAYS_PER_MONTH);
  }

  if ((type === 'hourly' || type === 'oneway') && (isNight(startAt, settings) || (endAt && isNight(endAt, settings)))) {
    fare.nightCharge = plan.nightCharge;
  }

  const subtotal = fare.base + fare.extraTime + fare.extraDistance + fare.allowances + fare.nightCharge;
  const discount = couponDiscount(coupon, subtotal);
  const tax = Math.round(((subtotal - discount) * settings.taxPercent) / 100);
  return { ...fare, subtotal, discount, tax, extraCharges, total: subtotal - discount + tax + extraCharges };
}

/** The platform funds coupons and keeps tax; the driver is paid on the pre-discount fare plus pass-through extras. */
export function splitEarnings(fare, settings) {
  const commission = Math.round((fare.subtotal * settings.commissionPercent) / 100);
  return { commission, driverEarning: fare.subtotal - commission + fare.extraCharges };
}
