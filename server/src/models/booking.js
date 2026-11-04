import mongoose from 'mongoose';
import { geoPoint } from './people.js';

const { Schema, model } = mongoose;
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name });

export const BOOKING_TYPES = ['hourly', 'oneway', 'outstation', 'monthly'];
export const PAYMENT_METHODS = ['cash', 'wallet', 'online'];
export const ACTIVE_STATUSES = ['pending', 'searching', 'accepted', 'arrived', 'in_progress'];

const placeSchema = new Schema({
  address: String,
  location: geoPoint,
}, { _id: false });

const fareSchema = new Schema({
  base: { type: Number, default: 0 },
  extraTime: { type: Number, default: 0 },
  extraDistance: { type: Number, default: 0 },
  allowances: { type: Number, default: 0 },
  nightCharge: { type: Number, default: 0 },
  subtotal: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  extraCharges: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
}, { _id: false });

const bookingSchema = new Schema({
  bookingNo: { type: String, required: true, unique: true },
  customer: { ...ref('Customer'), required: true, index: true },
  driver: { ...ref('Driver'), index: true },
  city: { ...ref('City'), required: true },
  car: ref('Car'),
  carSnapshot: { name: String, registrationNumber: String, transmission: String, category: String, fuel: String },
  type: { type: String, enum: BOOKING_TYPES, required: true },
  pickup: { type: placeSchema, required: true },
  drop: placeSchema,
  isInstant: { type: Boolean, default: true },
  scheduledAt: { type: Date, required: true, index: true },
  plannedEndAt: { type: Date, required: true },
  hours: Number,
  days: Number,
  hoursPerDay: Number,
  estimatedKm: Number,
  notes: String,
  status: {
    type: String,
    enum: [...ACTIVE_STATUSES, 'completed', 'cancelled', 'no_driver'],
    default: 'pending',
    index: true,
  },
  statusHistory: { type: [{ status: String, at: Date, by: String, _id: false }], default: [] },
  dispatchAt: Date,
  searchExpiresAt: Date,
  notifiedDrivers: [ref('Driver')],
  rejectedBy: [ref('Driver')],
  startOtp: { type: String, required: true },
  acceptedAt: Date,
  arrivedAt: Date,
  startedAt: Date,
  endedAt: Date,
  assignedByAdmin: ref('Admin'),
  fareEstimate: fareSchema,
  fareFinal: fareSchema,
  commission: { type: Number, default: 0 },
  driverEarning: { type: Number, default: 0 },
  coupon: ref('Coupon'),
  couponCode: String,
  paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'cash' },
  paymentStatus: { type: String, enum: ['unpaid', 'pending', 'paid', 'refunded'], default: 'unpaid', index: true },
  paidAt: Date,
  cancellation: { by: String, reason: String, fee: Number, at: Date },
}, { timestamps: true });
bookingSchema.index({ 'pickup.location': '2dsphere' });
bookingSchema.index({ status: 1, dispatchAt: 1 });
bookingSchema.index({ createdAt: -1 });
// Backstop for the in-code check: two parallel requests cannot create two live instant bookings.
bookingSchema.index(
  { customer: 1, isInstant: 1 },
  { unique: true, name: 'one_live_instant_booking', partialFilterExpression: { isInstant: true, status: { $in: ACTIVE_STATUSES } } },
);

const reviewSchema = new Schema({
  booking: { ...ref('Booking'), required: true },
  fromRole: { type: String, enum: ['customer', 'driver'], required: true },
  customer: { ...ref('Customer'), required: true },
  driver: { ...ref('Driver'), required: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true },
  hidden: { type: Boolean, default: false },
}, { timestamps: true });
reviewSchema.index({ booking: 1, fromRole: 1 }, { unique: true });

const sosSchema = new Schema({
  booking: { ...ref('Booking'), required: true },
  raisedByRole: { type: String, enum: ['customer', 'driver'], required: true },
  raisedBy: { type: Schema.Types.ObjectId, required: true },
  lat: Number,
  lng: Number,
  message: String,
  status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
  resolvedBy: ref('Admin'),
  resolutionNote: String,
  resolvedAt: Date,
}, { timestamps: true });

export const Booking = model('Booking', bookingSchema);
export const Review = model('Review', reviewSchema);
export const SosAlert = model('SosAlert', sosSchema);
