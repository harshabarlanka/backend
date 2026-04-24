const cron = require("node-cron");
const mongoose = require("mongoose");

const Order = require("../models/Order.model");
const Payment = require("../models/Payment.model");
const { initiateRefund } = require("../services/razorpay.service");

const logger = require("../utils/logger");

let isRunning = false;

const job = cron.schedule(
  "*/15 * * * *", // every 15 minutes
  async () => {
    if (isRunning) return;
    isRunning = true;

    logger.info("[RTO Refund Cron] Running...");

    try {
      // 🔍 Find eligible orders
      const orders = await Order.find({
        status: "rto",
        rtoStatus: "delivered",
        autoRefundAttempted: false,
      }).limit(20);

      for (const order of orders) {
        const session = await mongoose.startSession();

        try {
          const payment = await Payment.findById(order.paymentId);

          if (!payment) return;

          if (payment.status === "refunded" || payment.refundId) {
            await Order.findByIdAndUpdate(order._id, {
              autoRefundAttempted: true,
            });
            return;
          }

          if (!payment.razorpayPaymentId) return;

          // 🔥 1. CALL REFUND OUTSIDE TRANSACTION
          const refund = await initiateRefund(
            payment.razorpayPaymentId,
            payment.amount,
          );

          // 🔥 2. DB TRANSACTION
          await session.withTransaction(async () => {
            await restoreStock(order.items, session); // ✅ important

            await Payment.findByIdAndUpdate(
              payment._id,
              {
                status: "refunded",
                refundId: refund?.id || null,
                refundedAt: new Date(),
                refundAmount: payment.amount,
              },
              { session },
            );

            await Order.findByIdAndUpdate(
              order._id,
              {
                status: "refunded",
                autoRefundAttempted: true,
                autoRefundId: refund?.id || null,
                rtoStatus: "delivered",
                rtoDeliveredAt: new Date(),
                $push: {
                  statusHistory: {
                    status: "refunded",
                    note: "Auto refund after RTO delivered",
                  },
                },
              },
              { session },
            );
          });
        } catch (err) {
          logger.error(`[RTO Refund] Failed for ${order.orderNumber}`, {
            error: err.message,
          });
        } finally {
          await session.endSession();
        }
      }
    } catch (err) {
      logger.error("[RTO Refund Cron] Error:", { error: err.message });
    } finally {
      isRunning = false;
    }
  },
  {
    timezone: "Asia/Kolkata",
  },
);

logger.info("[RTO Refund Cron] Scheduled: every 15 minutes (IST)");

module.exports = job;
