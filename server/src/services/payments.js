import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError, badRequest, notFound } from '../core/errors.js';
import { PaymentOrder } from '../models/index.js';
import { credit } from './wallet.js';
import { settleBooking } from './bookings.js';

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const hmacHex = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

async function createGatewayOrder(amount, receipt) {
  if (env.paymentGateway === 'mock') return `mock_${crypto.randomUUID()}`;
  const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt }),
  });
  if (!response.ok) throw new ApiError(502, 'GATEWAY_ERROR', 'Could not start the payment, please try again');
  return (await response.json()).id;
}

export async function createPaymentOrder({ ownerRole, owner, purpose, amount, booking }) {
  const receipt = crypto.randomUUID().replaceAll('-', '').slice(0, 30);
  const gatewayOrderId = await createGatewayOrder(amount, receipt);
  const order = await PaymentOrder.create({ ownerRole, owner, purpose, amount, booking, gateway: env.paymentGateway, gatewayOrderId });
  return {
    orderId: order._id,
    gateway: order.gateway,
    gatewayOrderId,
    amount,
    currency: 'INR',
    keyId: env.paymentGateway === 'razorpay' ? env.razorpayKeyId : undefined,
  };
}

async function applyPaidOrder(order, gatewayPaymentId) {
  const claimed = await PaymentOrder.findOneAndUpdate(
    { _id: order._id, status: 'created' },
    { status: 'paid', gatewayPaymentId },
    { returnDocument: 'after' },
  );
  if (!claimed) return order; // already applied by the client callback or the webhook

  const key = `order:${claimed._id}`;
  if (claimed.purpose === 'wallet_topup') {
    await credit({ role: claimed.ownerRole, ownerId: claimed.owner, amount: claimed.amount, category: 'topup', key, note: 'Wallet top-up' });
  } else if (claimed.purpose === 'driver_dues') {
    await credit({ role: 'driver', ownerId: claimed.owner, amount: claimed.amount, category: 'dues_payment', key, note: 'Dues payment' });
  } else if (claimed.purpose === 'booking') {
    await settleBooking(claimed.booking, 'online');
  }
  return claimed;
}

export async function verifyPayment({ ownerRole, owner, orderId, gatewayPaymentId, signature }) {
  const order = await PaymentOrder.findOne({ _id: orderId, ownerRole, owner });
  if (!order) throw notFound('Payment order not found');
  if (order.gateway === 'razorpay') {
    const expected = hmacHex(env.razorpayKeySecret, `${order.gatewayOrderId}|${gatewayPaymentId}`);
    if (!timingSafeEqualHex(expected, signature || '')) throw badRequest('Payment could not be verified', 'PAYMENT_SIGNATURE_INVALID');
  } else if (env.isProd) {
    throw badRequest('Payment could not be verified', 'PAYMENT_SIGNATURE_INVALID');
  }
  return applyPaidOrder(order, gatewayPaymentId);
}

/** Razorpay webhook: covers payments where the app closed before calling verify. */
export async function handleRazorpayWebhook(rawBody, signature) {
  if (!env.razorpayWebhookSecret) throw new ApiError(503, 'WEBHOOK_NOT_CONFIGURED', 'Webhook secret is not configured');
  const expected = hmacHex(env.razorpayWebhookSecret, rawBody);
  if (!timingSafeEqualHex(expected, signature || '')) throw badRequest('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID');
  const event = JSON.parse(rawBody.toString('utf8'));
  const payment = event?.payload?.payment?.entity;
  if (event.event !== 'payment.captured' || !payment?.order_id) return;
  const order = await PaymentOrder.findOne({ gatewayOrderId: payment.order_id });
  if (order && payment.amount === order.amount * 100) await applyPaidOrder(order, payment.id);
}
