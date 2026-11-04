/** Generates docs/openapi.json, docs/postman_collection.json and docs/API.md from the live route registry. */
import fs from 'node:fs';
import path from 'node:path';
import '../src/routes/index.js';
import { API_BASE } from '../src/routes/index.js';
import { registry } from '../src/core/api.js';
import { buildOpenApi } from '../src/core/openapi.js';

const DOCS = path.resolve(process.cwd(), '..', 'docs');
const BASE_URL = 'http://localhost:5100';
const spec = buildOpenApi(`${BASE_URL}${API_BASE}`);
const operations = Object.entries(spec.paths).flatMap(([route, methods]) => (
  Object.entries(methods).map(([method, operation]) => ({ route, method, operation }))
));

function sample(schema, name = '') {
  if (!schema) return undefined;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return sample((schema.anyOf || schema.oneOf)[0], name);
  if (schema.type === 'object') {
    const output = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      if ((schema.required || []).includes(key)) output[key] = sample(value, key);
    }
    return output;
  }
  if (schema.type === 'array') return [sample(schema.items, name)];
  if (schema.type === 'boolean') return true;
  if (schema.type === 'number' || schema.type === 'integer') {
    if (name === 'lat') return 22.7196;
    if (name === 'lng') return 75.8577;
    return schema.minimum > 0 ? schema.minimum : 1;
  }
  if (name === 'phone') return '9876543210';
  if (name === 'email') return 'user@example.com';
  if (name === 'otp') return '123456';
  if (/id$/i.test(name)) return '<id>';
  return `<${name || 'text'}>`;
}

/* ------------------------------ Postman ------------------------------ */

const TOKEN_VAR = { customer: 'customerToken', driver: 'driverToken', admin: 'adminToken' };

function postmanItem({ route, method, operation }) {
  const role = operation['x-role'];
  const segments = route.split('/').filter(Boolean).map((part) => part.replace(/^\{(\w+)\}$/, ':$1'));
  const request = {
    method: method.toUpperCase(),
    header: [],
    url: {
      raw: `{{baseUrl}}/${segments.join('/')}`,
      host: ['{{baseUrl}}'],
      path: segments,
      variable: operation.parameters.filter((p) => p.in === 'path').map((p) => ({ key: p.name, value: '' })),
      query: operation.parameters.filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: '', disabled: true })),
    },
    description: operation.description || operation.summary,
  };
  if (role !== 'public') request.auth = { type: 'bearer', bearer: [{ key: 'token', value: `{{${TOKEN_VAR[role]}}}`, type: 'string' }] };
  const content = operation.requestBody?.content;
  if (content?.['application/json']) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: JSON.stringify(sample(content['application/json'].schema), null, 2), options: { raw: { language: 'json' } } };
  } else if (content?.['multipart/form-data']) {
    const { properties } = content['multipart/form-data'].schema;
    request.body = {
      mode: 'formdata',
      formdata: Object.entries(properties).map(([key, schema]) => (
        schema.format === 'binary' ? { key, type: 'file', src: [] } : { key, value: String(sample(schema, key) ?? ''), type: 'text' }
      )),
    };
  }
  const item = { name: operation.summary, request };
  if (route === '/auth/otp/verify' || route === '/auth/admin/login') {
    const target = route === '/auth/admin/login'
      ? "pm.collectionVariables.set('adminToken', json.data.accessToken);"
      : "pm.collectionVariables.set(json.data.user.referralCode !== undefined ? 'customerToken' : 'driverToken', json.data.accessToken);";
    item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: ['const json = pm.response.json();', `if (json.success) { ${target} }`] } }];
  }
  return item;
}

const folders = new Map();
for (const entry of operations) {
  const tag = entry.operation.tags[0];
  if (!folders.has(tag)) folders.set(tag, []);
  folders.get(tag).push(postmanItem(entry));
}

const postman = {
  info: {
    name: 'Driver IN API',
    description: 'Log in with /auth/otp/verify or /auth/admin/login first: the token variables fill in automatically.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: `${BASE_URL}${API_BASE}` },
    { key: 'customerToken', value: '' },
    { key: 'driverToken', value: '' },
    { key: 'adminToken', value: '' },
  ],
  item: [...folders].map(([name, item]) => ({ name, item })),
};

/* ------------------------------ Markdown ------------------------------ */

const INTRO = `# Driver IN API Reference

Generated from the route code by \`npm run docs\`. Do not edit by hand.

- Base URL (local): \`${BASE_URL}${API_BASE}\`
- Interactive docs: \`${BASE_URL}/api/docs\`
- Postman: import \`docs/postman_collection.json\`
- Total endpoints: **${registry.length}**

## Conventions

**Authentication.** Send \`Authorization: Bearer <accessToken>\` on every protected route. Customers and drivers log in with a phone OTP, admins with email and password.

1. \`POST /auth/otp/send\` with \`{ phone, role }\`
2. \`POST /auth/otp/verify\` with \`{ phone, role, otp }\` returns \`accessToken\`, \`refreshToken\`, \`user\`, \`isNewUser\`
3. When a call returns 401 with code \`INVALID_TOKEN\`, call \`POST /auth/refresh\`, store **both** new tokens and retry. Refresh tokens are single use.

**Response shape.**

\`\`\`json
{ "success": true, "message": "optional", "data": {} }
{ "success": false, "error": { "code": "MACHINE_CODE", "message": "Show this to the user", "details": {} } }
\`\`\`

Branch on \`error.code\`, display \`error.message\`.

**Lists** accept \`page\` and \`limit\` (max 100) and return \`{ items, page, limit, total, pages }\`.

**Money** is in whole rupees. **Dates** are ISO 8601. **Files** are \`multipart/form-data\` with the field \`file\`, up to 5 MB.

## Booking lifecycle

\`\`\`
pending -> searching -> accepted -> arrived -> in_progress -> completed
              |            |           |
              v            +-----------+--> cancelled (customer or admin)
          no_driver        +-----------+--> searching (driver backed out)
\`\`\`

- \`pending\`: scheduled, waiting for its dispatch window.
- The customer sees \`startOtp\` and reads it to the driver, who sends it to \`/driver/bookings/:id/start\`. The driver API never returns it.
- Payment: \`cash\` and \`wallet\` settle when the trip ends. \`online\` stays \`pending\` until the customer pays with \`/customer/bookings/:id/pay\`, or the driver records cash.

## Online payment flow

1. Call \`/customer/wallet/topup\` or \`/customer/bookings/:id/pay\`. It returns \`orderId\`, \`gatewayOrderId\`, \`keyId\`, \`amount\`.
2. Open Razorpay checkout with \`gatewayOrderId\` and \`keyId\`.
3. Send the result to \`/customer/payments/verify\` as \`{ orderId, gatewayPaymentId, signature }\`.

Server webhook for Razorpay: \`POST ${API_BASE}/webhooks/razorpay\` (event \`payment.captured\`).

## Realtime (Socket.IO)

Connect to the server root with \`auth: { token: accessToken }\`.

| Direction | Event | Who | Payload |
|---|---|---|---|
| send | \`booking:join\` | customer, driver, admin | \`{ bookingId }\`, ack \`{ ok }\` |
| send | \`booking:leave\` | customer, driver, admin | \`{ bookingId }\` |
| send | \`driver:location\` | driver | \`{ lat, lng, heading }\`, ack \`{ ok }\` |
| receive | \`booking:updated\` | customer, driver, admin | \`{ bookingId, bookingNo, status }\` |
| receive | \`booking:offer\` | driver | booking offer |
| receive | \`booking:offer_closed\` | driver | \`{ bookingId }\` |
| receive | \`driver:location\` | booking room, admin | \`{ driverId, lat, lng, heading, at }\` |
| receive | \`notification\` | customer, driver | notification object |
| receive | \`sos:new\`, \`ticket:new\`, \`kyc:submitted\`, \`payout:requested\` | admin | event summary |

## Endpoints
`;

const roleLabel = (operation) => {
  const role = operation['x-role'];
  const permission = operation['x-permission'];
  return permission ? `${role} (\`${permission}\`)` : role;
};

function fieldList(schema) {
  const props = schema?.properties;
  if (!props || !Object.keys(props).length) return '';
  return Object.entries(props).map(([key, value]) => {
    const required = (schema.required || []).includes(key) && value.default === undefined;
    const type = value.enum ? value.enum.join(' \\| ') : value.format === 'binary' ? 'file' : (value.type || 'any');
    return `\`${key}\`${required ? '*' : ''}: ${type}`;
  }).join('<br>');
}

let markdown = INTRO;
for (const tag of folders.keys()) {
  markdown += `\n### ${tag}\n\n| Method | Path | Access | What it does | Input (* required) |\n|---|---|---|---|---|\n`;
  for (const { route, method, operation } of operations.filter((entry) => entry.operation.tags[0] === tag)) {
    const content = operation.requestBody?.content;
    const body = fieldList((content?.['application/json'] || content?.['multipart/form-data'])?.schema);
    const query = operation.parameters.filter((p) => p.in === 'query').map((p) => `\`?${p.name}\``).join(' ');
    markdown += `| ${method.toUpperCase()} | \`${route}\` | ${roleLabel(operation)} | ${operation.summary} | ${[query, body].filter(Boolean).join('<br>')} |\n`;
  }
}

fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, 'openapi.json'), JSON.stringify(spec, null, 2));
fs.writeFileSync(path.join(DOCS, 'postman_collection.json'), JSON.stringify(postman, null, 2));
fs.writeFileSync(path.join(DOCS, 'API.md'), markdown);
console.log(`Documented ${registry.length} endpoints in ${DOCS}`);
