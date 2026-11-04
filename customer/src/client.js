import { createClient } from '@shared/api.js';

export const api = createClient('driver-go-customer');

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: 'https://checkout.razorpay.com/v1/checkout.js' });
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the payment page'));
    document.head.append(script);
  });
}

/** Runs gateway checkout for an order, then confirms it with the API. */
export async function completePayment(order) {
  if (order.gateway === 'mock') {
    return api.post('/customer/payments/verify', { orderId: order.orderId, gatewayPaymentId: `mock_pay_${Date.now()}` });
  }
  await loadRazorpay();
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: order.keyId,
      order_id: order.gatewayOrderId,
      amount: order.amount * 100,
      currency: order.currency,
      name: 'Driver IN',
      handler: (result) => api.post('/customer/payments/verify', {
        orderId: order.orderId,
        gatewayPaymentId: result.razorpay_payment_id,
        signature: result.razorpay_signature,
      }).then(resolve, reject),
      modal: { ondismiss: () => reject(new Error('Payment was cancelled')) },
    });
    checkout.open();
  });
}
