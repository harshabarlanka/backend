const Order = require('../models/Order.model');
const Cart = require('../models/Cart.model');
const Payment = require('../models/Payment.model');
const { verifyPaymentSignature, verifyWebhookSignature } = require('../services/razorpay.service');
const { sendOrderConfirmationEmail } = require('../services/email.service');
const { deductStock, restoreStock } = require('./order.controller');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');
const logger = require('../utils/logger');

// ─── Verify Razorpay Payment ──────────────────────────────────────────────────
// Called by the frontend immediately after the Razorpay checkout modal closes.

const verifyPayment = catchAsync(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !orderId) {
    throw new ApiError(400, 'Missing payment verification fields.');
  }

  // 1. Verify HMAC signature (Bug 3 fixed in razorpay.service.js — now safe)
  const isValid = verifyPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  if (!isValid) {
    logger.warn(`Invalid payment signature for order ${orderId} by user ${req.user._id}`);
    throw new ApiError(400, 'Payment verification failed. Signature mismatch.');
  }

  // 2. Find the order — must belong to the authenticated user
  const order = await Order.findOne({ _id: orderId, userId: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found.');

  // 3. Idempotency guard — if already confirmed (e.g. webhook beat us here), return success
  if (order.status !== 'pending') {
    return sendResponse(res, 200, 'Payment already verified.', {
      order: { _id: order._id, orderNumber: order.orderNumber, status: order.status },
    });
  }

  // 4. Update Payment record
  const payment = await Payment.findByIdAndUpdate(
    order.paymentId,
    {
      $set: {
        razorpayPaymentId,
        razorpaySignature,
        status: 'captured',
        paidAt: new Date(),
      },
    },
    { new: true }
  );

  if (!payment) throw new ApiError(404, 'Payment record not found.');

  // 5. Confirm the order
  order.status = 'confirmed';
  order.statusHistory.push({
    status: 'confirmed',
    note: `Payment captured. Razorpay Payment ID: ${razorpayPaymentId}`,
    updatedBy: req.user._id,
  });
  await order.save();

  // 6. Deduct stock now that payment is confirmed
  await deductStock(order.items);

  // 7. Clear the cart server-side
  await Cart.findOneAndUpdate({ userId: req.user._id }, { $set: { items: [] } });

  // 8. Send confirmation email (fire-and-forget)
  sendOrderConfirmationEmail({ email: req.user.email, name: req.user.name, order });

  logger.info(`Payment verified and order confirmed: ${order.orderNumber}`);

  return sendResponse(res, 200, 'Payment verified. Order confirmed.', {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total,
    },
  });
});

// ─── Razorpay Webhook Handler ─────────────────────────────────────────────────
// POST /api/payment/webhook
// Raw body parsing is configured in app.js — req.body is a Buffer here.

const razorpayWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // Buffer

  // 1. Verify webhook signature (Bug 3 fixed — now returns false instead of throwing)
  let isValid = false;
  try {
    isValid = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    logger.warn('Webhook signature verification failed:', err.message);
    return res.status(400).json({ received: false });
  }

  if (!isValid) {
    logger.warn('Invalid Razorpay webhook signature.');
    return res.status(400).json({ received: false });
  }

  // 2. Parse the raw body
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ received: false, message: 'Invalid JSON payload' });
  }

  const eventType = event.event;
  const payload = event.payload?.payment?.entity || {};

  logger.info(`Razorpay webhook received: ${eventType}`);

  try {
    switch (eventType) {

      // ── Payment captured ────────────────────────────────────────────────────
      // Idempotent fallback in case the /verify endpoint wasn't called
      // (e.g. user closed browser before the handler ran).
      case 'payment.captured': {
        const payment = await Payment.findOne({ razorpayOrderId: payload.order_id });
        if (payment && payment.status !== 'captured') {
          await Payment.findByIdAndUpdate(payment._id, {
            $set: {
              razorpayPaymentId: payload.id,
              status: 'captured',
              paidAt: new Date(),
              webhookPayload: payload,
            },
          });

          const order = await Order.findById(payment.orderId);
          if (order && order.status === 'pending') {
            order.status = 'confirmed';
            order.statusHistory.push({
              status: 'confirmed',
              note: 'Confirmed via Razorpay webhook (payment.captured).',
            });
            await order.save();
            await deductStock(order.items);
            await Cart.findOneAndUpdate({ userId: order.userId }, { $set: { items: [] } });
          }
        }
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────────
      // FIX Bug 1: Original code cancelled the order but never restored stock.
      // For a payment.failed event the order is still in 'pending' status,
      // meaning stock was NEVER deducted (deduction only happens on captured).
      // Therefore we must NOT call restoreStock() here.
      // We simply mark the order and payment as failed/cancelled.
      // If by some race condition the order was already 'confirmed' (webhook
      // arrived late after /verify succeeded), we skip the cancel entirely.
      case 'payment.failed': {
        const payment = await Payment.findOne({ razorpayOrderId: payload.order_id });
        if (payment) {
          await Payment.findByIdAndUpdate(payment._id, {
            $set: { status: 'failed', webhookPayload: payload },
          });

          const order = await Order.findById(payment.orderId);
          if (order && order.status === 'pending') {
            // Order is pending → stock was never deducted → no restoreStock() needed
            await Order.findByIdAndUpdate(payment.orderId, {
              $set: { status: 'cancelled' },
              $push: {
                statusHistory: {
                  status: 'cancelled',
                  note: 'Payment failed. Order automatically cancelled.',
                },
              },
            });
            logger.info(
              `Order ${order.orderNumber} cancelled due to payment.failed webhook.`
            );
          } else if (order && order.status === 'confirmed') {
            // Payment already captured via /verify endpoint — ignore the failed event.
            logger.warn(
              `payment.failed webhook for already-confirmed order ${order.orderNumber} — ignoring.`
            );
          }
        }
        break;
      }

      // ── Refund created ──────────────────────────────────────────────────────
      case 'refund.created': {
        const refundPayload = event.payload?.refund?.entity || {};
        await Payment.findOneAndUpdate(
          { razorpayPaymentId: refundPayload.payment_id },
          {
            $set: {
              status: 'refunded',
              refundId: refundPayload.id,
              refundedAt: new Date(),
              refundAmount: refundPayload.amount,
            },
          }
        );
        break;
      }

      default:
        logger.info(`Unhandled Razorpay webhook event: ${eventType}`);
    }
  } catch (err) {
    // Log but still return 200 so Razorpay doesn't keep retrying
    logger.error(`Error processing webhook event ${eventType}:`, err);
  }

  return res.status(200).json({ received: true });
};

// ─── Confirm COD Collection (Admin) ──────────────────────────────────────────

const confirmCODCollection = catchAsync(async (req, res) => {
  const { orderId } = req.params;

  const order = await Order.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found.');

  if (order.paymentMethod !== 'cod') {
    throw new ApiError(400, 'This order is not a COD order.');
  }

  if (order.isCodCollected) {
    throw new ApiError(400, 'COD payment has already been marked as collected.');
  }

  order.isCodCollected = true;
  order.codCollectedAt = new Date();
  order.status = 'delivered';
  order.statusHistory.push({
    status: 'delivered',
    note: 'COD payment collected and order delivered.',
    updatedBy: req.user._id,
  });
  await order.save();

  await Payment.findByIdAndUpdate(order.paymentId, {
    $set: { status: 'cod_collected', paidAt: new Date() },
  });

  return sendResponse(res, 200, 'COD payment confirmed and order marked as delivered.', { order });
});

module.exports = {
  verifyPayment,
  razorpayWebhook,
  confirmCODCollection,
};
