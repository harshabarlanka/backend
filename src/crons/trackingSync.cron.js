const cron = require("node-cron");
const Order = require("../models/Order.model");
const Payment = require("../models/Payment.model"); // 🔥 added
const {
  trackShipment,
  mapShiprocketStatusToInternal,
} = require("../services/shiprocket.service");
const { initiateRefund } = require("../services/razorpay.service"); // 🔥 added
const logger = require("../utils/logger");

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
  if (STATUS_RANK[current] >= 6) return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
};

let isRunning = false;

const job = cron.schedule(
  "*/30 * * * *",
  async () => {
    if (isRunning) return;
    isRunning = true;

    logger.info("[Tracking Sync Cron] Running...");

    try {
      const orders = await Order.find({
        awbCode: { $ne: null },
        status: { $nin: ["delivered", "cancelled", "rto"] },
      }).limit(50);

      for (const order of orders) {
        try {
          const tracking = await trackShipment(order.awbCode);

          const srStatus = tracking.currentStatus;
          const mapped = mapShiprocketStatusToInternal(srStatus);

          // Push tracking only if changed
          const lastEvent =
            order.trackingHistory[order.trackingHistory.length - 1];
          if (!lastEvent || lastEvent.status !== srStatus) {
            order.trackingHistory.push({
              timestamp: new Date(),
              status: srStatus,
              location: "",
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

            // 🔥 ================================
            // 🔥 RTO REFUND LOGIC START
            // 🔥 ================================
            if (mapped === "rto" && !order.autoRefundAttempted) {
              try {
                const payment = await Payment.findById(order.paymentId);

                if (payment && payment.status !== "refunded") {
                  const refund = await initiateRefund(
                    payment.razorpayPaymentId,
                    payment.amount,
                  );

                  await Payment.findByIdAndUpdate(payment._id, {
                    status: "refunded",
                    refundId: refund.id,
                    refundedAt: new Date(),
                  });

                  order.autoRefundAttempted = true;
                  order.autoRefundId = refund.id;

                  logger.info(
                    `[RTO REFUND] Success for order ${order.orderNumber}`,
                  );
                }
              } catch (err) {
                logger.error(
                  `[RTO REFUND] Failed for order ${order.orderNumber}: ${err.message}`,
                );
              }
            }
            // 🔥 ================================
            // 🔥 RTO REFUND LOGIC END
            // 🔥 ================================
          }

          await order.save();
        } catch (err) {
          logger.error("[Tracking Sync Cron] Order error", {
            order: order.orderNumber,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.error("[Tracking Sync Cron] Failed", { error: err.message });
    } finally {
      isRunning = false;
    }
  },
  {
    timezone: "Asia/Kolkata",
  },
);

logger.info("[Tracking Sync Cron] Scheduled: every 30 minutes (IST)");

module.exports = job;
