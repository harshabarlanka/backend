const express = require('express');
const router = express.Router();

const {
  verifyPayment,
  razorpayWebhook,
  confirmCODCollection,
} = require('../controllers/payment.controller');

const { protect } = require('../middleware/auth.middleware');
const { restrictTo } = require('../middleware/admin.middleware');

// Razorpay webhook — public but signature-verified internally
// Note: raw body parsing for this route is configured in app.js
router.post('/webhook', razorpayWebhook);

// Verify payment after Razorpay checkout modal (user-facing)
router.post('/verify', protect, verifyPayment);

// COD collection confirmation — admin only
router.post('/cod/:orderId/confirm', protect, restrictTo('admin'), confirmCODCollection);

module.exports = router;
