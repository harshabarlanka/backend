const crypto = require('crypto');
const Order = require('../models/Order.model');
const {
  mapShiprocketStatusToInternal,
} = require('../services/shiprocket.service');
const logger = require('../utils/logger');

// ─── Status Transition Guard ──────────────────────────────────────────────────

const STATUS_RANK = {
  pending: 0,
  confirmed: 1,
  packed: 2,
  shipped: 3,
  out_for_delivery: 4,
  delivered: 5,
  rto: 5, // terminal
  cancelled: 5, // terminal
  refunded: 6,
};

const canTransition = (currentStatus, newStatus) => {
  // Always allow cancellation override
  if (newStatus === 'cancelled') return true;

  const current = STATUS_RANK[currentStatus] ?? -1;
  const next = STATUS_RANK[newStatus] ?? -1;

  if (current >= 5) return false;
  return next > current;
};

// ─── Verify Shiprocket Webhook Signature ──────────────────────────────────────
//
// Audit fix 1.6: missing secret is a hard failure in non-development environments.
// Previously it silently allowed any request if the env var was missing.

const verifyShiprocketSignature = (rawBody, signature) => {
  const secret = process.env.SHIPROCKET_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV !== 'development') {
      // Hard fail in production — never silently allow
      logger.error('[ShiprocketWebhook] SHIPROCKET_WEBHOOK_SECRET is not set in production!');
      return false;
    }
    logger.warn('[ShiprocketWebhook] Skipping signature check (dev mode only)');
    return true;
  }

  if (!signature) {
    logger.warn('[ShiprocketWebhook] Missing X-Shiprocket-Hmac-Sha256 header');
    return false;
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
};

// ─── Webhook Handler ──────────────────────────────────────────────────────────

const shiprocketWebhook = async (req, res) => {
  const rawBody = req.body; // Buffer — raw body parsing set in app.js
  const signature = req.headers['x-shiprocket-hmac-sha256'] || '';

  // 1. Verify signature
  if (!verifyShiprocketSignature(rawBody, signature)) {
    logger.warn('[ShiprocketWebhook] Invalid or missing signature — request rejected');
    return res.status(200).json({ received: false, reason: 'invalid_signature' });
  }

  // 2. Parse payload
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    logger.error('[ShiprocketWebhook] Failed to parse JSON payload:', err.message);
    return res.status(200).json({ received: false, reason: 'invalid_json' });
  }

  // 3. Extract fields
  const awbNumber = event.awb || event.awb_number;
  const srStatus = event.current_status || event.shipment_status || event.status;
  const location = event.location || event.city || '';
  const eventTime = event.updated_at ? new Date(event.updated_at) : new Date();

  logger.info(
    `[ShiprocketWebhook] Received: AWB=${awbNumber} | Status="${srStatus}" | Location="${location}"`,
  );

  if (!awbNumber || !srStatus) {
    logger.warn('[ShiprocketWebhook] Missing awb or current_status in payload', event);
    return res.status(200).json({ received: true, skipped: true, reason: 'missing_fields' });
  }

  // 4. Find order by AWB — populate paymentId for RTO auto-refund check
  try {
    const order = await Order.findOne({ awbCode: awbNumber }).populate('paymentId');

    if (!order) {
      logger.warn(`[ShiprocketWebhook] No order found for AWB ${awbNumber}`);
      return res.status(200).json({ received: true, skipped: true, reason: 'order_not_found' });
    }

    // 5. Map Shiprocket status → internal status
    const internalStatus = mapShiprocketStatusToInternal(srStatus);
    const previousStatus = order.status;

    // ── Audit fix 1.3: Idempotency — deduplicate tracking events ──────────────
    // Shiprocket delivers webhooks at-least-once; use a 5-second window to absorb
    // clock skew between Shiprocket's servers and ours.
    const isDuplicate = order.trackingHistory.some(
      (e) => e.status === srStatus && Math.abs(new Date(e.timestamp) - eventTime) < 5000,
    );

    if (!isDuplicate) {
      order.trackingHistory.push({
        timestamp: eventTime,
        status: srStatus,
        location,
        activity: event.activity || srStatus,
      });

      // Trim to last 50 events to avoid bloating the document
      if (order.trackingHistory.length > 50) {
        order.trackingHistory = order.trackingHistory.slice(-50);
      }
    }

    order.trackingStatus = srStatus;
    order.trackingUpdatedAt = eventTime;

    // 6. Conditionally update order status (guard against regression)
    if (internalStatus && canTransition(order.status, internalStatus)) {
      order.status = internalStatus;
      order.statusHistory.push({
        status: internalStatus,
        note: `[Shiprocket] ${srStatus}${location ? ` — ${location}` : ''}`,
      });

      logger.info(
        `[ShiprocketWebhook] Order ${order.orderNumber}: "${previousStatus}" → "${internalStatus}" (Shiprocket: "${srStatus}")`,
      );

      // ── Audit fix 1.1: RTO side-effects ──────────────────────────────────────
      // When an RTO is initiated: restore inventory + auto-refund prepaid orders.
      if (internalStatus === 'rto' && previousStatus !== 'rto') {
        order.rtoStatus = 'initiated';
        order.rtoInitiatedAt = eventTime;
        order.rtoReason = event.rto_reason || event.reason || null;

        // Save before side-effects so the RTO state is persisted even if
        // stock/refund calls throw
        await order.save();

        // 1. Restore inventory
        const { restoreStock } = require('../utils/stock');
        await restoreStock(order.items);
        logger.info(`[ShiprocketWebhook] Stock restored for RTO order ${order.orderNumber}`);

        // 2. Auto-refund prepaid orders (skip COD and already-attempted refunds)
        const payment = order.paymentId;
        if (
          payment?.razorpayPaymentId &&
          payment.status === 'captured' &&
          !order.autoRefundAttempted
        ) {
          try {
            const { initiateRefund } = require('../services/razorpay.service');
            const Payment = require('../models/Payment.model');

            const refund = await initiateRefund(payment.razorpayPaymentId, order.total * 100);

            await Payment.findByIdAndUpdate(payment._id, {
              $set: { status: 'refunded', refundId: refund.id, refundedAt: new Date() },
            });

            order.status = 'refunded';
            order.autoRefundAttempted = true;
            order.autoRefundId = refund.id;
            order.statusHistory.push({
              status: 'refunded',
              note: `Auto-refund on RTO: ${refund.id}`,
            });

            await order.save();
            logger.info(
              `[ShiprocketWebhook] Auto-refund ${refund.id} for RTO order ${order.orderNumber}`,
            );
          } catch (refundErr) {
            // Mark attempted to prevent infinite retry; ops team must handle manually
            order.autoRefundAttempted = true;
            await order.save();
            logger.error(
              `[ShiprocketWebhook] Auto-refund FAILED for ${order.orderNumber}:`,
              refundErr.message,
            );
            // TODO: alert via PagerDuty/Slack ops channel
          }
        }

        return res.status(200).json({ received: true, orderNumber: order.orderNumber });
      }

      // ── RTO delivered update ─────────────────────────────────────────────────
      if (srStatus.toLowerCase().includes('rto') && srStatus.toLowerCase().includes('deliver')) {
        order.rtoStatus = 'delivered';
        order.rtoDeliveredAt = eventTime;
      }
    } else if (internalStatus && !canTransition(order.status, internalStatus)) {
      logger.info(
        `[ShiprocketWebhook] Order ${order.orderNumber} already at "${order.status}" — skipping transition to "${internalStatus}"`,
      );
    } else {
      logger.warn(
        `[ShiprocketWebhook] Unmapped status "${srStatus}" for AWB ${awbNumber} — tracking updated, order status unchanged`,
      );
    }

    await order.save();

    return res.status(200).json({ received: true, orderNumber: order.orderNumber });
  } catch (err) {
    logger.error(`[ShiprocketWebhook] Error processing AWB ${awbNumber}:`, err);
    return res.status(200).json({ received: true, error: 'internal_processing_error' });
  }
};

module.exports = { shiprocketWebhook };
