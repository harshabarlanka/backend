# 🫙 Pickle Store — Backend API

Production-ready REST API for a homemade pickle eCommerce platform.
Built with **Node.js + Express + MongoDB**, with Razorpay payments and Shiprocket delivery integration.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | MongoDB + Mongoose 8 |
| Auth | JWT (Access + Refresh tokens) |
| Payments | Razorpay |
| Delivery | Shiprocket |
| Email | Nodemailer |
| Validation | Joi |
| Logging | Winston |
| Security | Helmet, express-rate-limit, bcryptjs |

---

## Folder Structure

```
backend/
├── src/
│   ├── config/
│   │   ├── db.js                  # Mongoose connection
│   │   ├── razorpay.js            # Razorpay singleton instance
│   │   └── shiprocket.js          # Shiprocket token cache + auth
│   │
│   ├── controllers/
│   │   ├── auth.controller.js     # Register, login, refresh, logout, password reset
│   │   ├── product.controller.js  # CRUD, reviews, filtering
│   │   ├── cart.controller.js     # Add, update, remove, clear
│   │   ├── order.controller.js    # Place, list, detail, cancel, track
│   │   ├── payment.controller.js  # Razorpay verify, webhook, COD confirm
│   │   ├── admin.controller.js    # Dashboard, order mgmt, user mgmt, analytics
│   │   └── user.controller.js     # Profile, address, change password
│   │
│   ├── middleware/
│   │   ├── auth.middleware.js     # JWT Bearer token verification
│   │   ├── admin.middleware.js    # Role-based access (restrictTo)
│   │   ├── validate.middleware.js # Joi schema validation + all schemas
│   │   └── errorHandler.js        # Global error handler
│   │
│   ├── models/
│   │   ├── User.model.js          # User + embedded Address schema
│   │   ├── Product.model.js       # Product + Variant + Review schemas
│   │   ├── Cart.model.js          # Cart + CartItem schema
│   │   ├── Order.model.js         # Order + OrderItem + StatusHistory
│   │   └── Payment.model.js       # Full payment audit trail
│   │
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── product.routes.js
│   │   ├── cart.routes.js
│   │   ├── order.routes.js
│   │   ├── payment.routes.js
│   │   ├── admin.routes.js
│   │   └── user.routes.js
│   │
│   ├── services/
│   │   ├── token.service.js       # JWT generation, refresh, password reset tokens
│   │   ├── email.service.js       # Nodemailer templates (welcome, order, shipment)
│   │   ├── razorpay.service.js    # Order creation, HMAC verification, refunds
│   │   └── shiprocket.service.js  # Shipment creation, AWB, tracking, rates
│   │
│   ├── utils/
│   │   ├── logger.js              # Winston logger (console + rotating files)
│   │   ├── ApiResponse.js         # Consistent response wrapper
│   │   ├── ApiError.js            # Operational error class
│   │   ├── catchAsync.js          # Async error forwarding wrapper
│   │   └── orderNumber.js         # PKL-YYYYMMDD-XXXXX generator
│   │
│   ├── app.js                     # Express app: middleware, routes, error handler
│   └── server.js                  # Entry point: DB connect + listen
│
├── logs/                          # Auto-created by Winston
├── .env.example                   # Environment variable template
├── .gitignore
└── package.json
```

---

## Prerequisites

- Node.js **v18+**
- MongoDB Atlas account (or local MongoDB)
- Razorpay account (test mode keys work for development)
- Shiprocket account (optional for local dev — service degrades gracefully)
- Gmail account or SMTP credentials for email

---

## Step-by-Step Setup

### 1. Clone and install dependencies

```bash
git clone <your-repo-url>
cd pickle-backend
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
# ── Server ──────────────────────────────────────────────
PORT=5000
NODE_ENV=development

# ── MongoDB ─────────────────────────────────────────────
# Get from https://cloud.mongodb.com → Connect → Drivers
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/pickle_store?retryWrites=true&w=majority

# ── JWT ─────────────────────────────────────────────────
# Use a long random string (min 32 chars). Generate with:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<64-char-random-hex>
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=<different-64-char-random-hex>
JWT_REFRESH_EXPIRES_IN=7d

# ── Razorpay ─────────────────────────────────────────────
# From https://dashboard.razorpay.com → Settings → API Keys
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
# From Razorpay Dashboard → Webhooks → Secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# ── Shiprocket ───────────────────────────────────────────
# From https://app.shiprocket.in → Settings → API
SHIPROCKET_EMAIL=your@email.com
SHIPROCKET_PASSWORD=your_shiprocket_password
SHIPROCKET_BASE_URL=https://apiv2.shiprocket.in/v1/external

# ── Email ────────────────────────────────────────────────
# For Gmail: enable 2FA → App Passwords → generate one
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your@gmail.com
EMAIL_PASS=your_16_char_app_password
EMAIL_FROM="Pickle Store <noreply@picklestore.com>"

# ── Frontend (for CORS + email links) ────────────────────
CLIENT_URL=http://localhost:3000
```

### 3. Create the logs directory

```bash
mkdir logs
```

### 4. (Optional) Seed a first admin user

Run this one-time script in Node REPL or create a seed file:

```js
// seed-admin.js  — run with:  node seed-admin.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./src/models/User.model');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const admin = await User.create({
    name: 'Admin',
    email: 'admin@picklestore.com',
    passwordHash: 'Admin@1234',   // Will be hashed by pre-save hook
    role: 'admin',
    isVerified: true,
  });
  console.log('Admin created:', admin.email);
  await mongoose.disconnect();
})();
```

```bash
node seed-admin.js
```

---

## Running Locally

### Development (with auto-reload)

```bash
npm run dev
```

Server starts at `http://localhost:5000`

### Production

```bash
npm start
```

### Health check

```bash
curl http://localhost:5000/health
# → {"status":"OK","timestamp":"2024-..."}
```

---

## API Reference

### Base URL
```
http://localhost:5000/api
```

### Authentication
All protected endpoints require:
```
Authorization: Bearer <accessToken>
```

---

### Auth  `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | Public | Create account |
| POST | `/login` | Public | Login, get tokens |
| POST | `/refresh-token` | Public | Exchange refresh token |
| POST | `/logout` | 🔒 | Invalidate refresh token |
| GET | `/me` | 🔒 | Get current user |
| POST | `/forgot-password` | Public | Send reset email |
| POST | `/reset-password` | Public | Set new password |

**Register body:**
```json
{
  "name": "Priya Sharma",
  "email": "priya@example.com",
  "password": "MyPass@123",
  "phone": "9876543210"
}
```

**Login response:**
```json
{
  "success": true,
  "data": {
    "user": { "_id": "...", "name": "Priya Sharma", "role": "user" },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  }
}
```

---

### Products  `/api/products`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | List products (filter/sort/paginate) |
| GET | `/categories` | Public | All active categories |
| GET | `/:slug` | Public | Single product by slug |
| GET | `/id/:id` | Public | Single product by ID |
| GET | `/:id/reviews` | Public | Product reviews |
| POST | `/:id/reviews` | 🔒 User | Add a review |
| POST | `/` | 🔒 Admin | Create product |
| PUT | `/:id` | 🔒 Admin | Update product |
| DELETE | `/:id` | 🔒 Admin | Soft-delete product |

**Query params for GET /**
```
?page=1&limit=12&category=mango&search=spicy&sort=-ratings.average&featured=true
```

---

### Cart  `/api/cart`  🔒

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get cart |
| POST | `/add` | Add item |
| PATCH | `/item/:itemId` | Update quantity |
| DELETE | `/item/:itemId` | Remove item |
| DELETE | `/clear` | Clear cart |

**Add to cart body:**
```json
{
  "productId": "64f...",
  "variantId": "64f...",
  "quantity": 2
}
```

---

### Orders  `/api/orders`  🔒

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/` | Place order |
| GET | `/` | My orders |
| GET | `/:id` | Order detail |
| POST | `/:id/cancel` | Cancel order |
| GET | `/:id/track` | Live tracking |

**Place order body:**
```json
{
  "shippingAddress": {
    "fullName": "Priya Sharma",
    "phone": "9876543210",
    "addressLine1": "12, MG Road",
    "city": "Bengaluru",
    "state": "Karnataka",
    "pincode": "560001"
  },
  "paymentMethod": "razorpay",
  "notes": "Please pack carefully"
}
```

**Razorpay flow response:**
```json
{
  "data": {
    "order": { "_id": "...", "orderNumber": "PKL-20240801-AB3XY", "total": 598 },
    "razorpay": {
      "orderId": "order_Pxxxxxx",
      "amount": 59800,
      "currency": "INR",
      "keyId": "rzp_test_xxx"
    }
  }
}
```

Use `razorpay.orderId` and `razorpay.keyId` to open the Razorpay checkout modal on the frontend. After payment, call `POST /api/payment/verify`.

---

### Payment  `/api/payment`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/verify` | 🔒 User | Verify Razorpay payment |
| POST | `/webhook` | Public (signed) | Razorpay webhook handler |
| POST | `/cod/:orderId/confirm` | 🔒 Admin | Mark COD as collected |

**Verify body:**
```json
{
  "orderId": "64f...",
  "razorpayOrderId": "order_Pxxxxxx",
  "razorpayPaymentId": "pay_Qxxxxxx",
  "razorpaySignature": "abc123..."
}
```

---

### Admin  `/api/admin`  🔒 Admin only

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard` | Stats overview |
| GET | `/analytics?period=30` | Revenue + top products |
| GET | `/orders` | All orders (filterable) |
| GET | `/orders/:id` | Order detail |
| PATCH | `/orders/:id/status` | Update order status |
| POST | `/orders/:id/ship` | Push to Shiprocket |
| GET | `/users` | All users |
| PATCH | `/users/:id/toggle-status` | Activate/deactivate user |

**Update status body:**
```json
{
  "status": "packed",
  "note": "Packed and ready for pickup"
}
```

**Valid status transitions:**
```
pending → confirmed → packed → shipped → delivered → refunded
Any (except delivered/refunded) → cancelled
```

---

### User Profile  `/api/users`  🔒

| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/profile` | Update name/phone |
| PATCH | `/change-password` | Change password |
| POST | `/address` | Add address |
| PUT | `/address/:addressId` | Update address |
| DELETE | `/address/:addressId` | Delete address |

---

## Razorpay Frontend Integration

After `POST /api/orders` returns razorpay credentials, open the checkout modal:

```js
const options = {
  key: data.razorpay.keyId,
  amount: data.razorpay.amount,
  currency: data.razorpay.currency,
  order_id: data.razorpay.orderId,
  name: 'Pickle Store',
  description: `Order ${data.order.orderNumber}`,
  handler: async (response) => {
    // Call your verify endpoint
    await fetch('/api/payment/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        orderId: data.order._id,
        razorpayOrderId: response.razorpay_order_id,
        razorpayPaymentId: response.razorpay_payment_id,
        razorpaySignature: response.razorpay_signature,
      }),
    });
  },
};
const rzp = new window.Razorpay(options);
rzp.open();
```

---

## Razorpay Webhook Setup

1. Go to Razorpay Dashboard → Settings → Webhooks
2. Add URL: `https://yourdomain.com/api/payment/webhook`
3. Select events: `payment.captured`, `payment.failed`, `refund.created`
4. Copy the webhook secret → set `RAZORPAY_WEBHOOK_SECRET` in `.env`

For local testing use [ngrok](https://ngrok.com):
```bash
ngrok http 5000
# Use the https URL as your webhook endpoint
```

---

## Security Notes

- **JWT**: Access tokens expire in 15 min. Refresh tokens rotate on every use and are stored hashed in DB.
- **Passwords**: bcrypt with 12 salt rounds. Never stored or logged in plaintext.
- **Razorpay**: HMAC-SHA256 signature verified on every payment and webhook using `crypto.timingSafeEqual` to prevent timing attacks.
- **Rate limiting**: 500 req/15min globally, 20 req/15min on `/auth` routes.
- **Helmet**: Sets secure HTTP headers (CSP, HSTS, X-Frame-Options, etc.)
- **Input validation**: Joi validates and strips unknown fields on all POST/PUT endpoints.
- **MongoDB injection**: Mongoose strict mode + no `$where` operator usage.
- **Admin routes**: Double-guarded by `protect` (valid JWT) + `restrictTo('admin')` (role check).

---

## Error Response Format

All errors follow a consistent shape:

```json
{
  "success": false,
  "message": "Human-readable error message",
  "errors": ["Field-level error 1", "Field-level error 2"]
}
```

Common HTTP status codes:
- `400` Bad Request (validation, business logic)
- `401` Unauthorized (no/invalid/expired token)
- `403` Forbidden (insufficient role)
- `404` Not Found
- `409` Conflict (duplicate email, etc.)
- `422` Unprocessable Entity (Joi validation failure)
- `429` Too Many Requests (rate limit)
- `500` Internal Server Error

---

## Logs

Winston writes structured logs to:
- **Console**: colourised, human-readable (dev mode)
- **`logs/error.log`**: errors only, JSON, max 5MB × 5 files
- **`logs/combined.log`**: all levels, JSON, max 10MB × 10 files

---

## Deployment Checklist

- [ ] `NODE_ENV=production` in environment
- [ ] All `.env` values set (especially JWT secrets — use 64-char random hex)
- [ ] MongoDB Atlas IP whitelist configured
- [ ] Razorpay webhook URL registered and secret set
- [ ] `logs/` directory created and writable
- [ ] HTTPS configured (SSL termination at Nginx/load balancer)
- [ ] `CLIENT_URL` set to your frontend domain (for CORS)
- [ ] PM2 or similar process manager for Node.js
