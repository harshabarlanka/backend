/**
 * Abandoned Payments Cleanup Cron
 *
 * Previously this cron cancelled Order documents that were stuck in "pending"
 * status. With the payment-first flow, there are no "pending" Order documents
 * any more. Instead, we clean up Payment records that were created but never
 * captured (user initiated checkout, got Razorpay order, but never paid).
 *
 * What this does:
 *   - Finds Payment records with status "created" older than 24 hours
 *   - Marks them "failed" for audit purposes
 *   - Logs the count (no Order to cancel since none was ever created)
 *
 * Runs every hour. Registered in server.js.
 */
const cron = require("node-cron");
const Payment = require("../models/Payment.model");
const logger = require("../utils/logger");

let isRunning = false;

const job = cron.schedule("0 * * * *", async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Mark abandoned (never-captured) Payment records as failed.
    // These are safe to expire — no Order was ever written to the DB for them.
    const result = await Payment.updateMany(
      {
        status: "created",
        orderId: null, // only pre-order payments (no Order linked yet)
        createdAt: { $lt: cutoff },
      },
      {
        $set: { status: "failed" },
      }
    );

    if (result.modifiedCount > 0) {
      logger.info(
        `[AbandonedPayments Cron] Expired ${result.modifiedCount} abandoned payment records (no orders were created for these).`
      );
    }
  } catch (err) {
    logger.error("[AbandonedPayments Cron] Error:", { error: err.message });
  } finally {
    isRunning = false;
  }
}, {
  timezone: "Asia/Kolkata",
});

logger.info("[AbandonedPayments Cron] Scheduled: every hour (IST)");
module.exports = job;
