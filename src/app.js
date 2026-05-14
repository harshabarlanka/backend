require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");
const healthRoutes = require("./routes/health.routes");
// Route imports
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

// ─── Trust proxy (for Render's load balancer) ─────────────────────────────────
// Required for rate-limiter to see real client IPs behind Render's proxy
app.set("trust proxy", 1);

// ─── Compression (Gzip/Brotli) ───────────────────────────────────────────────
// Must be FIRST so all responses are compressed
app.use(
  compression({
    // Only compress responses > 1KB
    threshold: 1024,
    // Skip compression for already-compressed formats
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
    // Use highest compression level for static/API responses
    level: 6,
  })
);

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false, // CSP managed by Vercel headers
  })
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.CLIENT_URL || "http://localhost:3000",
  "https://naidugariruchulu.vercel.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.some((o) => origin.startsWith(o))) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Cache preflight for 24h
    maxAge: 86400,
  })
);

// ─── Request ID ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Raw body for webhook signature verification (must come before express.json)
app.use("/api/payment/webhook", express.raw({ type: "application/json" }));
app.use("/api/shipping/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ─── SEO Routes (before rate limiter — crawlers must always access these) ─────
app.use("/", seoRoutes);

app.use("/health", healthRoutes);

// ─── Request Logging ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(
    morgan("combined", {
      stream: { write: (message) => logger.info(message.trim()) },
      // Skip health check logging to reduce noise
      skip: (req) => req.url === "/health",
    })
  );
}

// ─── Global Rate Limiter ──────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later." },
  // Skip rate limit for static/public product reads (high-volume, safe)
  skip: (req) => req.method === "GET" && req.path.startsWith("/api/products"),
});
app.use("/api", globalLimiter);

// Auth — stricter limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many auth attempts, please try again after 15 minutes." },
});
app.use("/api/auth", authLimiter);

// Orders / payment — per-user limit
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});
app.use("/api/orders", orderLimiter);
app.use("/api/payment/verify", orderLimiter);

// Webhook — generous, but bounded
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: { success: false, message: "Webhook rate limit exceeded." },
});
app.use("/api/shipping/webhook", webhookLimiter);
app.use("/api/payment/webhook", webhookLimiter);

// ─── Cache-Control for public GET routes ─────────────────────────────────────
// Products: 5-min cache + stale-while-revalidate for smooth UX
app.use("/api/products", (req, res, next) => {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    res.setHeader("Vary", "Accept-Encoding");
  }
  next();
});

// Combos: 10-min cache (less frequently updated)
app.use("/api/combos", (req, res, next) => {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=120");
    res.setHeader("Vary", "Accept-Encoding");
  }
  next();
});

// Health check: no cache
app.use("/health", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
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

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
