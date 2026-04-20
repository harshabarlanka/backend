/**
 * AWB Retry Cron Job
 *
 * Runs every 15 minutes (configurable via SHIPMENT_RETRY_CRON in .env).
 * Picks up all orders in trackingStatus=AWB_PENDING and retries AWB assignment.
 *
 * This handles the case where:
 * - Shiprocket had a transient outage at order creation time
 * - No courier was available at time of order but became available later
 * - COD restriction lifted for the pincode
 * - Shiprocket auto-assign was delayed
 *
 * Register this in server.js:
 *   require('./crons/awbRetry.cron');
 */

const cron = require("node-cron");
const logger = require("../utils/logger");
const { retryPendingAwbOrders } = require("../services/shiprocket.service");

// Default: every 15 minutes. Override with SHIPMENT_RETRY_CRON in .env
// NOTE: The .env value "*/15 * * * *       " has trailing spaces — must trim
const cronExpression = (process.env.SHIPMENT_RETRY_CRON || "*/15 * * * *").trim();

let isRunning = false; // Prevent overlapping runs

const job = cron.schedule(cronExpression, async () => {
  if (isRunning) {
    logger.warn("[AWB Retry Cron] Previous run still in progress — skipping this tick");
    return;
  }

  isRunning = true;
  logger.info("[AWB Retry Cron] Starting run");

  try {
    await retryPendingAwbOrders();
    logger.info("[AWB Retry Cron] Run completed successfully");
  } catch (err) {
    logger.error("[AWB Retry Cron] Run failed", { error: err.message, stack: err.stack });
  } finally {
    isRunning = false;
  }
}, {
  scheduled: true,
  timezone: "Asia/Kolkata", // IST — important for India-based operations
});

logger.info(`[AWB Retry Cron] Scheduled: "${cronExpression}" (IST)`);

module.exports = job;
