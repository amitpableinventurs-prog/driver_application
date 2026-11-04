import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name });

const transactionSchema = new Schema({
  ownerRole: { type: String, enum: ['customer', 'driver'], required: true },
  owner: { type: Schema.Types.ObjectId, required: true },
  direction: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true, min: 0 },
  balanceAfter: Number,
  category: {
    type: String,
    required: true,
    enum: ['topup', 'trip_payment', 'trip_earning', 'cash_commission', 'cancellation_fee', 'cancellation_compensation',
      'refund', 'referral_bonus', 'payout', 'payout_reversal', 'dues_payment', 'admin_adjustment'],
  },
  booking: ref('Booking'),
  note: String,
  // Unique key makes every money movement idempotent, so a retry can never double-credit.
  idempotencyKey: { type: String, required: true, unique: true },
}, { timestamps: true });
transactionSchema.index({ ownerRole: 1, owner: 1, createdAt: -1 });

const paymentOrderSchema = new Schema({
  ownerRole: { type: String, enum: ['customer', 'driver'], required: true },
  owner: { type: Schema.Types.ObjectId, required: true },
  purpose: { type: String, enum: ['wallet_topup', 'booking', 'driver_dues'], required: true },
  booking: ref('Booking'),
  amount: { type: Number, required: true },
  gateway: { type: String, required: true },
  gatewayOrderId: { type: String, required: true, unique: true },
  gatewayPaymentId: String,
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created', index: true },
}, { timestamps: true });

const payoutSchema = new Schema({
  driver: { ...ref('Driver'), required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['requested', 'paid', 'rejected'], default: 'requested', index: true },
  bankSnapshot: { accountHolder: String, accountNumber: String, ifsc: String, upiId: String },
  reference: String,
  note: String,
  processedBy: ref('Admin'),
  processedAt: Date,
}, { timestamps: true });

const couponSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  description: String,
  discountType: { type: String, enum: ['flat', 'percent'], required: true },
  value: { type: Number, required: true, min: 1 },
  maxDiscount: { type: Number, default: 0 },
  minFare: { type: Number, default: 0 },
  validFrom: { type: Date, required: true },
  validTo: { type: Date, required: true },
  usageLimit: { type: Number, default: 0 },
  perUserLimit: { type: Number, default: 1 },
  usedCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export const Transaction = model('Transaction', transactionSchema);
export const PaymentOrder = model('PaymentOrder', paymentOrderSchema);
export const Payout = model('Payout', payoutSchema);
export const Coupon = model('Coupon', couponSchema);
