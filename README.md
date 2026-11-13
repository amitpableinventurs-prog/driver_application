# Driver IN

Hire-a-driver platform: a customer books a verified driver to drive the customer's own car, by the hour, one way, outstation or monthly.

| Part | Folder | Local URL |
|---|---|---|
| REST API + Socket.IO (Node, Express, MongoDB) | `server/` | http://localhost:5100 |
| Swagger API docs | | http://localhost:5100/api/docs |
| Admin panel (React) | `admin/` | http://localhost:5175 |
| Customer panel (React) | `customer/` | http://localhost:5176 |
| API reference and Postman collection | `docs/` | |

The customer and driver mobile apps use the same API as the panels. Start with [docs/API.md](docs/API.md), or import [docs/postman_collection.json](docs/postman_collection.json) into Postman.

## Run it

Needs Node 20.19+ and MongoDB running locally.

```bash
npm install
cp server/.env.example server/.env   # set JWT_ACCESS_SECRET and SEED_ADMIN_PASSWORD
npm run seed                         # cities, pricing, admins, pages, a sample coupon
npm run dev                          # starts the API and both panels
```

Admin logins after seeding use the password in `SEED_ADMIN_PASSWORD`:

| Role | Email |
|---|---|
| Super Admin | super@drivergo.demo |
| Operations | ops@drivergo.demo |
| Finance | finance@drivergo.demo |
| Support | support@drivergo.demo |
| Content | content@drivergo.demo |

Customer and driver logins use a phone OTP. In development the OTP comes back in the `/auth/otp/send` response as `devOtp`, and the customer panel shows it on screen.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API, admin and customer together |
| `npm test` | End-to-end tests against the `driver_go_test` database |
| `npm run docs` | Regenerates `docs/` from the route code |
| `npm run build` | Production builds of both panels |
| `npm run seed` | Safe to re-run: it only adds what is missing |
| `npm run seed:demo` | Fills an empty database with demo customers, drivers, 45 days of bookings and live trips. Development only |
| `npm run seed:demo -- --online` | Puts the demo drivers back online (idle drivers leave the live map after 15 minutes) |

## How the money works

All amounts are whole rupees.

- **Fare:** `subtotal - discount + tax + tolls/parking`. Tax applies after the discount.
- **Commission** is a percentage of the subtotal. The driver earns `subtotal - commission + tolls/parking`, so the platform funds coupons.
- **Cash trip:** the driver keeps the cash and the wallet is debited the difference, so a driver wallet can go negative. Below the dues limit in Settings the driver cannot go online.
- **Wallet and online trips:** the driver wallet is credited the earning. A wallet trip the balance cannot cover falls back to cash.
- **Payouts:** the amount leaves the driver wallet on request and returns if rejected. Bank transfers are done by hand, then recorded with "Mark paid".
- Every wallet movement has a unique idempotency key, so retries and webhook repeats cannot double-pay.

## Before going live

These need your accounts or a decision. The code path exists; none of them has been run against a live provider.

| Item | What to do |
|---|---|
| SMS OTP | Set `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID`. In production, login fails until this is set. |
| Payments | Set the `RAZORPAY_*` keys and add the webhook `POST /api/v1/webhooks/razorpay` for `payment.captured`. The `mock` gateway is refused in production. |
| Push notifications | Device tokens are stored. Replace the body of `sendPush` in `server/src/services/notify.js` with Firebase. Until then, notifications are in-app and socket only. |
| Map tiles | The panels use public OpenStreetMap tiles, which suit development and low traffic only. Move to a paid tile provider for production. |
| Distances | Estimated as straight line x 1.3. Swap `roadKm` in `server/src/services/fare.js` for a routing API if you need road accuracy. |
| File storage | Uploads are on local disk in `server/uploads`. Use a persistent volume or S3 if you run more than one server. |
| MongoDB | Run a replica set (Atlas is one) with backups. |
| Secrets | Use a fresh `JWT_ACCESS_SECRET`, change the seeded admin passwords, and set `NODE_ENV=production`, `CORS_ORIGINS` and `TRUST_PROXY`. |
| Legal pages | Replace the placeholder terms and privacy text under Admin > Pages. |

## Project layout

```
server/src/
  routes/     one file per API area, each route declares its own validation
  services/   bookings, fares, wallet, payments, OTP, realtime
  models/     Mongoose schemas
  core/       auth, route registry, uploads, OpenAPI builder
server/test/  end-to-end tests
admin/src/    admin panel
customer/src/ customer panel
shared/       API client, UI kit, map and socket helpers used by both panels
docs/         generated API reference
```
