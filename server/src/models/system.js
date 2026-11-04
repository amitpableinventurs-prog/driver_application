import mongoose from 'mongoose';
import { geoPoint } from './people.js';

const { Schema, model } = mongoose;
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name });

const citySchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  state: { type: String, required: true, trim: true },
  center: geoPoint,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const pricingSchema = new Schema({
  city: { ...ref('City'), required: true },
  bookingType: { type: String, enum: ['hourly', 'oneway', 'outstation', 'monthly'], required: true },
  baseFare: { type: Number, default: 0 },
  includedHours: { type: Number, default: 0 },
  extraHourRate: { type: Number, default: 0 },
  includedKm: { type: Number, default: 0 },
  perKmRate: { type: Number, default: 0 },
  returnAllowance: { type: Number, default: 0 },
  perDayRate: { type: Number, default: 0 },
  foodAllowancePerDay: { type: Number, default: 0 },
  stayAllowancePerNight: { type: Number, default: 0 },
  monthlyRate: { type: Number, default: 0 },
  nightCharge: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
pricingSchema.index({ city: 1, bookingType: 1 }, { unique: true });

const settingSchema = new Schema({
  key: { type: String, default: 'global', unique: true },
  commissionPercent: { type: Number, default: 20 },
  taxPercent: { type: Number, default: 5 },
  searchRadiusKm: { type: Number, default: 15 },
  maxDriversPerDispatch: { type: Number, default: 10 },
  searchTimeoutSeconds: { type: Number, default: 180 },
  dispatchLeadMinutes: { type: Number, default: 90 },
  minScheduleLeadMinutes: { type: Number, default: 30 },
  freeCancelMinutes: { type: Number, default: 3 },
  cancellationFee: { type: Number, default: 50 },
  cancellationDriverSharePercent: { type: Number, default: 80 },
  nightStartHour: { type: Number, default: 22 },
  nightEndHour: { type: Number, default: 6 },
  timezone: { type: String, default: 'Asia/Kolkata' },
  driverMinWalletBalance: { type: Number, default: -500 },
  minPayoutAmount: { type: Number, default: 200 },
  referralRewardReferrer: { type: Number, default: 100 },
  referralRewardReferee: { type: Number, default: 50 },
  supportPhone: { type: String, default: '' },
  supportEmail: { type: String, default: '' },
  sosPhone: { type: String, default: '112' },
}, { timestamps: true });

const bannerSchema = new Schema({
  title: { type: String, required: true, trim: true },
  subtitle: String,
  imageUrl: String,
  linkUrl: String,
  audience: { type: String, enum: ['customer', 'driver', 'all'], default: 'customer' },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const pageSchema = new Schema({
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  title: { type: String, required: true, trim: true },
  content: { type: String, default: '' },
  isPublished: { type: Boolean, default: true },
}, { timestamps: true });

const notificationSchema = new Schema({
  role: { type: String, enum: ['customer', 'driver'], required: true },
  recipient: { type: Schema.Types.ObjectId, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  type: { type: String, default: 'general' },
  data: Schema.Types.Mixed,
  readAt: Date,
}, { timestamps: true });
notificationSchema.index({ role: 1, recipient: 1, createdAt: -1 });

const broadcastSchema = new Schema({
  audience: { type: String, enum: ['customers', 'drivers', 'all'], required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  recipientCount: { type: Number, default: 0 },
  sentBy: ref('Admin'),
}, { timestamps: true });

const ticketSchema = new Schema({
  ticketNo: { type: String, required: true, unique: true },
  role: { type: String, enum: ['customer', 'driver'], required: true },
  raisedBy: { type: Schema.Types.ObjectId, required: true, index: true },
  raisedByName: String,
  raisedByPhone: String,
  booking: ref('Booking'),
  category: { type: String, enum: ['booking', 'payment', 'driver', 'app', 'account', 'other'], default: 'other' },
  subject: { type: String, required: true, trim: true },
  status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
  messages: {
    type: [{ from: { type: String, enum: ['user', 'admin'] }, text: String, adminName: String, at: { type: Date, default: Date.now } }],
    default: [],
  },
}, { timestamps: true });

const otpSchema = new Schema({
  phone: { type: String, required: true },
  role: { type: String, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
otpSchema.index({ phone: 1, role: 1 }, { unique: true });

const refreshTokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  role: { type: String, required: true },
  subject: { type: Schema.Types.ObjectId, required: true, index: true },
  family: { type: String, required: true, index: true },
  revokedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

const auditSchema = new Schema({
  admin: ref('Admin'),
  adminName: String,
  action: { type: String, required: true },
  entity: String,
  entityId: String,
  meta: Schema.Types.Mixed,
  ip: String,
}, { timestamps: true });
auditSchema.index({ createdAt: -1 });

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });

export const City = model('City', citySchema);
export const Pricing = model('Pricing', pricingSchema);
export const Setting = model('Setting', settingSchema);
export const Banner = model('Banner', bannerSchema);
export const Page = model('Page', pageSchema);
export const Notification = model('Notification', notificationSchema);
export const Broadcast = model('Broadcast', broadcastSchema);
export const Ticket = model('Ticket', ticketSchema);
export const Otp = model('Otp', otpSchema);
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
export const AuditLog = model('AuditLog', auditSchema);
export const Counter = model('Counter', counterSchema);

export async function nextSequence(name, start = 100000) {
  const counter = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return start + counter.seq;
}
