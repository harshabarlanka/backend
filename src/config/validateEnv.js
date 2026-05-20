/**
 * validateEnv.js
 * Validates all required environment variables at startup.
 * Crashes the process immediately on missing/weak values in production.
 *
 * WHY: Silent missing env vars cause subtle runtime bugs (undefined secrets
 * silently passed to crypto functions, CORS rejecting all requests, etc.).
 * Fail-fast at boot is safer than failing mid-transaction.
 */

const crypto = require('crypto');

// ─── Hard-required: missing any of these crashes the server ───────────────────
const REQUIRED = [
  'MONGO_URI',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'SHIPROCKET_EMAIL',
  'SHIPROCKET_PASSWORD',
  'SHIPROCKET_PICKUP_LOCATION_NAME',
  'SHIPROCKET_PICKUP_PINCODE',
  'CLIENT_URL',
  'SHIPROCKET_WEBHOOK_SECRET',
  'EMAIL_HOST',
  'EMAIL_USER',
  'EMAIL_PASS',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

// ─── Minimum entropy check for secret values ──────────────────────────────────
// Keyboard-walk patterns like "asdfghjkl..." have low entropy.
// We require at least 32 bytes (256 bits) of randomness for secrets.
const WEAK_PATTERNS = [
  /^(.)\1{7,}/,                    // repeated chars: "aaaaaaaa"
  /^(012|123|234|345|456|567|678|789|890|abc|bcd|cde|def)/i, // sequential
  /^(qwerty|asdf|zxcv)/i,          // keyboard walks
  /^[a-z]+\d{1,6}$/i,              // name+number pattern: "harsha90523"
];

const isWeakSecret = (value) => {
  if (!value) return true;
  if (value.length < 32) return true;
  return WEAK_PATTERNS.some((re) => re.test(value));
};

// Secrets that must pass the entropy check in production
const SECRET_VARS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'SHIPROCKET_WEBHOOK_SECRET',
];

const validateEnv = () => {
  const isProd = process.env.NODE_ENV === 'production';

  // ── 1. Check all required vars are present ────────────────────────────────
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(
      `[FATAL] Missing required environment variables:\n  ${missing.join('\n  ')}\n\n` +
      `Copy .env.example to .env and fill in all values.`
    );
    process.exit(1);
  }

  // ── 2. Entropy check on secrets (production only) ─────────────────────────
  if (isProd) {
    const weak = SECRET_VARS.filter((k) => isWeakSecret(process.env[k]));
    if (weak.length > 0) {
      console.error(
        `[FATAL] Weak secrets detected in production:\n  ${weak.join('\n  ')}\n\n` +
        `Generate strong secrets with:\n  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
      );
      process.exit(1);
    }
  }

  // ── 3. CLIENT_URL must not be localhost in production ─────────────────────
  if (isProd && process.env.CLIENT_URL?.includes('localhost')) {
    console.error(
      `[FATAL] CLIENT_URL is set to localhost in production: "${process.env.CLIENT_URL}"\n` +
      `Set CLIENT_URL to your actual production frontend URL in Render env vars.`
    );
    process.exit(1);
  }

  // ── 4. Razorpay key must be live in production ────────────────────────────
  if (isProd && process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) {
    console.error(
      `[FATAL] Razorpay is using TEST keys in production!\n` +
      `Set RAZORPAY_KEY_ID to your live key (rzp_live_...).`
    );
    process.exit(1);
  }

  // ── 5. Soft warnings (server starts but these should be set) ──────────────
  if (!isProd) {
    console.warn(`[WARN] NODE_ENV="${process.env.NODE_ENV}" — stack traces will be visible to users.`);
  }

  if (!process.env.ADMIN_ALERT_EMAIL) {
    console.warn(
      '[WARN] ADMIN_ALERT_EMAIL not set — admin alerts will fall back to EMAIL_USER.'
    );
  }

  if (isProd && !process.env.BACKEND_URL) {
    console.warn(
      '[WARN] BACKEND_URL not set — keepAlive cron will not run. Cold starts will occur on free tier.'
    );
  }

  if (isProd && !process.env.INDEXNOW_KEY) {
    console.warn('[WARN] INDEXNOW_KEY not set — IndexNow submission will be disabled.');
  }
};

module.exports = validateEnv;
