# Driver IN API Reference

Generated from the route code by `npm run docs`. Do not edit by hand.

- Base URL (local): `http://localhost:5100/api/v1`
- Interactive docs: `http://localhost:5100/api/docs`
- Postman: import `docs/postman_collection.json`
- Total endpoints: **145**

## Conventions

**Authentication.** Send `Authorization: Bearer <accessToken>` on every protected route. Customers and drivers log in with a phone OTP, admins with email and password.

1. `POST /auth/otp/send` with `{ phone, role }`
2. `POST /auth/otp/verify` with `{ phone, role, otp }` returns `accessToken`, `refreshToken`, `user`, `isNewUser`
3. When a call returns 401 with code `INVALID_TOKEN`, call `POST /auth/refresh`, store **both** new tokens and retry. Refresh tokens are single use.

**Response shape.**

```json
{ "success": true, "message": "optional", "data": {} }
{ "success": false, "error": { "code": "MACHINE_CODE", "message": "Show this to the user", "details": {} } }
```

Branch on `error.code`, display `error.message`.

**Lists** accept `page` and `limit` (max 100) and return `{ items, page, limit, total, pages }`.

**Money** is in whole rupees. **Dates** are ISO 8601. **Files** are `multipart/form-data` with the field `file`, up to 5 MB.

## Booking lifecycle

```
pending -> searching -> accepted -> arrived -> in_progress -> completed
              |            |           |
              v            +-----------+--> cancelled (customer or admin)
          no_driver        +-----------+--> searching (driver backed out)
```

- `pending`: scheduled, waiting for its dispatch window.
- The customer sees `startOtp` and reads it to the driver, who sends it to `/driver/bookings/:id/start`. The driver API never returns it.
- Payment: `cash` and `wallet` settle when the trip ends. `online` stays `pending` until the customer pays with `/customer/bookings/:id/pay`, or the driver records cash.

## Online payment flow

1. Call `/customer/wallet/topup` or `/customer/bookings/:id/pay`. It returns `orderId`, `gatewayOrderId`, `keyId`, `amount`.
2. Open Razorpay checkout with `gatewayOrderId` and `keyId`.
3. Send the result to `/customer/payments/verify` as `{ orderId, gatewayPaymentId, signature }`.

Server webhook for Razorpay: `POST /api/v1/webhooks/razorpay` (event `payment.captured`).

## Realtime (Socket.IO)

Connect to the server root with `auth: { token: accessToken }`.

| Direction | Event | Who | Payload |
|---|---|---|---|
| send | `booking:join` | customer, driver, admin | `{ bookingId }`, ack `{ ok }` |
| send | `booking:leave` | customer, driver, admin | `{ bookingId }` |
| send | `driver:location` | driver | `{ lat, lng, heading }`, ack `{ ok }` |
| receive | `booking:updated` | customer, driver, admin | `{ bookingId, bookingNo, status }` |
| receive | `booking:offer` | driver | booking offer |
| receive | `booking:offer_closed` | driver | `{ bookingId }` |
| receive | `driver:location` | booking room, admin | `{ driverId, lat, lng, heading, at }` |
| receive | `notification` | customer, driver | notification object |
| receive | `sos:new`, `ticket:new`, `kyc:submitted`, `payout:requested` | admin | event summary |

## Endpoints

### Auth

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/auth/otp/send` | public | Send a login OTP to a customer or driver | `phone`*: string<br>`role`*: customer \| driver |
| POST | `/auth/otp/verify` | public | Verify the OTP and log in (creates the account on first login) | `phone`*: string<br>`role`*: customer \| driver<br>`otp`*: string<br>`name`: string<br>`referralCode`: string<br>`deviceToken`: string |
| POST | `/auth/admin/login` | public | Admin login with email and password | `email`*: string<br>`password`*: string |
| POST | `/auth/refresh` | public | Exchange a refresh token for a new token pair | `refreshToken`*: string |
| POST | `/auth/logout` | public | Revoke a refresh token | `refreshToken`*: string |

### Common (public)

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/common/config` | public | App bootstrap configuration |  |
| GET | `/common/cities` | public | Active service cities with their available booking types |  |
| GET | `/common/plans` | public | Published rate card for a city | `?cityId` |
| GET | `/common/banners` | public | Active promotional banners | `?audience` |
| GET | `/common/pages/{slug}` | public | CMS page by slug (terms, privacy, about, faq) |  |

### Customer: Profile

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/customer/me` | customer | My profile |  |
| PATCH | `/customer/me` | customer | Update profile | `name`: string<br>`email`: string |
| DELETE | `/customer/me` | customer | Delete my account (anonymises personal data) |  |
| GET | `/customer/referral` | customer | My referral code and rewards |  |

### Customer

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/customer/me/avatar` | customer | Upload profile photo | `file`*: file |
| POST | `/customer/me/device` | customer | Register a push notification device token | `deviceToken`*: string |
| DELETE | `/customer/me/device` | customer | Remove a push token on logout | `deviceToken`*: string |

### Customer: Cars

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/customer/cars` | customer | My cars |  |
| POST | `/customer/cars` | customer | Add a car | `name`*: string<br>`registrationNumber`*: string<br>`transmission`*: manual \| automatic<br>`category`*: hatchback \| sedan \| suv \| luxury<br>`fuel`: petrol \| diesel \| cng \| ev<br>`isDefault`: boolean |
| PATCH | `/customer/cars/{id}` | customer | Update a car | `name`: string<br>`registrationNumber`: string<br>`transmission`: manual \| automatic<br>`category`: hatchback \| sedan \| suv \| luxury<br>`fuel`: petrol \| diesel \| cng \| ev<br>`isDefault`: boolean |
| DELETE | `/customer/cars/{id}` | customer | Remove a car |  |

### Customer: Addresses

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/customer/addresses` | customer | Saved addresses |  |
| POST | `/customer/addresses` | customer | Save an address | `label`*: string<br>`address`*: string<br>`lat`*: number<br>`lng`*: number |
| PATCH | `/customer/addresses/{id}` | customer | Update an address | `label`: string<br>`address`: string<br>`lat`: number<br>`lng`: number |
| DELETE | `/customer/addresses/{id}` | customer | Delete an address |  |

### Customer: Bookings

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/customer/estimate` | customer | Fare estimate before booking | `type`*: hourly \| oneway \| outstation \| monthly<br>`cityId`*: string<br>`pickup`*: object<br>`drop`: object<br>`scheduledAt`: any<br>`hours`: integer<br>`days`: integer<br>`hoursPerDay`: integer<br>`couponCode`: string |
| GET | `/customer/coupons` | customer | Coupons available right now |  |
| POST | `/customer/bookings` | customer | Create a booking (instant when scheduledAt is omitted) | `type`*: hourly \| oneway \| outstation \| monthly<br>`cityId`*: string<br>`pickup`*: object<br>`drop`: object<br>`scheduledAt`: any<br>`hours`: integer<br>`days`: integer<br>`hoursPerDay`: integer<br>`couponCode`: string<br>`carId`*: string<br>`paymentMethod`: cash \| wallet \| online<br>`notes`: string |
| GET | `/customer/bookings` | customer | My bookings | `?page` `?limit` `?scope` |
| GET | `/customer/bookings/{id}` | customer | Booking detail |  |
| POST | `/customer/bookings/{id}/cancel` | customer | Cancel a booking (a fee may apply after a driver is assigned) | `reason`*: string |
| POST | `/customer/bookings/{id}/rate` | customer | Rate the driver after a completed trip | `rating`*: integer<br>`comment`: string |
| GET | `/customer/bookings/{id}/invoice` | customer | Invoice for a completed trip |  |

### Customer: Payments

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/customer/bookings/{id}/pay` | customer | Start online payment for a completed trip |  |
| GET | `/customer/wallet` | customer | Wallet balance and history | `?page` `?limit` |
| POST | `/customer/wallet/topup` | customer | Start a wallet top-up | `amount`*: integer |
| POST | `/customer/payments/verify` | customer | Confirm a payment after the gateway checkout | `orderId`*: string<br>`gatewayPaymentId`*: string<br>`signature`: string |

### Safety

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/customer/bookings/{id}/sos` | customer | Raise an SOS alert on an active booking | `lat`: number<br>`lng`: number<br>`message`: string |
| POST | `/driver/bookings/{id}/sos` | driver | Raise an SOS alert on an active booking | `lat`: number<br>`lng`: number<br>`message`: string |

### Notifications

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/customer/notifications` | customer | List my notifications | `?page` `?limit` |
| POST | `/customer/notifications/read` | customer | Mark notifications read (all when ids is omitted) | `ids`: array |
| GET | `/driver/notifications` | driver | List my notifications | `?page` `?limit` |
| POST | `/driver/notifications/read` | driver | Mark notifications read (all when ids is omitted) | `ids`: array |

### Support

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/customer/tickets` | customer | List my support tickets | `?page` `?limit` |
| POST | `/customer/tickets` | customer | Open a support ticket | `subject`*: string<br>`category`: booking \| payment \| driver \| app \| account \| other<br>`message`*: string<br>`bookingId`: string |
| GET | `/customer/tickets/{id}` | customer | Ticket detail with messages |  |
| POST | `/customer/tickets/{id}/messages` | customer | Reply on a ticket | `text`*: string |
| GET | `/driver/tickets` | driver | List my support tickets | `?page` `?limit` |
| POST | `/driver/tickets` | driver | Open a support ticket | `subject`*: string<br>`category`: booking \| payment \| driver \| app \| account \| other<br>`message`*: string<br>`bookingId`: string |
| GET | `/driver/tickets/{id}` | driver | Ticket detail with messages |  |
| POST | `/driver/tickets/{id}/messages` | driver | Reply on a ticket | `text`*: string |

### Driver: Profile

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/driver/me` | driver | My profile, KYC and wallet summary |  |
| PATCH | `/driver/me` | driver | Update profile and driving preferences | `name`: string<br>`email`: string<br>`dateOfBirth`: any<br>`gender`: male \| female \| other<br>`address`: string<br>`city`: string<br>`languages`: array<br>`experienceYears`: integer<br>`transmissions`: array<br>`carCategories`: array |
| DELETE | `/driver/me` | driver | Delete my account (anonymises personal data) |  |
| PATCH | `/driver/me/bank` | driver | Update payout bank details | `accountHolder`*: string<br>`accountNumber`*: string<br>`ifsc`*: string<br>`upiId`: string |

### Driver

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/driver/me/avatar` | driver | Upload profile photo | `file`*: file |
| POST | `/driver/me/device` | driver | Register a push notification device token | `deviceToken`*: string |
| DELETE | `/driver/me/device` | driver | Remove a push token on logout | `deviceToken`*: string |

### Driver: KYC

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/driver/documents` | driver | My KYC documents |  |
| POST | `/driver/documents` | driver | Upload or replace a KYC document | `type`*: driving_license \| aadhaar \| pan \| police_verification \| photo<br>`number`: string<br>`expiryDate`: any<br>`file`*: file |
| POST | `/driver/kyc/submit` | driver | Submit KYC for review |  |

### Driver: Availability

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| POST | `/driver/status` | driver | Go online or offline | `online`*: boolean<br>`lat`: number<br>`lng`: number |
| POST | `/driver/location` | driver | Update live location (REST fallback for the socket event) | `lat`*: number<br>`lng`*: number<br>`heading`: number |

### Driver: Bookings

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/driver/bookings/available` | driver | Open bookings near me |  |
| GET | `/driver/bookings/active` | driver | My current and upcoming bookings |  |
| GET | `/driver/bookings` | driver | My booking history | `?page` `?limit` `?status` |
| GET | `/driver/bookings/{id}` | driver | Booking detail |  |
| POST | `/driver/bookings/{id}/accept` | driver | Accept an offer (first driver wins) |  |
| POST | `/driver/bookings/{id}/reject` | driver | Pass on an offer |  |
| POST | `/driver/bookings/{id}/arrived` | driver | Mark arrived at pickup |  |
| POST | `/driver/bookings/{id}/start` | driver | Start the trip with the customer OTP | `otp`*: string |
| POST | `/driver/bookings/{id}/end` | driver | End the trip; returns the final fare and amount to collect | `extraCharges`: integer<br>`lat`: number<br>`lng`: number |
| POST | `/driver/bookings/{id}/collect-cash` | driver | Record cash taken for an unpaid online trip |  |
| POST | `/driver/bookings/{id}/cancel` | driver | Back out of an accepted booking (it returns to search) | `reason`*: string |
| POST | `/driver/bookings/{id}/rate` | driver | Rate the customer after a completed trip | `rating`*: integer<br>`comment`: string |

### Driver: Earnings

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/driver/earnings` | driver | Earnings summary and day-wise breakdown | `?from` `?to` |
| GET | `/driver/wallet` | driver | Wallet balance and history | `?page` `?limit` |
| POST | `/driver/wallet/pay-dues` | driver | Pay platform dues online | `amount`*: integer |
| POST | `/driver/payments/verify` | driver | Confirm a dues payment after gateway checkout | `orderId`*: string<br>`gatewayPaymentId`*: string<br>`signature`: string |
| GET | `/driver/payouts` | driver | My payout requests | `?page` `?limit` |
| POST | `/driver/payouts` | driver | Request a payout; the amount is held from the wallet immediately | `amount`*: integer |

### Admin: Account

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/me` | admin | Logged-in admin with permissions |  |
| POST | `/admin/me/password` | admin | Change my password | `currentPassword`*: string<br>`newPassword`*: string |

### Admin: Dashboard

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/dashboard` | admin (`dashboard`) | Live KPIs, 14 day trend and status mix |  |
| GET | `/admin/reports/revenue` | admin (`finance`) | Day-wise revenue report | `?from` `?to` |

### Admin: Settings

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/settings` | admin (`settings`) | Platform settings |  |
| PUT | `/admin/settings` | admin (`settings`) | Update platform settings | `commissionPercent`: integer<br>`taxPercent`: integer<br>`searchRadiusKm`: integer<br>`maxDriversPerDispatch`: integer<br>`searchTimeoutSeconds`: integer<br>`dispatchLeadMinutes`: integer<br>`minScheduleLeadMinutes`: integer<br>`freeCancelMinutes`: integer<br>`cancellationFee`: integer<br>`cancellationDriverSharePercent`: integer<br>`nightStartHour`: integer<br>`nightEndHour`: integer<br>`driverMinWalletBalance`: integer<br>`minPayoutAmount`: integer<br>`referralRewardReferrer`: integer<br>`referralRewardReferee`: integer<br>`supportPhone`: string<br>`supportEmail`: string<br>`sosPhone`: string |

### Admin: Team

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/roles` | admin (`admins`) | Roles and their permissions |  |
| GET | `/admin/admins` | admin (`admins`) | List admin users | `?page` `?limit` |
| POST | `/admin/admins` | admin (`admins`) | Create an admin user | `name`*: string<br>`email`*: string<br>`password`*: string<br>`role`*: super_admin \| operations \| finance \| support \| content |
| PATCH | `/admin/admins/{id}` | admin (`admins`) | Update an admin role, status or password | `name`: string<br>`role`: super_admin \| operations \| finance \| support \| content<br>`status`: active \| disabled<br>`password`: string |
| GET | `/admin/audit-logs` | admin (`audit`) | Admin activity log | `?page` `?limit` `?entity` `?action` |

### Admin: Customers

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/customers` | admin (`customers`) | List customers | `?page` `?limit` `?search` `?status` |
| GET | `/admin/customers/{id}` | admin (`customers`) | Customer detail with cars and recent bookings |  |
| PATCH | `/admin/customers/{id}/status` | admin (`customers`) | Block or unblock a customer | `status`*: active \| blocked<br>`reason`: string |
| POST | `/admin/customers/{id}/wallet` | admin (`finance`) | Credit or debit a customer wallet | `direction`*: credit \| debit<br>`amount`*: integer<br>`note`*: string |

### Admin: Drivers

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/drivers/live` | admin (`drivers`) | Online drivers with location for the live map |  |
| GET | `/admin/drivers` | admin (`drivers`) | List drivers | `?page` `?limit` `?search` `?status` `?kycStatus` `?online` |
| GET | `/admin/drivers/{id}` | admin (`drivers`) | Driver detail with documents and recent trips |  |
| PATCH | `/admin/drivers/{id}/status` | admin (`drivers`) | Suspend or reactivate a driver | `status`*: active \| suspended<br>`reason`: string |
| GET | `/admin/drivers/{id}/documents/{documentId}/file` | admin (`drivers`) | Download a KYC document |  |
| PATCH | `/admin/drivers/{id}/documents/{documentId}` | admin (`drivers`) | Approve or reject one KYC document | `status`*: approved \| rejected<br>`rejectionReason`: string |
| POST | `/admin/drivers/{id}/kyc` | admin (`drivers`) | Final KYC decision | `decision`*: approved \| rejected<br>`reason`: string |
| POST | `/admin/drivers/{id}/wallet` | admin (`finance`) | Credit or debit a driver wallet | `direction`*: credit \| debit<br>`amount`*: integer<br>`note`*: string |

### Admin: Bookings

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/bookings` | admin (`bookings`) | List bookings with filters | `?page` `?limit` `?search` `?status` `?type` `?from` `?to` |
| GET | `/admin/bookings/export` | admin (`bookings`) | Export bookings as CSV (up to 10,000 rows) | `?search` `?status` `?type` `?from` `?to` |
| GET | `/admin/bookings/{id}` | admin (`bookings`) | Booking detail |  |
| GET | `/admin/bookings/{id}/candidates` | admin (`bookings`) | Nearest eligible drivers for manual assignment |  |
| POST | `/admin/bookings/{id}/assign` | admin (`bookings`) | Manually assign a driver | `driverId`*: string |
| POST | `/admin/bookings/{id}/cancel` | admin (`bookings`) | Cancel a booking without a fee | `reason`*: string |
| POST | `/admin/bookings/{id}/refund` | admin (`finance`) | Refund a paid booking to the customer wallet | `amount`: integer<br>`note`*: string |
| GET | `/admin/reviews` | admin (`bookings`) | List ratings and reviews | `?page` `?limit` `?maxRating` |
| PATCH | `/admin/reviews/{id}` | admin (`bookings`) | Hide or restore a review | `hidden`*: boolean |

### Admin: Support

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/sos` | admin (`support`) | SOS alerts | `?page` `?limit` `?status` |
| POST | `/admin/sos/{id}/resolve` | admin (`support`) | Resolve an SOS alert | `resolutionNote`*: string |
| GET | `/admin/tickets` | admin (`support`) | Support tickets | `?page` `?limit` `?search` `?status` |
| GET | `/admin/tickets/{id}` | admin (`support`) | Ticket with conversation |  |
| PATCH | `/admin/tickets/{id}` | admin (`support`) | Change ticket status | `status`*: open \| in_progress \| resolved \| closed |
| POST | `/admin/tickets/{id}/reply` | admin (`support`) | Reply to a ticket and optionally change its status | `text`*: string<br>`status`: open \| in_progress \| resolved \| closed |

### Admin: Finance

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/transactions` | admin (`finance`) | All wallet transactions | `?page` `?limit` `?ownerRole` `?category` |
| GET | `/admin/payouts` | admin (`finance`) | Driver payout requests | `?page` `?limit` `?status` |
| POST | `/admin/payouts/{id}/mark-paid` | admin (`finance`) | Mark a payout paid after the bank transfer | `reference`*: string |
| POST | `/admin/payouts/{id}/reject` | admin (`finance`) | Reject a payout and return the amount to the wallet | `note`*: string |

### Admin: Catalog

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/cities` | admin (`pricing`) | List cities | `?page` `?limit` |
| POST | `/admin/cities` | admin (`pricing`) | Create city | `name`*: string<br>`state`*: string<br>`lat`: number<br>`lng`: number<br>`isActive`: boolean |
| PATCH | `/admin/cities/{id}` | admin (`pricing`) | Update city | `name`*: string<br>`state`*: string<br>`lat`: number<br>`lng`: number<br>`isActive`: boolean |
| GET | `/admin/pricing` | admin (`pricing`) | List pricing plans | `?page` `?limit` |
| POST | `/admin/pricing` | admin (`pricing`) | Create pricing plan | `city`*: string<br>`bookingType`*: hourly \| oneway \| outstation \| monthly<br>`baseFare`: integer<br>`includedHours`: number<br>`extraHourRate`: integer<br>`includedKm`: number<br>`perKmRate`: integer<br>`returnAllowance`: integer<br>`perDayRate`: integer<br>`foodAllowancePerDay`: integer<br>`stayAllowancePerNight`: integer<br>`monthlyRate`: integer<br>`nightCharge`: integer<br>`isActive`: boolean |
| PATCH | `/admin/pricing/{id}` | admin (`pricing`) | Update pricing plan | `city`: string<br>`bookingType`: hourly \| oneway \| outstation \| monthly<br>`baseFare`: integer<br>`includedHours`: number<br>`extraHourRate`: integer<br>`includedKm`: number<br>`perKmRate`: integer<br>`returnAllowance`: integer<br>`perDayRate`: integer<br>`foodAllowancePerDay`: integer<br>`stayAllowancePerNight`: integer<br>`monthlyRate`: integer<br>`nightCharge`: integer<br>`isActive`: boolean |
| DELETE | `/admin/pricing/{id}` | admin (`pricing`) | Delete pricing plan |  |
| GET | `/admin/coupons` | admin (`coupons`) | List coupons | `?page` `?limit` |
| POST | `/admin/coupons` | admin (`coupons`) | Create coupon | `code`*: string<br>`description`: string<br>`discountType`*: flat \| percent<br>`value`*: integer<br>`maxDiscount`: integer<br>`minFare`: integer<br>`validFrom`*: any<br>`validTo`*: any<br>`usageLimit`: integer<br>`perUserLimit`: integer<br>`isActive`: boolean |
| PATCH | `/admin/coupons/{id}` | admin (`coupons`) | Update coupon | `code`: string<br>`description`: string<br>`discountType`: flat \| percent<br>`value`: integer<br>`maxDiscount`: integer<br>`minFare`: integer<br>`validFrom`: any<br>`validTo`: any<br>`usageLimit`: integer<br>`perUserLimit`: integer<br>`isActive`: boolean |
| DELETE | `/admin/coupons/{id}` | admin (`coupons`) | Delete coupon |  |

### Admin: Content

| Method | Path | Access | What it does | Input (* required) |
|---|---|---|---|---|
| GET | `/admin/banners` | admin (`content`) | List banners | `?page` `?limit` |
| POST | `/admin/banners` | admin (`content`) | Create banner | `title`*: string<br>`subtitle`: string<br>`imageUrl`: string<br>`linkUrl`: string<br>`audience`: customer \| driver \| all<br>`sortOrder`: integer<br>`isActive`: boolean |
| PATCH | `/admin/banners/{id}` | admin (`content`) | Update banner | `title`: string<br>`subtitle`: string<br>`imageUrl`: string<br>`linkUrl`: string<br>`audience`: customer \| driver \| all<br>`sortOrder`: integer<br>`isActive`: boolean |
| DELETE | `/admin/banners/{id}` | admin (`content`) | Delete banner |  |
| POST | `/admin/uploads/image` | admin (`content`) | Upload an image and get its public URL | `file`*: file |
| GET | `/admin/pages` | admin (`content`) | List pages | `?page` `?limit` |
| POST | `/admin/pages` | admin (`content`) | Create page | `slug`*: string<br>`title`*: string<br>`content`: string<br>`isPublished`: boolean |
| PATCH | `/admin/pages/{id}` | admin (`content`) | Update page | `slug`: string<br>`title`: string<br>`content`: string<br>`isPublished`: boolean |
| DELETE | `/admin/pages/{id}` | admin (`content`) | Delete page |  |
| GET | `/admin/broadcasts` | admin (`content`) | Sent broadcasts | `?page` `?limit` |
| POST | `/admin/broadcasts` | admin (`content`) | Send a notification to all customers, drivers or everyone | `audience`*: customers \| drivers \| all<br>`title`*: string<br>`body`*: string |
