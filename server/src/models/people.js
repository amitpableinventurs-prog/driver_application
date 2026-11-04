import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name });

export const geoPoint = {
  type: { type: String, enum: ['Point'] },
  coordinates: { type: [Number], default: undefined },
};

const customerSchema = new Schema({
  name: { type: String, trim: true, default: '' },
  phone: { type: String, required: true, unique: true },
  email: { type: String, trim: true, lowercase: true },
  avatar: String,
  walletBalance: { type: Number, default: 0 },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: ref('Customer'),
  referralRewarded: { type: Boolean, default: false },
  rating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  totalBookings: { type: Number, default: 0 },
  deviceTokens: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'blocked', 'deleted'], default: 'active', index: true },
}, { timestamps: true });

const carSchema = new Schema({
  customer: { ...ref('Customer'), required: true, index: true },
  name: { type: String, required: true, trim: true },
  registrationNumber: { type: String, required: true, trim: true, uppercase: true },
  transmission: { type: String, enum: ['manual', 'automatic'], required: true },
  category: { type: String, enum: ['hatchback', 'sedan', 'suv', 'luxury'], required: true },
  fuel: { type: String, enum: ['petrol', 'diesel', 'cng', 'ev'], default: 'petrol' },
  isDefault: { type: Boolean, default: false },
  deletedAt: Date,
}, { timestamps: true });

const addressSchema = new Schema({
  customer: { ...ref('Customer'), required: true, index: true },
  label: { type: String, required: true, trim: true },
  address: { type: String, required: true, trim: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
}, { timestamps: true });

export const DOCUMENT_TYPES = ['driving_license', 'aadhaar', 'pan', 'police_verification', 'photo'];
export const REQUIRED_DOCUMENTS = ['driving_license', 'aadhaar', 'photo'];

const documentSchema = new Schema({
  type: { type: String, enum: DOCUMENT_TYPES, required: true },
  number: { type: String, trim: true },
  expiryDate: Date,
  fileName: { type: String, required: true },
  mimeType: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  rejectionReason: String,
  reviewedAt: Date,
}, { timestamps: true });

const driverSchema = new Schema({
  name: { type: String, trim: true, default: '' },
  phone: { type: String, required: true, unique: true },
  email: { type: String, trim: true, lowercase: true },
  avatar: String,
  dateOfBirth: Date,
  gender: { type: String, enum: ['male', 'female', 'other'] },
  address: String,
  city: ref('City'),
  languages: { type: [String], default: [] },
  experienceYears: { type: Number, default: 0 },
  transmissions: { type: [String], enum: ['manual', 'automatic'], default: ['manual'] },
  carCategories: { type: [String], enum: ['hatchback', 'sedan', 'suv', 'luxury'], default: ['hatchback', 'sedan'] },
  documents: { type: [documentSchema], default: [] },
  kycStatus: { type: String, enum: ['not_submitted', 'submitted', 'approved', 'rejected'], default: 'not_submitted', index: true },
  kycRejectionReason: String,
  bank: {
    accountHolder: String,
    accountNumber: String,
    ifsc: String,
    upiId: String,
  },
  isOnline: { type: Boolean, default: false, index: true },
  location: geoPoint,
  heading: Number,
  locationUpdatedAt: Date,
  activeBooking: ref('Booking'),
  acceptLockUntil: Date,
  walletBalance: { type: Number, default: 0 },
  rating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  totalTrips: { type: Number, default: 0 },
  cancelledTrips: { type: Number, default: 0 },
  deviceTokens: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
}, { timestamps: true });
driverSchema.index({ location: '2dsphere' });

const adminSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, required: true },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  lastLoginAt: Date,
}, { timestamps: true });

export const Customer = model('Customer', customerSchema);
export const Car = model('Car', carSchema);
export const Address = model('Address', addressSchema);
export const Driver = model('Driver', driverSchema);
export const Admin = model('Admin', adminSchema);
