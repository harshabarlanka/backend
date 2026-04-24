const cron = require("node-cron");
const Payment = require("../models/Payment.model");
const { initiateRefund } = require("../services/razorpay.service");
const logger = require("../utils/logger");

cron.schedule("*/15 * * * *", async () => {
  const payments = await Payment.find({ status: "refund_failed" }).limit(10);

  for (const p of payments) {
    try {
      await initiateRefund(p.razorpayPaymentId, p.amount);
      await Payment.findByIdAndUpdate(p._id, { status: "refunded" });
      logger.info(`[Refund Retry] Success: ${p._id}`);
    } catch (err) {
      logger.error(`[Refund Retry] Failed: ${p._id}`);
    }
  }
});

module.exports = {};