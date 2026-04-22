/**
 * Validates required environment variables on startup.
 * Exits with code 1 if any are missing — fast-fail is better than silent misconfiguration.
 */
const required = [
  'MONGO_URI',
  'JWT_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'SHIPROCKET_EMAIL',
  'SHIPROCKET_PASSWORD',
  'SHIPROCKET_PICKUP_LOCATION_NAME',
  'SHIPROCKET_PICKUP_PINCODE',
  'CLIENT_URL',
  // Audit fix 1.6: Required in production to prevent webhook bypass
  'SHIPROCKET_WEBHOOK_SECRET',
];

const validateEnv = () => {
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
};

module.exports = validateEnv;
