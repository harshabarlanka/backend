const cron = require('node-cron');
const Order = require('../models/Order.model');
const {
  trackShipment,
  mapShiprocketStatusToInternal,
} = require('../services/shiprocket.service');
const logger = require('../utils/logger');

const STATUS_RANK = {
  confirmed: 1,
  preparing: 2,
  ready_for_pickup: 3,
  shipped: 4,
  out_for_delivery: 5,
  delivered: 6,
  cancelled: 6,
  rto: 6,
};

const canTransition = (current, next) => {
  if (!STATUS_RANK[next]) return false;
  if (!STATUS_RANK[current]) return true;
  if (STATUS_RANK[current] >= 6) return false; // terminal
  return STATUS_RANK[next] > STATUS_RANK[current];
};

let isRunning = false;

const job = cron.schedule(
  '*/30 * * * *',
  async () => {
    if (isRunning) return;
    isRunning = true;

    logger.info('[Tracking Sync Cron] Running...');

    try {
      const orders = await Order.find({
        awbCode: { $ne: null },
        status: { $nin: ['delivered', 'cancelled', 'rto'] },
      }).limit(50);

      for (const order of orders) {
        try {
          const tracking = await trackShipment(order.awbCode);

          const srStatus = tracking.currentStatus;
          const mapped = mapShiprocketStatusToInternal(srStatus);

          // Audit fix 2.8: only push a new tracking event when the status has
          // actually changed. Previously this appended every 30 min regardless,
          // creating 240+ duplicate entries per order over a 5-day shipment.
          const lastEvent = order.trackingHistory[order.trackingHistory.length - 1];
          if (!lastEvent || lastEvent.status !== srStatus) {
            order.trackingHistory.push({
              timestamp: new Date(),
              status: srStatus,
              location: '',
              activity: srStatus,
            });
          }

          if (mapped && canTransition(order.status, mapped)) {
            const prev = order.status;

            order.status = mapped;
            order.trackingStatus = srStatus;
            order.trackingUpdatedAt = new Date();

            order.statusHistory.push({
              status: mapped,
              note: srStatus,
            });

            logger.info(`${order.orderNumber}: ${prev} → ${mapped}`);
          }

          await order.save();
        } catch (err) {
          logger.error('[Tracking Sync Cron] Order error', {
            order: order.orderNumber,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.error('[Tracking Sync Cron] Failed', { error: err.message });
    } finally {
      isRunning = false;
    }
  },
  {
    timezone: 'Asia/Kolkata',
  },
);

logger.info('[Tracking Sync Cron] Scheduled: every 30 minutes (IST)');

module.exports = job;
