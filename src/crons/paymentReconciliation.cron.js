/**
 * Payment Reconciliation Cron
 * ────────────────────────────
 * Runs every 30 minutes.
 *
 * Problem: If Render is cold-starting when Razorpay fires all 3 webhook attempts,
 * the customer pays but no Order is ever created. The Payment has status='captured'
 * but orderId=null. Neither /verify (browser closed) nor webhook (all missed) ran.
 *
 * This cron finds those orphaned payments and creates orders from pendingOrderMeta.
 * It is the guaranteed safety net: no customer ever pays without getting an order.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');

const Payment = require('../models/Payment.model');
const Order = require('../models/Order.model');
const Cart = require('../models/Cart.model');
const User = require('../models/User.model');
const Coupon = require('../models/Coupon.model');
const { deductStock } = require('../utils/stock');
const { sendOrderConfirmationEmail, sendAdminAlertEmail } = require('../services/email.service');
const logger = require('../utils/logger');

// Grace period: give normal webhook flow 20 min before we intervene
const MIN_AGE_MINUTES = 20;
// Look back max 2 hours — beyond that, ops must investigate manually
const MAX_AGE_MINUTES = 120;

let isRunning = false;

/**
 * Create an Order from a Payment's pendingOrderMeta.
 * Mirrors createOrderFromPayment in payment.controller.js — kept in sync.
 */
const reconcilePayment = async (payment, session) => {
  const meta = payment.pendingOrderMeta;
  if (!meta) throw new Error(`Payment ${payment._id} has no pendingOrderMeta`);

  // Idempotency: order may exist but link was broken
  const existing = await Order.findOne({ idempotencyKey: meta.idempotencyKey }).session(session);
  if (existing) {
    await Payment.findByIdAndUpdate(payment._id, { orderId: existing._id }, { session });
    logger.info(`[Reconciliation] Linked existing order ${existing.orderNumber} → payment ${payment._id}`);
    return { order: existing, isNew: false };
  }

  const created = await Order.create(
    [
      {
        orderNumber: meta.orderNumber,
        idempotencyKey: meta.idempotencyKey,
        userId: payment.userId,
        items: meta.items,
        shippingAddress: meta.shippingAddress,
        paymentMethod: 'razorpay',
        notes: meta.notes || '',
        couponCode: meta.couponCode || null,
        couponId: meta.couponId || null,
        discountAmount: meta.discountAmount || 0,
        discount: meta.discountAmount || 0,
        courierId: meta.courierId || null,
        courierName: meta.courierName || null,
        shippingCost: meta.shippingCost || 0,
        shippingCharge: meta.shippingCost || 0,
        etd: meta.etd || null,
        subtotal: meta.subtotal,
        tax: meta.tax,
        total: meta.total,
        paymentId: payment._id,
        status: 'confirmed',
        statusHistory: [
          {
            status: 'confirmed',
            note: `Order created by reconciliation cron. Razorpay: ${payment.razorpayPaymentId}`,
          },
        ],
      },
    ],
    { session },
  );

  const order = created[0];
  await Payment.findByIdAndUpdate(payment._id, { orderId: order._id }, { session });
  return { order, isNew: true };
};

const job = cron.schedule(
  '*/30 * * * *',
  async () => {
    if (isRunning) {
      logger.warn('[Reconciliation Cron] Previous run still in progress — skipping');
      return;
    }
    isRunning = true;
    logger.info('[Reconciliation Cron] Running...');

    try {
      const now = new Date();
      const windowStart = new Date(now - MAX_AGE_MINUTES * 60 * 1000);
      const windowEnd = new Date(now - MIN_AGE_MINUTES * 60 * 1000);

      const orphaned = await Payment.find({
        status: 'captured',
        orderId: null,
        paidAt: { $gte: windowStart, $lte: windowEnd },
      })
        .select('+pendingOrderMeta')
        .limit(20);

      if (!orphaned.length) {
        logger.info('[Reconciliation Cron] No orphaned payments in window');
        return;
      }

      logger.warn(`[Reconciliation Cron] Found ${orphaned.length} orphaned payment(s) — reconciling`);

      for (const payment of orphaned) {
        const session = await mongoose.startSession();
        try {
          let order, isNew;

          await session.withTransaction(async () => {
            ({ order, isNew } = await reconcilePayment(payment, session));

            if (isNew) {
              // Deduct stock atomically — throws on oversell → rolls back
              await deductStock(order.items, session);

              await Cart.findOneAndUpdate(
                { userId: order.userId },
                { $set: { items: [] } },
                { session },
              );

              if (order.couponId) {
                await Coupon.findByIdAndUpdate(
                  order.couponId,
                  { $inc: { usageCount: 1 } },
                  { session },
                );
              }
            }
          });

          if (isNew) {
            logger.info(
              `[Reconciliation Cron] ✅ Created order ${order.orderNumber} for payment ${payment._id}`,
            );
          }

          // Send confirmation email (fire-and-forget)
          User.findById(order.userId)
            .select('name email')
            .then((user) => {
              if (user) {
                sendOrderConfirmationEmail({ email: user.email, name: user.name, order }).catch(
                  (e) => logger.warn(`[Reconciliation Cron] Email failed: ${e.message}`),
                );
              }
            })
            .catch((e) => logger.warn(`[Reconciliation Cron] User lookup failed: ${e.message}`));
        } catch (err) {
          logger.error(
            `[Reconciliation Cron] ❌ Failed to reconcile payment ${payment._id}: ${err.message}`,
          );

          // Alert admin — manual investigation required
          sendAdminAlertEmail({
            subject: `🚨 Payment reconciliation failed — Manual action needed`,
            message: `
Captured payment could not be automatically reconciled.

MongoDB Payment ID:   ${payment._id}
Razorpay Payment ID:  ${payment.razorpayPaymentId || 'N/A'}
User ID:              ${payment.userId}
Amount:               ₹${(payment.amount / 100).toFixed(2)}
Paid At:              ${payment.paidAt?.toISOString() || 'N/A'}
Error:                ${err.message}

Actions:
1. Check MongoDB for an Order with idempotencyKey matching payment.pendingOrderMeta.idempotencyKey
2. If none found, manually create the order from pendingOrderMeta
3. Contact the customer to confirm their order
4. Check stock levels
            `.trim(),
          }).catch((e) => logger.error(`[Reconciliation Cron] Admin alert failed: ${e.message}`));
        } finally {
          await session.endSession();
        }
      }
    } catch (err) {
      logger.error('[Reconciliation Cron] Fatal error:', { error: err.message, stack: err.stack });
    } finally {
      isRunning = false;
    }
  },
  { timezone: 'Asia/Kolkata' },
);

logger.info('[Reconciliation Cron] Scheduled: every 30 minutes (IST)');
module.exports = job;
