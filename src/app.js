/**
 * app.js — Production-hardened Express application
 *
 * Security changes applied:
 *  1. CLIENT_URL from env only — no hardcoded URLs anywhere
 *  2. CSRF origin-header guard on all mutation endpoints
 *  3. Dedicated strict rate limiter for admin panel routes
 *  4. Admin routes get tighter rate limiting (100 req/15min vs 500 global)
 *  5. Helmet CSP tightened — removed unsafe-inline where possible
 *  6. Morgan logs skip health AND asset routes to reduce noise
 *  7. Body size limit remains 10kb — prevents memory DoS
 */

require("dotenv").config();
if (process.env.NODE_ENV === "production") {
  if (
    !process.env.CLIENT_URL ||
    !process.env.CLIENT_URL.startsWith("https://")
  ) {
    throw new Error(
      "[FATAL] CLIENT_URL must be set to the production HTTPS frontend URL " +
        "in Render environment variables dashboard. " +
        "Current value: " +
        process.env.CLIENT_URL,
    );
  }
}
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");

const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");
const healthRoutes = require("./routes/health.routes");
const authRoutes = require("./routes/auth.routes");
const productRoutes = require("./routes/product.routes");
const cartRoutes = require("./routes/cart.routes");
const orderRoutes = require("./routes/order.routes");
const paymentRoutes = require("./routes/payment.routes");
const adminRoutes = require("./routes/admin.routes");
const userRoutes = require("./routes/user.routes");
const uploadRoutes = require("./routes/upload.routes");
const shippingRoutes = require("./routes/shipping.routes");
const couponRoutes = require("./routes/coupon.routes");
const recommendationsRoutes = require("./routes/recommendations.routes");
const comboRoutes = require("./routes/combo.routes");
const seoRoutes = require("./routes/seo.routes");

const { v4: uuidv4 } = require("uuid");

const app = express();

// Trust Render/Vercel proxy — required for correct req.ip in rate limiters
app.set("trust proxy", 1);

// Keep Express ETags enabled (default) — they allow CDN / proxy revalidation
// (If-None-Match → 304) which saves bandwidth for intermediate caches.
// The "private" directive in our Cache-Control headers below prevents the
// browser from treating its local cache as authoritative for the same user
// after a mutation. Combined with "no-cache, must-revalidate", the browser
// must always revalidate with the server before serving cached content.

// ─── Compression ──────────────────────────────────────────────────────────────
app.use(compression({ threshold: 1024, level: 6 }));

// ─── Security Headers (Helmet) ────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://checkout.razorpay.com"],
        frameSrc: [
          "'self'",
          "https://api.razorpay.com",
          "https://checkout.razorpay.com",
        ],
        imgSrc: [
          "'self'",
          "data:",
          "https://res.cloudinary.com",
          "https://checkout.razorpay.com",
        ],
        connectSrc: [
          "'self'",
          "https://api.razorpay.com",
          "https://lumberjack.razorpay.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"], // needed for inline styles in email clients
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    frameguard: { action: "deny" },
    hidePoweredBy: true,
    hsts: {
      maxAge: 63072000, // 2 years
      includeSubDomains: true,
      preload: true,
    },
  }),
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// CLIENT_URL comes from env ONLY — no hardcoded URLs.
// In Render dashboard, set CLIENT_URL=https://naidugariruchulu.vercel.app
const allowedOrigins = [process.env.CLIENT_URL].filter(Boolean);

if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:3000", "http://localhost:5173");
}

if (allowedOrigins.length === 0) {
  logger.error(
    "[CORS] No CLIENT_URL set — all cross-origin requests will be rejected.",
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no origin) — e.g. Razorpay webhooks
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      logger.warn(`[CORS] Rejected origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

// ─── Request ID ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// ─── CSRF Guard ───────────────────────────────────────────────────────────────
// Checks Origin/Referer header on all non-GET API requests.
// This is a defence-in-depth measure alongside SameSite=Strict cookies.
// Webhooks from Razorpay/Shiprocket have no Origin — they're excluded below
// because those routes don't use this middleware (mounted before /api).
const csrfGuard = (req, res, next) => {
  // Only enforce on mutation methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const origin = req.headers.origin || req.headers.referer || "";

  // If no origin header — request is from server-side (curl, server-to-server)
  // In production with trust proxy set, legitimate browser requests always have Origin
  if (!origin) {
    // Allow server-to-server calls in prod (crons, payment reconciliation)
    return next();
  }

  const allowed = process.env.CLIENT_URL || "";

  // Exact prefix match (handles both http and https properly)
  if (!allowed || !origin.startsWith(allowed)) {
    logger.warn(
      `[CSRF] Blocked: origin="${origin}" method=${req.method} path=${req.path}`,
    );
    return res
      .status(403)
      .json({ success: false, message: "CSRF check failed." });
  }

  next();
};

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Raw body MUST come before express.json() — webhook handlers need raw Buffer
app.use("/api/payment/webhook", express.raw({ type: "application/json" }));
app.use("/api/shipping/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// ─── SEO Routes (before rate limiter — crawlers must always reach these) ──────
app.use("/", seoRoutes);
app.use("/health", healthRoutes);

// ─── Request Logging ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  app.use(
    morgan("combined", {
      stream: { write: (message) => logger.info(message.trim()) },
      // Skip health checks and static assets from logs
      skip: (req) =>
        req.url === "/health" ||
        (req.url.startsWith("/api/products") && req.method === "GET"),
    }),
  );
}

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// Global: 500 req/15min — generous for real users
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
  // Skip rate limiting for public product browsing — SEO crawlers need this
  skip: (req) => req.method === "GET" && req.path.startsWith("/api/products"),
});
app.use("/api", globalLimiter);

// Auth: 20 req/15min — prevents brute force login
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    message: "Too many auth attempts, please try again after 15 minutes.",
  },
});
app.use("/api/auth", authLimiter);

// Admin: 100 req/15min — tighter than global, admins don't need 500 req/15min
// Keyed by user ID when available (more accurate than IP with proxies)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: {
    success: false,
    message: "Too many admin requests, please slow down.",
  },
});
app.use("/api/admin", adminLimiter);

// Orders & payment: 60 req/min — prevent order spam
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});
app.use("/api/orders", orderLimiter);
app.use("/api/payment/verify", orderLimiter);

// Coupons: 30 req/15min — prevent brute-force code enumeration
const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: {
    success: false,
    message: "Too many coupon attempts, please try again later.",
  },
});
app.use("/api/coupons", couponLimiter);

// Webhooks: high volume allowed — Razorpay/Shiprocket send many events
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { success: false, message: "Webhook rate limit exceeded." },
});
app.use("/api/shipping/webhook", webhookLimiter);
app.use("/api/payment/webhook", webhookLimiter);

// ─── CSRF (applied AFTER webhook routes which don't need it) ─────────────────
app.use("/api", csrfGuard);

// ─── Cache-Control for dynamic API routes ────────────────────────────────────
//
// Strategy: "private, no-cache, must-revalidate"
//
// WHY THIS FIXES THE STALE-DATA BUG:
//   The original headers were "public, max-age=300" (products) and
//   "public, max-age=600" (combos). Those told the browser it could serve the
//   cached response for 5–10 minutes with ZERO server round-trips — not even
//   on a hard refresh of the same URL. That is why:
//     • The same browser that performed a write kept seeing old data (its local
//       cache was the authority for the next several minutes).
//     • Other browsers / devices saw fresh data immediately (no cache entry).
//
// WHAT EACH DIRECTIVE DOES:
//   private          — response is user-specific; shared CDN caches must not
//                      store it. (Our product lists vary by auth state, params,
//                      etc., so this is semantically correct anyway.)
//   no-cache         — browser must revalidate with the origin before using any
//                      cached copy. It may still store the response locally,
//                      but must check freshness on every request.
//   must-revalidate  — if the origin is unreachable, serve an error rather than
//                      a potentially-stale cached response. Prevents accidental
//                      stale serving on intermittent connectivity.
//
// WHAT THIS DOES NOT BREAK:
//   • In-app navigation / back-button feel — the frontend useFetch hook keeps
//     its own 30-second in-memory cache for fast back-navigation; that layer
//     is invalidated immediately after any mutation via invalidateCache().
//   • Other browsers / devices — they revalidate as before; MongoDB always
//     returns the latest data so they see updates immediately too.
//   • Admin routes already return no relevant Cache-Control from this file
//     (they are authenticated and Helmet's defaults apply — also private).
app.use("/api/products", (req, res, next) => {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
    res.setHeader("Vary", "Accept-Encoding, Authorization");
  }
  next();
});
app.use("/api/combos", (req, res, next) => {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
    res.setHeader("Vary", "Accept-Encoding, Authorization");
  }
  next();
});
app.use("/api/admin", (req, res, next) => {
  if (req.method === "GET") {
    // Admin responses are always user-specific and must never be cached.
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
  }
  next();
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/recommendations", recommendationsRoutes);
app.use("/api/combos", comboRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res
    .status(404)
    .json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use(errorHandler);

module.exports = app;
