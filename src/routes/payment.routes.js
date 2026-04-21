const express = require("express");
const router = express.Router();

const {
  verifyPayment,
  razorpayWebhook,
} = require("../controllers/payment.controller");

const { protect } = require("../middleware/auth.middleware");
const { restrictTo } = require("../middleware/admin.middleware");

// Razorpay webhook — public but signature-verified internally
// Note: raw body parsing for this route is configured in app.js
router.post("/webhook", razorpayWebhook);

// Verify payment after Razorpay checkout modal (user-facing)
router.post("/verify", protect, verifyPayment);

module.exports = router;
