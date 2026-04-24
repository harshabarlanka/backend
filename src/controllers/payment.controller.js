const mongoose = require("mongoose");
const Order = require("../models/Order.model");
const Cart = require("../models/Cart.model");
const Payment = require("../models/Payment.model");
const User = require("../models/User.model");
const Coupon = require("../models/Coupon.model");
const {
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayPayment,
  initiateRefund,
} = require("../services/razorpay.service");
const { sendOrderConfirmationEmail } = require("../services/email.service");
const { deductStock } = require("../utils/stock");
const { generateOrderNumber } = require("../utils/orderNumber");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

// ─── Helper: increment coupon usageCount atomically ───────────────────────────
const incrementCouponUsage = async (couponId, session) => {
  if (!couponId) return;
  await Coupon.findByIdAndUpdate(
    couponId,
    { $inc: { usageCount: 1 } },
    { session },
  );
};

// ─── Helper: create Order document from Payment's pendingOrderMeta ────────────
//
// Called inside a transaction after signature verification.
// This is the ONLY place an Order is written to MongoDB.

const createOrderFromPayment = async (
  payment,
  userId,
  razorpayPaymentId,
  session,
) => {
  const meta = payment.pendingOrderMeta;
  if (!meta) {
    throw new Error(`Payment ${payment._id} has no pendingOrderMeta`);
  }

  // Atomic idempotency: if order already exists for this idempotencyKey, skip
  const existing = await Order.findOne({
    idempotencyKey: meta.idempotencyKey,
  }).session(session);
  if (existing) {
    logger.info(
      `[createOrderFromPayment] Order already exists: ${existing.orderNumber}`,
    );
    return existing;
  }

  const order = await Order.create(
    [
      {
        orderNumber: meta.orderNumber,
        idempotencyKey: meta.idempotencyKey,
        userId,
        items: meta.items,
        shippingAddress: meta.shippingAddress,
        paymentMethod: "razorpay",
        notes: meta.notes || "",
        // Coupon
        couponCode: meta.couponCode || null,
        couponId: meta.couponId || null,
        discountAmount: meta.discountAmount || 0,
        discount: meta.discountAmount || 0,
        // Shipping (stored for reference; actual carrier assigned at ready_for_pickup)
        courierId: meta.courierId || null,
        courierName: meta.courierName || null,
        shippingCost: meta.shippingCost || 0,
        shippingCharge: meta.shippingCost || 0,
        etd: meta.etd || null,
        // Pricing
        subtotal: meta.subtotal,
        tax: meta.tax,
        total: meta.total,
        // Payment link
        paymentId: payment._id,
        // Status: confirmed immediately (payment already captured)
        status: "confirmed",
        statusHistory: [
          {
            status: "confirmed",
            note: `Payment captured. Razorpay Payment ID: ${razorpayPaymentId}`,
            updatedBy: userId,
          },
        ],
      },
    ],
    { session },
  );

  return order[0];
};

// ─── Verify Razorpay Payment ───────────────────────────────────────────────────
//
// PRODUCTION-SAFE FLOW (called after user completes payment in Razorpay modal):
//   1. Verify HMAC signature
//   2. Verify amount against Payment record
//   3. Inside a MongoDB transaction:
//      a. Create Order in MongoDB (from Payment.pendingOrderMeta)
//      b. Update Payment record (captured, link orderId)
//      c. Deduct stock — throws on oversell, rolls back transaction
//      d. Clear cart
//      e. Increment coupon usageCount
//   4. On oversell: auto-refund captured payment and return 409
//   5. Send confirmation email (fire-and-forget)
//   NOTE: NO Shiprocket calls here. Shipment is triggered at ready_for_pickup.

const verifyPayment = catchAsync(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new ApiError(400, "Missing payment verification fields.");
  }

  // 1. Verify HMAC signature — security critical
  const isValid = verifyPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });
  if (!isValid) {
    logger.warn(
      `[verifyPayment] Signature mismatch. razorpayOrderId=${razorpayOrderId} userId=${req.user._id}`,
    );
    throw new ApiError(400, "Payment verification failed. Invalid signature.");
  }

  // 2. Load Payment record (contains all pending order metadata)
  const payment = await Payment.findOne({
    razorpayOrderId,
    userId: req.user._id,
  }).select("+pendingOrderMeta");

  if (!payment) {
    throw new ApiError(404, "Payment record not found.");
  }

  // 2a. Idempotency: if payment already captured, return existing order
  if (payment.status === "captured" && payment.orderId) {
    const existingOrder = await Order.findById(payment.orderId);
    if (existingOrder) {
      logger.info(
        `[verifyPayment] Order ${existingOrder.orderNumber} already confirmed — idempotent`,
      );
      return sendResponse(res, 200, "Payment already verified.", {
        order: {
          _id: existingOrder._id,
          orderNumber: existingOrder.orderNumber,
          status: existingOrder.status,
          total: existingOrder.total,
        },
      });
    }
  }

  // 3. Verify amount matches our Payment record (prevents amount manipulation)
  const rzpPayment = await fetchRazorpayPayment(razorpayPaymentId);
  if (rzpPayment.status !== "captured") {
    logger.warn(
      `[verifyPayment] Payment not captured. Status=${rzpPayment.status}`,
    );
    throw new ApiError(400, "Payment not captured yet.");
  }
  if (rzpPayment.currency !== "INR") {
    throw new ApiError(400, "Invalid currency.");
  }
  if (rzpPayment.amount !== payment.amount) {
    logger.error(
      `[verifyPayment] AMOUNT MISMATCH! Expected=${payment.amount}, Got=${rzpPayment.amount}`,
      { razorpayOrderId, razorpayPaymentId },
    );
    throw new ApiError(400, "Payment amount mismatch. Contact support.");
  }

  // 4. MongoDB Transaction — all DB writes atomically
  const session = await mongoose.startSession();
  let confirmedOrder = null;

  try {
    await session.withTransaction(async () => {
      // 4a. Create Order from pendingOrderMeta (idempotent — skips if already exists)
      confirmedOrder = await createOrderFromPayment(
        payment,
        req.user._id,
        razorpayPaymentId,
        session,
      );

      // 4b. Update Payment record — link orderId, mark captured
      await Payment.findByIdAndUpdate(
        payment._id,
        {
          $set: {
            orderId: confirmedOrder._id,
            razorpayPaymentId,
            razorpaySignature,
            status: "captured",
            paidAt: new Date(),
          },
        },
        { session },
      );

      // 4c. Deduct stock atomically — throws if any item oversold, rolls back txn
      await deductStock(confirmedOrder.items, session);

      // 4d. Clear the cart
      await Cart.findOneAndUpdate(
        { userId: req.user._id },
        { $set: { items: [] } },
        { session },
      );

      // 4e. Increment coupon usageCount (ONLY now, after payment success)
      await incrementCouponUsage(confirmedOrder.couponId, session);
    });
  } catch (err) {
    // Audit fix 1.2: If deductStock threw an oversell error, the transaction
    // already rolled back. Payment is captured by Razorpay, so we must refund.
    if (err.message && err.message.includes("Insufficient stock")) {
      logger.warn(
        `[verifyPayment] Oversell detected — initiating refund for ${razorpayPaymentId}`,
      );
      try {
        if (payment.status !== "refunded") {
          await initiateRefund(razorpayPaymentId, payment.amount);
          await Payment.findByIdAndUpdate(payment._id, { status: "refunded" });
        }
      } catch (refundErr) {
        logger.error(
          `[verifyPayment] Refund FAILED after oversell for ${razorpayPaymentId}:`,
          refundErr.message,
        );
        // TODO: alert ops — customer paid but refund failed
      }
      throw new ApiError(
        409,
        "One or more items went out of stock during checkout. Your payment will be refunded within 5-7 business days.",
      );
    }
    throw err;
  } finally {
    await session.endSession();
  }

  logger.info(
    `[verifyPayment] Order ${confirmedOrder.orderNumber} confirmed. Shiprocket will be triggered at ready_for_pickup.`,
  );

  // 5. Send confirmation email (fire-and-forget — outside transaction)
  sendOrderConfirmationEmail({
    email: req.user.email,
    name: req.user.name,
    order: confirmedOrder,
  }).catch((err) =>
    logger.warn(
      `[verifyPayment] Email failed for ${confirmedOrder.orderNumber}: ${err.message}`,
    ),
  );

  return sendResponse(res, 200, "Payment verified. Order confirmed.", {
    order: {
      _id: confirmedOrder._id,
      orderNumber: confirmedOrder.orderNumber,
      status: confirmedOrder.status,
      total: confirmedOrder.total,
    },
  });
});

// ─── Razorpay Webhook ─────────────────────────────────────────────────────────
//
// Fallback path: fires if user closed browser before /verify ran.
// Same logic as verifyPayment but triggered by Razorpay's server.
// NO Shiprocket calls here either.
//
// Audit fix 1.4: uses findOneAndUpdate with $ne: 'captured' as an atomic lock
// to ensure only one execution path (webhook OR /verify) claims the payment.

const razorpayWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.body; // Buffer

  let isValid = false;
  try {
    isValid = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    logger.warn("[razorpayWebhook] Signature verification threw:", err.message);
    return res.status(400).json({ received: false });
  }

  if (!isValid) {
    logger.warn("[razorpayWebhook] Invalid signature — rejecting");
    return res.status(400).json({ received: false });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ received: false, message: "Invalid JSON" });
  }

  const eventType = event.event;
  const payload = event.payload?.payment?.entity || {};
  logger.info(`[razorpayWebhook] Event: ${eventType}`);

  try {
    switch (eventType) {
      // ── payment.captured ──────────────────────────────────────────────────
      // Fallback: fires if user closed browser before /verify ran.
      case "payment.captured": {
        // Audit fix 1.4: atomic status flip — only one caller (webhook OR /verify) wins.
        // findOneAndUpdate with $ne: 'captured' acts as a distributed lock.
        const claimed = await Payment.findOneAndUpdate(
          {
            razorpayOrderId: payload.order_id,
            status: { $ne: "captured" }, // only succeeds if not yet captured
          },
          {
            $set: {
              razorpayPaymentId: payload.id,
              status: "captured",
              paidAt: new Date(),
              webhookPayload: payload,
            },
          },
          { new: true, select: "+pendingOrderMeta" },
        );

        if (!claimed) {
          logger.info(
            `[razorpayWebhook] Payment already captured for order ${payload.order_id} — skipping`,
          );
          break;
        }

        // `claimed` is the freshly-updated Payment record
        const freshPayment = claimed;

        const session = await mongoose.startSession();
        let webhookOrder = null;

        try {
          await session.withTransaction(async () => {
            // Create Order from pendingOrderMeta (idempotent)
            webhookOrder = await createOrderFromPayment(
              freshPayment,
              freshPayment.userId,
              payload.id,
              session,
            );

            // Link orderId on Payment
            await Payment.findByIdAndUpdate(
              freshPayment._id,
              {
                $set: {
                  orderId: webhookOrder._id,
                  razorpayPaymentId: payload.id,
                },
              },
              { session },
            );

            // Deduct stock — throws on oversell, rolls back txn
            await deductStock(webhookOrder.items, session);

            await Cart.findOneAndUpdate(
              { userId: webhookOrder.userId },
              { $set: { items: [] } },
              { session },
            );
            await incrementCouponUsage(webhookOrder.couponId, session);
          });
        } catch (err) {
          // Audit fix 1.2: oversell refund path
          if (err.message && err.message.includes("Insufficient stock")) {
            logger.warn(
              `[razorpayWebhook] Oversell detected — refunding ${payload.id}`,
            );
            try {
              if (freshPayment.status !== "refunded") {
                await initiateRefund(payload.id, freshPayment.amount);
                await Payment.findByIdAndUpdate(freshPayment._id, {
                  status: "refunded",
                });
              }
            } catch (refundErr) {
              logger.error(
                `[razorpayWebhook] Refund FAILED after oversell for ${payload.id}:`,
                refundErr.message,
              );
            }
          } else {
            throw err;
          }
        } finally {
          await session.endSession();
        }

        if (webhookOrder) {
          const user = await User.findById(webhookOrder.userId).select(
            "email name",
          );
          if (user) {
            sendOrderConfirmationEmail({
              email: user.email,
              name: user.name,
              order: webhookOrder,
            }).catch((err) =>
              logger.warn(
                `[razorpayWebhook] Email failed for ${webhookOrder.orderNumber}: ${err.message}`,
              ),
            );
          }
          logger.info(
            `[razorpayWebhook] Order ${webhookOrder.orderNumber} confirmed via webhook.`,
          );
        }
        break;
      }

      // ── payment.failed ────────────────────────────────────────────────────
      case "payment.failed": {
        const payment = await Payment.findOne({
          razorpayOrderId: payload.order_id,
        });
        if (!payment) break;

        await Payment.findByIdAndUpdate(payment._id, {
          $set: { status: "failed", webhookPayload: payload },
        });

        logger.info(
          `[razorpayWebhook] Payment failed for razorpayOrderId ${payload.order_id}`,
        );
        break;
      }

      // ── refund.created ────────────────────────────────────────────────────
      case "refund.created": {
        const refundPayload = event.payload?.refund?.entity || {};
        await Payment.findOneAndUpdate(
          { razorpayPaymentId: refundPayload.payment_id },
          {
            $set: {
              status: "refunded",
              refundId: refundPayload.id,
              refundedAt: new Date(),
              refundAmount: refundPayload.amount,
            },
          },
        );
        break;
      }

      default:
        logger.info(`[razorpayWebhook] Unhandled event: ${eventType}`);
    }
  } catch (err) {
    logger.error(`[razorpayWebhook] Error processing event ${eventType}:`, err);
  }

  return res.status(200).json({ received: true });
};

module.exports = { verifyPayment, razorpayWebhook };
