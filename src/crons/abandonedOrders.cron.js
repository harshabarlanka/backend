/**
 * Abandoned Orders Cleanup Cron
 *
 * Cancels orders that have been in 'pending' status for more than 24 hours.
 * These are Razorpay orders where the user never completed payment.
 *
 * Runs every hour. Register in server.js.
 */
const cron   = require('node-cron');
const Order  = require('../models/Order.model');
const logger = require('../utils/logger');

let isRunning = false;

const job = cron.schedule('0 * * * *', async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await Order.updateMany(
      { status: 'pending', createdAt: { $lt: cutoff } },
      {
        $set: { status: 'cancelled' },
        $push: {
          statusHistory: {
            status: 'cancelled',
            note:   'Auto-cancelled: payment not completed within 24 hours.',
          },
        },
      }
    );

    if (result.modifiedCount > 0) {
      logger.info(`[AbandonedOrders Cron] Cancelled ${result.modifiedCount} abandoned orders`);
    }
  } catch (err) {
    logger.error('[AbandonedOrders Cron] Error:', { error: err.message });
  } finally {
    isRunning = false;
  }
}, {
  timezone: 'Asia/Kolkata',
});

logger.info('[AbandonedOrders Cron] Scheduled: every hour (IST)');
module.exports = job;