import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/driver_go_test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';

const { default: mongoose } = await import('mongoose');
const { default: bcrypt } = await import('bcryptjs');
const { io: socketClient } = await import('socket.io-client');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const models = await import('../src/models/index.js');
const { runScheduledTick } = await import('../src/services/bookings.js');
const { initRealtime, closeRealtime } = await import('../src/services/realtime.js');
const { calculateFare, isNight, splitEarnings } = await import('../src/services/fare.js');
const { registry } = await import('../src/core/api.js');
const { buildOpenApi } = await import('../src/core/openapi.js');

const { Admin, Booking, City, Coupon, Customer, Driver, PaymentOrder, Pricing, Setting, Transaction } = models;

let server;
let base;
let cityId;
let phoneSeq = 7000000000;
const nextPhone = () => String(++phoneSeq);
const PICKUP = { address: 'Vijay Nagar, Indore', lat: 22.7533, lng: 75.8937 };
const DROP = { address: 'Rajwada, Indore', lat: 22.7186, lng: 75.8553 };

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path.startsWith('/') && !path.startsWith('/api') && !path.startsWith('/uploads') ? `/api/v1${path}` : path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, data: json?.data, code: json?.error?.code };
}

function expectOk(result, status = 200) {
  assert.equal(result.status, status, `expected ${status}, got ${result.status}: ${result.text.slice(0, 300)}`);
  return result.data;
}

async function login(role, phone = nextPhone(), extra = {}) {
  const sent = expectOk(await call('POST', '/auth/otp/send', { body: { phone, role } }));
  const session = expectOk(await call('POST', '/auth/otp/verify', { body: { phone, role, otp: sent.devOtp, ...extra } }));
  return { token: session.accessToken, refreshToken: session.refreshToken, id: session.user._id, user: session.user, phone };
}

async function adminLogin(email = 'super@test.dev') {
  const session = expectOk(await call('POST', '/auth/admin/login', { body: { email, password: 'Password@1' } }));
  return session.accessToken;
}

async function newCustomer(wallet = 0, extra) {
  const customer = await login('customer', nextPhone(), { name: 'Test Customer', ...extra });
  customer.car = expectOk(await call('POST', '/customer/cars', {
    token: customer.token,
    body: { name: 'Swift', registrationNumber: 'MP09AB1234', transmission: 'manual', category: 'hatchback' },
  }), 201);
  if (wallet) await Customer.updateOne({ _id: customer.id }, { walletBalance: wallet });
  return customer;
}

async function newDriver({ online = true } = {}) {
  const driver = await login('driver', nextPhone());
  await Driver.updateOne({ _id: driver.id }, {
    name: 'Test Driver',
    kycStatus: 'approved',
    transmissions: ['manual', 'automatic'],
    carCategories: ['hatchback', 'sedan', 'suv', 'luxury'],
  });
  if (online) expectOk(await call('POST', '/driver/status', { token: driver.token, body: { online: true, lat: PICKUP.lat, lng: PICKUP.lng } }));
  return driver;
}

const bookingBody = (customer, extra = {}) => ({
  type: 'hourly', cityId, carId: customer.car._id, pickup: PICKUP, hours: 4, paymentMethod: 'cash', ...extra,
});

async function book(customer, extra) {
  return expectOk(await call('POST', '/customer/bookings', { token: customer.token, body: bookingBody(customer, extra) }), 201);
}

/** Runs a booking through to in_progress, backdating the start so a final fare can be checked. */
async function startedTrip(customer, driver, extra) {
  const booking = await book(customer, extra);
  expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: driver.token }));
  expectOk(await call('POST', `/driver/bookings/${booking._id}/arrived`, { token: driver.token }));
  expectOk(await call('POST', `/driver/bookings/${booking._id}/start`, { token: driver.token, body: { otp: booking.startOtp } }));
  return booking;
}

const walletOf = async (Model, id) => (await Model.findById(id)).walletBalance;

before(async () => {
  await connectDb();
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(models).filter((m) => m?.modelName).map((m) => m.createIndexes()));
  await Setting.create({ key: 'global', timezone: 'Asia/Kolkata', nightStartHour: 0, nightEndHour: 0 });
  const passwordHash = await bcrypt.hash('Password@1', 4);
  await Admin.create([
    { name: 'Super', email: 'super@test.dev', role: 'super_admin', passwordHash },
    { name: 'Finance', email: 'finance@test.dev', role: 'finance', passwordHash },
  ]);
  const city = await City.create({ name: 'Indore', state: 'MP' });
  cityId = String(city._id);
  await Pricing.create([
    { city: city._id, bookingType: 'hourly', baseFare: 300, includedHours: 2, extraHourRate: 100, nightCharge: 100 },
    { city: city._id, bookingType: 'oneway', baseFare: 250, includedHours: 1, includedKm: 10, perKmRate: 12, extraHourRate: 100, returnAllowance: 100 },
    { city: city._id, bookingType: 'outstation', baseFare: 200, perDayRate: 1200, foodAllowancePerDay: 300, stayAllowancePerNight: 400 },
    { city: city._id, bookingType: 'monthly', includedHours: 8, extraHourRate: 60, monthlyRate: 22000 },
  ]);
  await Coupon.create({ code: 'SAVE50', discountType: 'flat', value: 50, validFrom: new Date(Date.now() - 1000), validTo: new Date(Date.now() + 86400000), usageLimit: 1, perUserLimit: 1 });

  server = http.createServer(createApp());
  initRealtime(server);
  await new Promise((resolve) => { server.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeRealtime();
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('fare engine', () => {
  const settings = { taxPercent: 5, commissionPercent: 20, timezone: 'Asia/Kolkata', nightStartHour: 22, nightEndHour: 6 };
  const plan = { baseFare: 300, includedHours: 2, extraHourRate: 100, nightCharge: 100, includedKm: 10, perKmRate: 12, returnAllowance: 100 };
  const noon = new Date('2026-01-10T06:30:00Z'); // 12:00 IST

  test('hourly fare bills extra time in 15 minute blocks', () => {
    const fare = calculateFare({ type: 'hourly', plan, settings, minutes: 140, startAt: noon, endAt: noon });
    assert.equal(fare.base, 300);
    assert.equal(fare.extraTime, 50); // 20 minutes over rounds up to 30 minutes
  });

  test('night window is evaluated in IST, not server time', () => {
    assert.equal(isNight(new Date('2026-01-10T17:00:00Z'), settings), true); // 22:30 IST
    assert.equal(isNight(new Date('2026-01-10T06:30:00Z'), settings), false); // 12:00 IST
    const fare = calculateFare({ type: 'hourly', plan, settings, minutes: 120, startAt: new Date('2026-01-10T17:00:00Z') });
    assert.equal(fare.nightCharge, 100);
  });

  test('tax applies after discount and the driver is paid on the pre-discount fare', () => {
    const coupon = { discountType: 'flat', value: 100, maxDiscount: 0 };
    const fare = calculateFare({ type: 'hourly', plan, settings, minutes: 120, startAt: noon, coupon, extraCharges: 40 });
    assert.deepEqual([fare.subtotal, fare.discount, fare.tax, fare.total], [300, 100, 10, 250]);
    assert.deepEqual(splitEarnings(fare, settings), { commission: 60, driverEarning: 280 });
  });

  test('a coupon can never push the fare below zero', () => {
    const fare = calculateFare({ type: 'hourly', plan, settings, minutes: 120, startAt: noon, coupon: { discountType: 'flat', value: 9999, maxDiscount: 0 } });
    assert.equal(fare.discount, 300);
    assert.equal(fare.total, 0);
  });
});

describe('authentication', () => {
  test('OTP login creates an account and rejects a wrong code', async () => {
    const phone = nextPhone();
    const sent = expectOk(await call('POST', '/auth/otp/send', { body: { phone, role: 'customer' } }));
    const wrong = sent.devOtp === '111111' ? '222222' : '111111';
    const bad = await call('POST', '/auth/otp/verify', { body: { phone, role: 'customer', otp: wrong } });
    assert.equal(bad.code, 'OTP_INVALID');
    const session = expectOk(await call('POST', '/auth/otp/verify', { body: { phone, role: 'customer', otp: sent.devOtp } }));
    assert.equal(session.isNewUser, true);
    assert.equal((await call('POST', '/auth/otp/verify', { body: { phone, role: 'customer', otp: sent.devOtp } })).code, 'OTP_EXPIRED');
  });

  test('OTP locks after five wrong attempts, even with the right code', async () => {
    const phone = nextPhone();
    const sent = expectOk(await call('POST', '/auth/otp/send', { body: { phone, role: 'customer' } }));
    const wrong = sent.devOtp === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) await call('POST', '/auth/otp/verify', { body: { phone, role: 'customer', otp: wrong } });
    const locked = await call('POST', '/auth/otp/verify', { body: { phone, role: 'customer', otp: sent.devOtp } });
    assert.equal(locked.code, 'OTP_EXPIRED');
  });

  test('OTP resend is rate limited', async () => {
    const phone = nextPhone();
    expectOk(await call('POST', '/auth/otp/send', { body: { phone, role: 'driver' } }));
    assert.equal((await call('POST', '/auth/otp/send', { body: { phone, role: 'driver' } })).status, 429);
  });

  test('refresh tokens rotate and replay kills the session', async () => {
    const customer = await login('customer');
    const first = expectOk(await call('POST', '/auth/refresh', { body: { refreshToken: customer.refreshToken } }));
    assert.notEqual(first.refreshToken, customer.refreshToken);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: customer.refreshToken } })).status, 401);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: first.refreshToken } })).status, 401);
  });

  test('a blocked customer loses access immediately', async () => {
    const customer = await login('customer');
    const token = await adminLogin();
    expectOk(await call('PATCH', `/admin/customers/${customer.id}/status`, { token, body: { status: 'blocked' } }));
    assert.equal((await call('GET', '/customer/me', { token: customer.token })).code, 'ACCOUNT_INACTIVE');
  });
});

describe('access control', () => {
  test('role tokens cannot cross APIs', async () => {
    const customer = await login('customer');
    const driver = await login('driver');
    assert.equal((await call('GET', '/driver/me', { token: customer.token })).status, 403);
    assert.equal((await call('GET', '/customer/me', { token: driver.token })).status, 403);
    assert.equal((await call('GET', '/admin/dashboard', { token: customer.token })).status, 403);
    assert.equal((await call('GET', '/admin/dashboard')).status, 401);
  });

  test('admin permissions follow the role', async () => {
    const finance = await adminLogin('finance@test.dev');
    expectOk(await call('GET', '/admin/payouts', { token: finance }));
    assert.equal((await call('GET', '/admin/drivers', { token: finance })).status, 403);
    assert.equal((await call('GET', '/admin/settings', { token: finance })).status, 403);
  });

  test("a customer cannot read another customer's booking or car", async () => {
    const owner = await newCustomer();
    const other = await newCustomer();
    const booking = await book(owner);
    assert.equal((await call('GET', `/customer/bookings/${booking._id}`, { token: other.token })).status, 404);
    assert.equal((await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: other.token, body: { reason: 'nope' } })).status, 404);
    assert.equal((await call('POST', '/customer/bookings', { token: other.token, body: bookingBody(other, { carId: owner.car._id }) })).code, 'CAR_NOT_FOUND');
    expectOk(await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: owner.token, body: { reason: 'done' } }));
  });

  test('malformed ids and bodies are rejected, not crashed on', async () => {
    const customer = await login('customer');
    assert.equal((await call('GET', '/customer/bookings/not-an-id', { token: customer.token })).code, 'INVALID_ID');
    assert.equal((await call('POST', '/auth/otp/send', { body: { phone: { $gt: '' }, role: 'customer' } })).code, 'VALIDATION_ERROR');
    assert.equal((await call('POST', '/auth/admin/login', { body: { email: 'a@b.co', password: { $ne: 1 } } })).code, 'VALIDATION_ERROR');
  });
});

describe('driver KYC', () => {
  test('upload, review and approval gate going online', async () => {
    const driver = await login('driver');
    const token = await adminLogin();
    const offline = await call('POST', '/driver/status', { token: driver.token, body: { online: true, lat: 22.7, lng: 75.8 } });
    assert.equal(offline.code, 'KYC_NOT_APPROVED');

    expectOk(await call('PATCH', '/driver/me', { token: driver.token, body: { name: 'Ravi', city: cityId } }));
    assert.equal((await call('POST', '/driver/kyc/submit', { token: driver.token })).code, 'DOCUMENTS_MISSING');

    for (const type of ['driving_license', 'aadhaar', 'photo']) {
      const form = new FormData();
      form.append('type', type);
      form.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'doc.pdf');
      expectOk(await call('POST', '/driver/documents', { token: driver.token, form }), 201);
    }
    expectOk(await call('POST', '/driver/kyc/submit', { token: driver.token }));

    const { driver: detail } = expectOk(await call('GET', `/admin/drivers/${driver.id}`, { token }));
    assert.equal((await call('POST', `/admin/drivers/${driver.id}/kyc`, { token, body: { decision: 'approved' } })).code, 'DOCUMENTS_NOT_APPROVED');

    const documentId = detail.documents[0]._id;
    assert.equal((await call('GET', `/admin/drivers/${driver.id}/documents/${documentId}/file`)).status, 401);
    const file = await call('GET', `/admin/drivers/${driver.id}/documents/${documentId}/file`, { token });
    assert.equal(file.status, 200);
    assert.match(file.text, /%PDF/);
    assert.equal((await call('GET', `/uploads/private/${detail.documents[0].fileName}`)).status, 404);

    for (const document of detail.documents) {
      expectOk(await call('PATCH', `/admin/drivers/${driver.id}/documents/${document._id}`, { token, body: { status: 'approved' } }));
    }
    expectOk(await call('POST', `/admin/drivers/${driver.id}/kyc`, { token, body: { decision: 'approved' } }));
    expectOk(await call('POST', '/driver/status', { token: driver.token, body: { online: true, lat: 22.7, lng: 75.8 } }));
    await call('POST', '/driver/status', { token: driver.token, body: { online: false } });
  });

  test('a driver API response never exposes stored file names', async () => {
    const driver = await login('driver');
    const form = new FormData();
    form.append('type', 'pan');
    form.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'a.png');
    const documents = expectOk(await call('POST', '/driver/documents', { token: driver.token, form }), 201);
    assert.equal(documents[0].fileName, undefined);
  });

  test('unsupported upload types are refused', async () => {
    const driver = await login('driver');
    const form = new FormData();
    form.append('type', 'pan');
    form.append('file', new Blob(['<script>'], { type: 'text/html' }), 'a.html');
    assert.equal((await call('POST', '/driver/documents', { token: driver.token, form })).code, 'UNSUPPORTED_FILE');
  });
});

describe('booking lifecycle and money', () => {
  test('cash trip: wallet math balances to the rupee', async () => {
    const customer = await newCustomer();
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver);
    await Booking.updateOne({ _id: booking._id }, { startedAt: new Date(Date.now() - 3 * 3600000) });

    const done = expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: { extraCharges: 50 } }));
    // 3h: 300 base + 100 extra hour = 400; tax 5% = 20; +50 parking = 470
    assert.equal(done.fareFinal.subtotal, 400);
    assert.equal(done.fareFinal.total, 470);
    assert.equal(done.amountToCollect, 470);
    assert.equal(done.paymentStatus, 'paid');
    assert.equal(done.driverEarning, 370); // 400 - 20% + 50

    // Driver holds 470 cash but earned 370, so the wallet owes the platform 100.
    assert.equal(await walletOf(Driver, driver.id), -100);
    const again = await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} });
    assert.equal(again.code, 'INVALID_STATE');
    assert.equal(await walletOf(Driver, driver.id), -100);
    assert.equal((await Driver.findById(driver.id)).activeBooking, null);
  });

  test('wallet trip debits the customer and credits the driver', async () => {
    const customer = await newCustomer(2000);
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver, { paymentMethod: 'wallet', hours: 2 });
    const done = expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
    assert.equal(done.paymentStatus, 'paid');
    assert.equal(await walletOf(Customer, customer.id), 2000 - 315);
    assert.equal(await walletOf(Driver, driver.id), 240);
    const ledger = await Transaction.find({ booking: booking._id });
    assert.equal(ledger.length, 2);
  });

  test('a wallet trip the balance cannot cover falls back to cash', async () => {
    const customer = await newCustomer(400);
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver, { paymentMethod: 'wallet', hours: 2 });
    await Customer.updateOne({ _id: customer.id }, { walletBalance: 10 });
    const done = expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
    assert.equal(done.paymentMethod, 'cash');
    assert.equal(await walletOf(Customer, customer.id), 10);
    assert.equal(await Transaction.countDocuments({ booking: booking._id, ownerRole: 'customer' }), 0);
  });

  test('online trip stays pending until paid, and paying twice credits once', async () => {
    const customer = await newCustomer();
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver, { paymentMethod: 'online', hours: 2 });
    const done = expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
    assert.equal(done.paymentStatus, 'pending');
    assert.equal(await walletOf(Driver, driver.id), 0);

    const order = expectOk(await call('POST', `/customer/bookings/${booking._id}/pay`, { token: customer.token }));
    const verify = { orderId: order.orderId, gatewayPaymentId: 'pay_123' };
    expectOk(await call('POST', '/customer/payments/verify', { token: customer.token, body: verify }));
    expectOk(await call('POST', '/customer/payments/verify', { token: customer.token, body: verify }));
    assert.equal(await walletOf(Driver, driver.id), 240);
    assert.equal((await call('POST', `/customer/bookings/${booking._id}/pay`, { token: customer.token })).code, 'NOT_PAYABLE');
    assert.equal((await call('POST', `/driver/bookings/${booking._id}/collect-cash`, { token: driver.token })).code, 'ALREADY_PAID');
  });

  test("someone else's payment order cannot be verified", async () => {
    const owner = await newCustomer();
    const attacker = await newCustomer();
    const order = expectOk(await call('POST', '/customer/wallet/topup', { token: owner.token, body: { amount: 500 } }));
    const stolen = await call('POST', '/customer/payments/verify', { token: attacker.token, body: { orderId: order.orderId, gatewayPaymentId: 'pay_x' } });
    assert.equal(stolen.status, 404);
    assert.equal(await walletOf(Customer, attacker.id), 0);
  });

  test('wallet top-up credits exactly once', async () => {
    const customer = await newCustomer();
    const order = expectOk(await call('POST', '/customer/wallet/topup', { token: customer.token, body: { amount: 500 } }));
    const verify = { orderId: order.orderId, gatewayPaymentId: 'pay_1' };
    await Promise.all([1, 2, 3].map(() => call('POST', '/customer/payments/verify', { token: customer.token, body: verify })));
    assert.equal(await walletOf(Customer, customer.id), 500);
    const wallet = expectOk(await call('GET', '/customer/wallet', { token: customer.token }));
    assert.equal(wallet.balance, 500);
    assert.equal(wallet.items[0].balanceAfter, 500);
  });

  test('the Razorpay webhook rejects forged signatures and applies once', async () => {
    const customer = await newCustomer();
    const order = expectOk(await call('POST', '/customer/wallet/topup', { token: customer.token, body: { amount: 300 } }));
    const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_w', order_id: order.gatewayOrderId, amount: 30000 } } } });
    const post = (signature) => fetch(`${base}/api/v1/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature }, body: payload });
    assert.equal((await post('forged')).status, 400);
    assert.equal(await walletOf(Customer, customer.id), 0);
    const signature = crypto.createHmac('sha256', 'whsec').update(payload).digest('hex');
    assert.equal((await post(signature)).status, 200);
    assert.equal((await post(signature)).status, 200);
    assert.equal(await walletOf(Customer, customer.id), 300);
    assert.equal((await PaymentOrder.findById(order.orderId)).status, 'paid');
  });

  test('the trip OTP is hidden from drivers and required to start', async () => {
    const customer = await newCustomer();
    const driver = await newDriver();
    const booking = await book(customer);
    const offers = expectOk(await call('GET', '/driver/bookings/available', { token: driver.token }));
    const offer = offers.find((item) => item._id === booking._id);
    assert.ok(offer, 'driver should see the nearby booking');
    assert.equal(offer.startOtp, undefined);
    assert.equal(offer.customer?.phone, undefined);

    const accepted = expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: driver.token }));
    assert.equal(accepted.startOtp, undefined);
    assert.equal(accepted.customer.phone, customer.phone);
    assert.equal(accepted.commission, undefined);

    assert.equal((await call('POST', `/driver/bookings/${booking._id}/start`, { token: driver.token, body: { otp: '0000' } })).code, 'INVALID_STATE');
    expectOk(await call('POST', `/driver/bookings/${booking._id}/arrived`, { token: driver.token }));
    const wrong = booking.startOtp === '1234' ? '4321' : '1234';
    assert.equal((await call('POST', `/driver/bookings/${booking._id}/start`, { token: driver.token, body: { otp: wrong } })).code, 'TRIP_OTP_INVALID');
    expectOk(await call('POST', `/driver/bookings/${booking._id}/start`, { token: driver.token, body: { otp: booking.startOtp } }));
    const seen = expectOk(await call('GET', `/customer/bookings/${booking._id}`, { token: customer.token }));
    assert.equal(seen.startOtp, undefined);
    expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
  });

  test('when drivers race for a booking exactly one wins', async () => {
    const customer = await newCustomer();
    const drivers = await Promise.all([newDriver(), newDriver(), newDriver(), newDriver()]);
    const booking = await book(customer);
    const results = await Promise.all(drivers.map((driver) => call('POST', `/driver/bookings/${booking._id}/accept`, { token: driver.token })));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.ok(results.filter((result) => result.status !== 200).every((result) => result.status === 409));
    await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'test over' } });
  });

  test('one driver cannot take two bookings at once', async () => {
    const driver = await newDriver();
    const [first, second] = await Promise.all([newCustomer(), newCustomer()]);
    const bookings = await Promise.all([book(first), book(second)]);
    const results = await Promise.all(bookings.map((b) => call('POST', `/driver/bookings/${b._id}/accept`, { token: driver.token })));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    await call('POST', `/customer/bookings/${bookings[0]._id}/cancel`, { token: first.token, body: { reason: 'test over' } });
    await call('POST', `/customer/bookings/${bookings[1]._id}/cancel`, { token: second.token, body: { reason: 'test over' } });
  });

  test('a customer cannot hold two live instant bookings, even in parallel', async () => {
    const customer = await newCustomer();
    const results = await Promise.all([1, 2, 3].map(() => call('POST', '/customer/bookings', { token: customer.token, body: bookingBody(customer) })));
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    const live = results.find((result) => result.status === 201).data;
    await call('POST', `/customer/bookings/${live._id}/cancel`, { token: customer.token, body: { reason: 'test over' } });
  });

  test('an offline or skill-mismatched driver cannot take a booking', async () => {
    const customer = await newCustomer();
    const booking = await book(customer);
    const offline = await newDriver({ online: false });
    assert.equal((await call('POST', `/driver/bookings/${booking._id}/accept`, { token: offline.token })).code, 'DRIVER_OFFLINE');
    const unskilled = await newDriver();
    await Driver.updateOne({ _id: unskilled.id }, { transmissions: ['automatic'] });
    assert.equal((await call('POST', `/driver/bookings/${booking._id}/accept`, { token: unskilled.token })).code, 'DRIVER_SKILL_MISMATCH');
    await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'test over' } });
  });

  test('a driver with heavy dues cannot go online or accept', async () => {
    const driver = await newDriver();
    await Driver.updateOne({ _id: driver.id }, { walletBalance: -501 });
    assert.equal((await call('POST', '/driver/status', { token: driver.token, body: { online: true, lat: 22.7, lng: 75.8 } })).code, 'DRIVER_DUES_PENDING');
  });
});

describe('coupons', () => {
  test('a coupon is consumed on booking and returned on cancel', async () => {
    const customer = await newCustomer();
    const other = await newCustomer();
    const booking = await book(customer, { couponCode: 'SAVE50', hours: 2 });
    assert.equal(booking.fareEstimate.discount, 50);
    assert.equal((await Coupon.findOne({ code: 'SAVE50' })).usedCount, 1);
    assert.equal((await call('POST', '/customer/estimate', { token: other.token, body: bookingBody(other, { couponCode: 'SAVE50' }) })).code, 'COUPON_EXHAUSTED');
    expectOk(await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'changed plan' } }));
    assert.equal((await Coupon.findOne({ code: 'SAVE50' })).usedCount, 0);
    expectOk(await call('POST', '/customer/estimate', { token: other.token, body: bookingBody(other, { couponCode: 'SAVE50' }) }));
  });
});

describe('cancellation', () => {
  test('free before a driver is assigned', async () => {
    const customer = await newCustomer(500);
    const booking = await book(customer);
    expectOk(await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'changed plan' } }));
    assert.equal(await walletOf(Customer, customer.id), 500);
  });

  test('after the driver arrives a fee is charged and the driver is compensated', async () => {
    const customer = await newCustomer(500);
    const driver = await newDriver();
    const booking = await book(customer);
    expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: driver.token }));
    expectOk(await call('POST', `/driver/bookings/${booking._id}/arrived`, { token: driver.token }));
    const cancelled = expectOk(await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'changed plan' } }));
    assert.equal(cancelled.cancellation.fee, 50);
    assert.equal(await walletOf(Customer, customer.id), 450);
    assert.equal(await walletOf(Driver, driver.id), 40);
    const fresh = await Driver.findById(driver.id);
    assert.equal(fresh.activeBooking, null);
  });

  test('a fee never drives a customer wallet negative', async () => {
    const customer = await newCustomer(20);
    const driver = await newDriver();
    const booking = await book(customer);
    expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: driver.token }));
    expectOk(await call('POST', `/driver/bookings/${booking._id}/arrived`, { token: driver.token }));
    expectOk(await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'changed plan' } }));
    assert.equal(await walletOf(Customer, customer.id), 0);
  });

  test('a trip in progress cannot be cancelled by the customer', async () => {
    const customer = await newCustomer();
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver);
    assert.equal((await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'nope' } })).code, 'INVALID_STATE');
    expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
  });

  test('a driver backing out returns the booking to search for someone else', async () => {
    const customer = await newCustomer();
    const first = await newDriver();
    const second = await newDriver();
    const booking = await book(customer);
    expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: first.token }));
    expectOk(await call('POST', `/driver/bookings/${booking._id}/cancel`, { token: first.token, body: { reason: 'flat tyre' } }));
    const seen = expectOk(await call('GET', `/customer/bookings/${booking._id}`, { token: customer.token }));
    assert.equal(seen.status, 'searching');
    assert.equal(seen.driver, undefined);
    assert.equal((await Driver.findById(first.id)).activeBooking, null);
    assert.equal((await call('POST', `/driver/bookings/${booking._id}/accept`, { token: first.token })).code, 'BOOKING_REJECTED');
    expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: second.token }));
    await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'test over' } });
  });

  test('admin can assign a driver manually and cancel without a fee', async () => {
    const token = await adminLogin();
    const customer = await newCustomer(500);
    const driver = await newDriver();
    const booking = await book(customer);
    const candidates = expectOk(await call('GET', `/admin/bookings/${booking._id}/candidates`, { token }));
    assert.ok(candidates.some((candidate) => candidate._id === driver.id));
    expectOk(await call('POST', `/admin/bookings/${booking._id}/assign`, { token, body: { driverId: driver.id } }));
    expectOk(await call('POST', `/admin/bookings/${booking._id}/cancel`, { token, body: { reason: 'customer called in' } }));
    assert.equal(await walletOf(Customer, customer.id), 500);
    assert.equal((await Driver.findById(driver.id)).activeBooking, null);
  });
});

describe('scheduling', () => {
  test('rejects a schedule too close to now, and instant monthly bookings', async () => {
    const customer = await newCustomer();
    const soon = new Date(Date.now() + 5 * 60000).toISOString();
    assert.equal((await call('POST', '/customer/bookings', { token: customer.token, body: bookingBody(customer, { scheduledAt: soon }) })).code, 'SCHEDULE_TOO_SOON');
    assert.equal((await call('POST', '/customer/bookings', { token: customer.token, body: bookingBody(customer, { type: 'monthly', hoursPerDay: 8 }) })).code, 'SCHEDULE_REQUIRED');
  });

  test('a future booking waits, opens at its dispatch time and expires with no driver', async () => {
    const customer = await newCustomer();
    const scheduledAt = new Date(Date.now() + 5 * 3600000).toISOString();
    const booking = await book(customer, { scheduledAt });
    assert.equal(booking.status, 'pending');
    await runScheduledTick();
    assert.equal((await Booking.findById(booking._id)).status, 'pending');

    await Booking.updateOne({ _id: booking._id }, { dispatchAt: new Date(Date.now() - 1000) });
    await runScheduledTick();
    assert.equal((await Booking.findById(booking._id)).status, 'searching');

    await Booking.updateOne({ _id: booking._id }, { searchExpiresAt: new Date(Date.now() - 1000) });
    await runScheduledTick();
    assert.equal((await Booking.findById(booking._id)).status, 'no_driver');
  });

  test('overlapping scheduled bookings are refused for one driver', async () => {
    const driver = await newDriver();
    const [first, second] = await Promise.all([newCustomer(), newCustomer()]);
    const scheduledAt = new Date(Date.now() + 20 * 3600000).toISOString();
    const a = await book(first, { scheduledAt });
    const b = await book(second, { scheduledAt });
    await Booking.updateMany({ _id: { $in: [a._id, b._id] } }, { status: 'searching' });
    expectOk(await call('POST', `/driver/bookings/${a._id}/accept`, { token: driver.token }));
    assert.equal((await call('POST', `/driver/bookings/${b._id}/accept`, { token: driver.token })).code, 'DRIVER_SCHEDULE_CONFLICT');
    assert.equal((await call('POST', `/driver/bookings/${a._id}/arrived`, { token: driver.token })).code, 'TOO_EARLY');
    await call('POST', `/customer/bookings/${a._id}/cancel`, { token: first.token, body: { reason: 'test over' } });
    await call('POST', `/customer/bookings/${b._id}/cancel`, { token: second.token, body: { reason: 'test over' } });
  });

  test('all four booking types price correctly', async () => {
    const customer = await newCustomer();
    const estimate = async (extra) => expectOk(await call('POST', '/customer/estimate', { token: customer.token, body: { cityId, pickup: PICKUP, ...extra } }));
    assert.equal((await estimate({ type: 'hourly', hours: 4 })).fare.subtotal, 500);
    const oneway = await estimate({ type: 'oneway', drop: DROP });
    assert.ok(oneway.estimatedKm > 5 && oneway.estimatedKm < 12, `km was ${oneway.estimatedKm}`);
    const outstation = await estimate({ type: 'outstation', drop: DROP, days: 3 });
    assert.equal(outstation.fare.subtotal, 200 + 3 * 1200 + 3 * 300 + 2 * 400);
    const monthly = await estimate({ type: 'monthly', hoursPerDay: 10, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(monthly.fare.subtotal, 22000 + 2 * 60 * 26);
    assert.equal((await call('POST', '/customer/estimate', { token: customer.token, body: { cityId, pickup: PICKUP, type: 'oneway' } })).status, 400);
  });
});

describe('payouts', () => {
  test('held on request, returned on rejection, final on payment', async () => {
    const token = await adminLogin();
    const driver = await newDriver({ online: false });
    await Driver.updateOne({ _id: driver.id }, { walletBalance: 1000 });
    assert.equal((await call('POST', '/driver/payouts', { token: driver.token, body: { amount: 500 } })).code, 'BANK_MISSING');
    expectOk(await call('PATCH', '/driver/me/bank', { token: driver.token, body: { accountHolder: 'Ravi', accountNumber: '123456789012', ifsc: 'HDFC0001234' } }));
    assert.equal((await call('POST', '/driver/payouts', { token: driver.token, body: { amount: 50 } })).code, 'PAYOUT_TOO_LOW');
    assert.equal((await call('POST', '/driver/payouts', { token: driver.token, body: { amount: 5000 } })).code, 'INSUFFICIENT_BALANCE');
    assert.equal(await walletOf(Driver, driver.id), 1000);

    const first = expectOk(await call('POST', '/driver/payouts', { token: driver.token, body: { amount: 600 } }), 201);
    assert.equal(await walletOf(Driver, driver.id), 400);
    assert.equal((await call('POST', '/driver/payouts', { token: driver.token, body: { amount: 200 } })).code, 'PAYOUT_PENDING');

    expectOk(await call('POST', `/admin/payouts/${first._id}/reject`, { token, body: { note: 'wrong ifsc' } }));
    assert.equal(await walletOf(Driver, driver.id), 1000);
    assert.equal((await call('POST', `/admin/payouts/${first._id}/mark-paid`, { token, body: { reference: 'UTR123' } })).code, 'PAYOUT_PROCESSED');

    const second = expectOk(await call('POST', '/driver/payouts', { token: driver.token, body: { amount: 300 } }), 201);
    expectOk(await call('POST', `/admin/payouts/${second._id}/mark-paid`, { token, body: { reference: 'UTR124' } }));
    assert.equal((await call('POST', `/admin/payouts/${second._id}/reject`, { token, body: { note: 'too late' } })).code, 'PAYOUT_PROCESSED');
    assert.equal(await walletOf(Driver, driver.id), 700);
  });
});

describe('ratings, referral and refunds', () => {
  test('rating updates the average, once per side, and hiding removes it', async () => {
    const token = await adminLogin();
    const customer = await newCustomer();
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver);
    assert.equal((await call('POST', `/customer/bookings/${booking._id}/rate`, { token: customer.token, body: { rating: 5 } })).code, 'NOT_RATEABLE');
    expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
    const review = expectOk(await call('POST', `/customer/bookings/${booking._id}/rate`, { token: customer.token, body: { rating: 4, comment: 'Good' } }), 201);
    assert.equal((await call('POST', `/customer/bookings/${booking._id}/rate`, { token: customer.token, body: { rating: 1 } })).status, 409);
    expectOk(await call('POST', `/driver/bookings/${booking._id}/rate`, { token: driver.token, body: { rating: 5 } }), 201);
    assert.equal((await Driver.findById(driver.id)).rating, 4);
    assert.equal((await Customer.findById(customer.id)).rating, 5);
    expectOk(await call('PATCH', `/admin/reviews/${review._id}`, { token, body: { hidden: true } }));
    assert.equal((await Driver.findById(driver.id)).ratingCount, 0);
  });

  test('referral pays both sides once, after the first completed trip', async () => {
    const referrer = await newCustomer();
    const code = (await Customer.findById(referrer.id)).referralCode;
    const friend = await newCustomer(0, { referralCode: code });
    const driver = await newDriver();
    for (let i = 0; i < 2; i += 1) {
      const booking = await startedTrip(friend, driver, { hours: 2 });
      expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
    }
    assert.equal(await walletOf(Customer, referrer.id), 100);
    assert.equal(await walletOf(Customer, friend.id), 50);
  });

  test('a paid booking refunds to the wallet once', async () => {
    const token = await adminLogin();
    const customer = await newCustomer();
    const driver = await newDriver();
    const booking = await startedTrip(customer, driver, { hours: 2 });
    expectOk(await call('POST', `/driver/bookings/${booking._id}/end`, { token: driver.token, body: {} }));
    expectOk(await call('POST', `/admin/bookings/${booking._id}/refund`, { token, body: { amount: 100, note: 'service issue' } }));
    assert.equal((await call('POST', `/admin/bookings/${booking._id}/refund`, { token, body: { note: 'again' } })).code, 'NOT_REFUNDABLE');
    assert.equal(await walletOf(Customer, customer.id), 100);
  });
});

describe('admin operations', () => {
  test('dashboard, reports, csv export and lists respond', async () => {
    const token = await adminLogin();
    const dashboard = expectOk(await call('GET', '/admin/dashboard', { token }));
    assert.ok(dashboard.counts.customers > 0);
    assert.equal(dashboard.trend.length >= 14, true);
    assert.ok(dashboard.today.completed > 0, 'today should include completed trips');
    expectOk(await call('GET', '/admin/reports/revenue', { token }));
    const csv = await call('GET', '/admin/bookings/export', { token });
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^Booking,Created/);
    for (const path of ['customers', 'drivers', 'drivers/live', 'bookings', 'transactions', 'payouts', 'tickets', 'sos', 'reviews', 'cities', 'pricing', 'coupons', 'banners', 'pages', 'broadcasts', 'admins', 'roles', 'audit-logs', 'settings']) {
      expectOk(await call('GET', `/admin/${path}`, { token }));
    }
    const search = expectOk(await call('GET', '/admin/bookings?search=(((', { token }));
    assert.equal(search.total, 0);
  });

  test('patching one field leaves the rest of a pricing plan intact', async () => {
    const token = await adminLogin();
    const plan = await Pricing.findOne({ bookingType: 'oneway' });
    expectOk(await call('PATCH', `/admin/pricing/${plan._id}`, { token, body: { baseFare: 260 } }));
    const fresh = await Pricing.findById(plan._id);
    assert.equal(fresh.baseFare, 260);
    assert.equal(fresh.perKmRate, 12);
    assert.equal(fresh.includedKm, 10);
    await Pricing.updateOne({ _id: plan._id }, { baseFare: 250 });
  });

  test('settings update is validated and audited', async () => {
    const token = await adminLogin();
    assert.equal((await call('PUT', '/admin/settings', { token, body: { commissionPercent: 500 } })).status, 400);
    expectOk(await call('PUT', '/admin/settings', { token, body: { supportPhone: '1800123456' } }));
    assert.equal(expectOk(await call('GET', '/common/config')).supportPhone, '1800123456');
    const logs = expectOk(await call('GET', '/admin/audit-logs?entity=settings', { token }));
    assert.ok(logs.total >= 1);
  });

  test('an admin cannot demote or disable themselves', async () => {
    const token = await adminLogin();
    const admin = await Admin.findOne({ email: 'super@test.dev' });
    assert.equal((await call('PATCH', `/admin/admins/${admin._id}`, { token, body: { status: 'disabled' } })).code, 'SELF_CHANGE');
  });

  test('admin responses never contain password hashes or trip OTPs', async () => {
    const token = await adminLogin();
    const admins = await call('GET', '/admin/admins', { token });
    assert.ok(!admins.text.includes('passwordHash'));
    const created = await call('POST', '/admin/admins', { token, body: { name: 'New', email: 'new@test.dev', password: 'Password@2', role: 'support' } });
    assert.ok(!created.text.includes('passwordHash'));
    const bookings = await call('GET', '/admin/bookings', { token });
    assert.ok(!bookings.text.includes('startOtp'));
  });

  test('broadcast reaches users, ticket conversation works, SOS reaches admin', async () => {
    const token = await adminLogin();
    const customer = await newCustomer();
    const sent = expectOk(await call('POST', '/admin/broadcasts', { token, body: { audience: 'customers', title: 'Hello', body: 'Offer inside' } }), 201);
    assert.ok(sent.recipientCount > 0);
    const inbox = expectOk(await call('GET', '/customer/notifications', { token: customer.token }));
    assert.equal(inbox.unread, 1);
    expectOk(await call('POST', '/customer/notifications/read', { token: customer.token, body: {} }));
    assert.equal(expectOk(await call('GET', '/customer/notifications', { token: customer.token })).unread, 0);

    const ticket = expectOk(await call('POST', '/customer/tickets', { token: customer.token, body: { subject: 'Refund', message: 'Please help' } }), 201);
    expectOk(await call('POST', `/admin/tickets/${ticket._id}/reply`, { token, body: { text: 'Looking into it' } }));
    const thread = expectOk(await call('GET', `/customer/tickets/${ticket._id}`, { token: customer.token }));
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.status, 'in_progress');

    const booking = await book(customer);
    const sos = expectOk(await call('POST', `/customer/bookings/${booking._id}/sos`, { token: customer.token, body: { lat: 22.7, lng: 75.8 } }), 201);
    expectOk(await call('POST', `/admin/sos/${sos.alert._id}/resolve`, { token, body: { resolutionNote: 'Called customer' } }));
    await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'test over' } });
  });

  test('account deletion anonymises the customer and frees the phone number', async () => {
    const customer = await newCustomer();
    expectOk(await call('DELETE', '/customer/me', { token: customer.token }));
    assert.equal((await call('GET', '/customer/me', { token: customer.token })).status, 403);
    const again = await login('customer', customer.phone);
    assert.notEqual(again.id, customer.id);
  });
});

describe('realtime', () => {
  const connect = (token) => new Promise((resolve, reject) => {
    const socket = socketClient(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
  const nextEvent = (socket, event) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 3000);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });

  test('a bad token cannot connect', async () => {
    await assert.rejects(connect('garbage'));
  });

  test('live offer, status updates and driver location reach the right people', async () => {
    const customer = await newCustomer();
    const driver = await newDriver();
    const outsider = await newCustomer();
    const [customerSocket, driverSocket, outsiderSocket] = await Promise.all([connect(customer.token), connect(driver.token), connect(outsider.token)]);
    try {
      const offerPromise = nextEvent(driverSocket, 'booking:offer');
      const booking = await book(customer);
      const offer = await offerPromise;
      assert.equal(offer._id, booking._id);
      assert.equal(offer.startOtp, undefined);

      const update = nextEvent(customerSocket, 'booking:updated');
      expectOk(await call('POST', `/driver/bookings/${booking._id}/accept`, { token: driver.token }));
      assert.equal((await update).status, 'accepted');

      assert.deepEqual(await customerSocket.emitWithAck('booking:join', { bookingId: booking._id }), { ok: true });
      assert.deepEqual(await outsiderSocket.emitWithAck('booking:join', { bookingId: booking._id }), { ok: false });

      let leaked = false;
      outsiderSocket.on('driver:location', () => { leaked = true; });
      const location = nextEvent(customerSocket, 'driver:location');
      assert.deepEqual(await driverSocket.emitWithAck('driver:location', { lat: 22.76, lng: 75.9 }), { ok: true });
      assert.equal((await location).lat, 22.76);
      assert.equal(leaked, false);
      assert.deepEqual(await customerSocket.emitWithAck('driver:location', { lat: 1, lng: 1 }), { ok: false });

      await call('POST', `/customer/bookings/${booking._id}/cancel`, { token: customer.token, body: { reason: 'test over' } });
    } finally {
      [customerSocket, driverSocket, outsiderSocket].forEach((socket) => socket.close());
    }
  });
});

describe('api documentation', () => {
  test('every route appears in the generated OpenAPI spec', () => {
    const spec = buildOpenApi('http://x');
    const documented = Object.values(spec.paths).reduce((count, methods) => count + Object.keys(methods).length, 0);
    assert.equal(documented, registry.length);
    assert.ok(registry.length > 100, `only ${registry.length} routes`);
  });

  test('swagger and health endpoints respond', async () => {
    assert.equal((await call('GET', '/api/openapi.json')).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await call('GET', '/nope')).code, 'ROUTE_NOT_FOUND');
  });
});
