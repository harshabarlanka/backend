const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { verifyPayment, razorpayWebhook } = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');

// ─── Per-user rate limit on /verify ──────────────────────────────────────────
// Audit fix 2.10: tighter limit prevents replay attacks.
// A legitimate user verifying a payment needs at most 1-2 attempts.
const verifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 attempts per 5 minutes per user/IP
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many payment verification attempts. Please try again in a few minutes.',
  },
});

// Razorpay webhook — public but signature-verified internally
// Note: raw body parsing for this route is configured in app.js
router.post('/webhook', razorpayWebhook);

// Verify payment after Razorpay checkout modal (user-facing)
router.post('/verify', protect, verifyLimiter, verifyPayment);

module.exports = router;
