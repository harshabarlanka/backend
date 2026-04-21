const Order = require("../models/Order.model");
const Cart = require("../models/Cart.model");
const Payment = require("../models/Payment.model");
const User = require("../models/User.model");
const {
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayPayment,
} = require("../services/razorpay.service");
const { sendOrderConfirmationEmail } = require("../services/email.service");
const { deductStock } = require("../utils/stock");
const { autoCreateShipment } = require("../services/shiprocket.service");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

// ─── Verify Razorpay Payment ──────────────────────────────────────────────────

const verifyPayment = catchAsync(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } =
    req.body;

  if (
    !razorpayOrderId ||
    !razorpayPaymentId ||
    !razorpaySignature ||
    !orderId
  ) {
    throw new ApiError(400, "Missing payment verification fields.");
  }

  // 1. Verify HMAC signature — security critical, must be first
  const isValid = verifyPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });
  if (!isValid) {
    logger.warn(
      `[verifyPayment] Signature mismatch. orderId=${orderId} userId=${req.user._id}`,
    );
    throw new ApiError(400, "Payment verification failed. Invalid signature.");
  }

  // 2. Verify amount matches our order (prevents amount manipulation attacks)
  const rzpPayment = await fetchRazorpayPayment(razorpayPaymentId);
  const orderForAmount = await Order.findOne({
    _id: orderId,
    userId: req.user._id,
  }).select("total");
  if (!orderForAmount) throw new ApiError(404, "Order not found.");

  if (rzpPayment.amount !== orderForAmount.total * 100) {
    logger.error(
      `[verifyPayment] AMOUNT MISMATCH! Expected=${orderForAmount.total * 100}, Got=${rzpPayment.amount}`,
      {
        orderId,
        razorpayPaymentId,
      },
    );
    throw new ApiError(400, "Payment amount mismatch. Contact support.");
  }

  // 3. Atomic compare-and-swap: confirm order only if it's still 'pending'
  //    This prevents the double-deduction race condition between /verify and webhook
  const order = await Order.findOneAndUpdate(
    { _id: orderId, userId: req.user._id, status: "pending" },
    {
      $set: { status: "confirmed" },
      $push: {
        statusHistory: {
          status: "confirmed",
          note: `Payment captured. Razorpay Payment ID: ${razorpayPaymentId}`,
          updatedBy: req.user._id,
        },
      },
    },
    { new: true },
  );

  // If findOneAndUpdate returned null, the order was already confirmed (idempotent)
  if (!order) {
    const confirmedOrder = await Order.findOne({
      _id: orderId,
      userId: req.user._id,
    });
    if (confirmedOrder) {
      logger.info(
        `[verifyPayment] Order ${confirmedOrder.orderNumber} already confirmed — idempotent response`,
      );
      return sendResponse(res, 200, "Payment already verified.", {
        order: {
          _id: confirmedOrder._id,
          orderNumber: confirmedOrder.orderNumber,
          status: confirmedOrder.status,
        },
      });
    }
    throw new ApiError(404, "Order not found.");
  }

  // 4. Update Payment record
  await Payment.findByIdAndUpdate(order.paymentId, {
    $set: {
      razorpayPaymentId,
      razorpaySignature,
      status: "captured",
      paidAt: new Date(),
    },
  });

  // 5. Deduct stock now that payment is atomically confirmed
  await deductStock(order.items);

  // 6. Clear the cart
  await Cart.findOneAndUpdate(
    { userId: req.user._id },
    { $set: { items: [] } },
  );

  // 7. Auto-create Shiprocket shipment (non-throwing)
  await autoCreateShipment(order, req.user);
  await order.save(); // persist AWB fields written by autoCreateShipment

  logger.info(
    `[verifyPayment] Order ${order.orderNumber} confirmed. AWB: ${order.awbCode || "pending"}`,
  );

  // 8. Send confirmation email (fire-and-forget)
  sendOrderConfirmationEmail({
    email: req.user.email,
    name: req.user.name,
    order,
  });

  return sendResponse(res, 200, "Payment verified. Order confirmed.", {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total,
      awbCode: order.awbCode,
      courierName: order.courierName,
    },
  });
});

// ─── Razorpay Webhook ─────────────────────────────────────────────────────────

const razorpayWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.body; // Buffer

  // 1. Verify signature
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

  // 2. Parse payload
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
      // Fallback path: fires if user closed browser before /verify ran.
      // Uses same atomic findOneAndUpdate pattern to prevent double-deduction.
      case "payment.captured": {
        const payment = await Payment.findOne({
          razorpayOrderId: payload.order_id,
        });
        if (!payment) break;

        if (payment.status !== "captured") {
          await Payment.findByIdAndUpdate(payment._id, {
            $set: {
              razorpayPaymentId: payload.id,
              status: "captured",
              paidAt: new Date(),
              webhookPayload: payload,
            },
          });
        }

        // Atomic confirm — same guard as /verify
        const order = await Order.findOneAndUpdate(
          { _id: payment.orderId, status: "pending" },
          {
            $set: { status: "confirmed" },
            $push: {
              statusHistory: {
                status: "confirmed",
                note: `Confirmed via Razorpay webhook (payment.captured). Payment: ${payload.id}`,
              },
            },
          },
          { new: true },
        );

        if (order) {
          // Only deduct if we won the atomic transition
          await deductStock(order.items);
          await Cart.findOneAndUpdate(
            { userId: order.userId },
            { $set: { items: [] } },
          );

          const user = await User.findById(order.userId).select("email name");
          if (user) {
            await autoCreateShipment(order, user);
            await order.save();
            sendOrderConfirmationEmail({
              email: user.email,
              name: user.name,
              order,
            });
          }

          logger.info(
            `[razorpayWebhook] Order ${order.orderNumber} confirmed via webhook`,
          );
        }
        break;
      }

      // ── payment.failed ────────────────────────────────────────────────────
      // Stock was never deducted (order was 'pending') — do NOT restore.
      case "payment.failed": {
        const payment = await Payment.findOne({
          razorpayOrderId: payload.order_id,
        });
        if (!payment) break;

        await Payment.findByIdAndUpdate(payment._id, {
          $set: { status: "failed", webhookPayload: payload },
        });

        await Order.findOneAndUpdate(
          { _id: payment.orderId, status: "pending" },
          {
            $set: { status: "cancelled" },
            $push: {
              statusHistory: {
                status: "cancelled",
                note: `Payment failed. Auto-cancelled. Razorpay reason: ${payload.error_description || "unknown"}`,
              },
            },
          },
        );

        logger.info(
          `[razorpayWebhook] Payment failed for order ${payment.orderId}`,
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
    // Log but return 200 — Razorpay must not keep retrying
    logger.error(`[razorpayWebhook] Error processing event ${eventType}:`, err);
  }

  return res.status(200).json({ received: true });
};

module.exports = { verifyPayment, razorpayWebhook };
