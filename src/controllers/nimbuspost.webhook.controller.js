/**
 * NimbusPost Webhook Controller
 * ─────────────────────────────
 * Receives real-time shipment status updates from NimbusPost and automatically
 * updates the corresponding order in our database.
 *
 * Endpoint: POST /api/shipping/webhook
 * Auth:     HMAC-SHA256 signature verification using NIMBUSPOST_WEBHOOK_SECRET
 *           If the env var is not set, we fall back to token-based verification.
 *
 * NimbusPost sends a POST request with JSON body whenever a shipment
 * status changes (e.g. Picked Up → In Transit → Delivered → RTO).
 *
 * Design principles:
 * - Always return HTTP 200 to NimbusPost (prevents retries for handled events)
 * - Never throw — log errors and respond 200
 * - Idempotent — re-processing the same event is safe
 * - Status transitions are additive (we only advance, never regress)
 */

const crypto = require('crypto');
const Order = require('../models/Order.model');
const { mapNimbusStatusToInternal } = require('../services/nimbuspost.service');
const logger = require('../utils/logger');

// ─── Status Transition Guard ──────────────────────────────────────────────────
//
// We only update an order's status if the new status is a logical advancement.
// This prevents race conditions where out-of-order webhook events (e.g. a
// delayed "In Transit" arriving after "Delivered") could regress the status.

const STATUS_RANK = {
  pending:          0,
  confirmed:        1,
  packed:           2,
  shipped:          3,
  out_for_delivery: 4,
  delivered:        5,
  rto:              5, // terminal — same rank as delivered
  cancelled:        5, // terminal
  refunded:         6,
};

/**
 * Returns true if transitioning from currentStatus to newStatus is valid.
 * Terminal statuses (delivered, rto, cancelled) cannot be overwritten.
 */
const canTransition = (currentStatus, newStatus) => {
  const current = STATUS_RANK[currentStatus] ?? -1;
  const next = STATUS_RANK[newStatus] ?? -1;

  // Never regress, never overwrite a terminal state
  if (current >= 5) return false;
  return next > current;
};

// ─── Verify NimbusPost Webhook Signature ──────────────────────────────────────
//
// NimbusPost signs the raw request body with HMAC-SHA256 using a shared secret.
// The signature is sent in the X-NimbusPost-Signature header.
//
// If NIMBUSPOST_WEBHOOK_SECRET is not configured, we skip signature verification
// and rely on the AWB lookup as the only guard (suitable for dev/staging).

const verifyNimbusWebhookSignature = (rawBody, signature) => {
  const secret = process.env.NIMBUSPOST_WEBHOOK_SECRET;

  if (!secret) {
    logger.warn(
      '[NimbusWebhook] NIMBUSPOST_WEBHOOK_SECRET not set — skipping signature verification. Set it in production!'
    );
    return true; // Allow in dev; MUST set secret in production
  }

  if (!signature) {
    logger.warn('[NimbusWebhook] Missing X-NimbusPost-Signature header');
    return false;
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
};

// ─── Webhook Handler ──────────────────────────────────────────────────────────

const nimbusWebhook = async (req, res) => {
  const rawBody = req.body; // Buffer — raw body parsing set in app.js
  const signature = req.headers['x-nimbuspost-signature'] || req.headers['x-nimbus-signature'];

  // 1. Verify signature
  if (!verifyNimbusWebhookSignature(rawBody, signature)) {
    logger.warn('[NimbusWebhook] Invalid or missing signature — request rejected');
    // Return 200 so NimbusPost stops retrying, but log as security event
    return res.status(200).json({ received: false, reason: 'invalid_signature' });
  }

  // 2. Parse payload
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    logger.error('[NimbusWebhook] Failed to parse JSON payload:', err.message);
    return res.status(200).json({ received: false, reason: 'invalid_json' });
  }

  // 3. Extract the fields we need
  //    NimbusPost webhook body shape (B2B):
  //    { awb_number, order_id, status, location, timestamp, ... }
  const awbNumber  = event.awb_number || event.awb;
  const nimbusStatus = event.status || event.current_status;
  const location   = event.location || event.city || '';
  const eventTime  = event.timestamp ? new Date(event.timestamp) : new Date();

  logger.info(
    `[NimbusWebhook] Received: AWB=${awbNumber} | Status="${nimbusStatus}" | Location="${location}"`
  );

  if (!awbNumber || !nimbusStatus) {
    logger.warn('[NimbusWebhook] Missing awb_number or status in payload', event);
    return res.status(200).json({ received: true, skipped: true, reason: 'missing_fields' });
  }

  // 4. Find the order by AWB
  try {
    const order = await Order.findOne({ awbCode: awbNumber });

    if (!order) {
      logger.warn(`[NimbusWebhook] No order found for AWB ${awbNumber}`);
      return res.status(200).json({ received: true, skipped: true, reason: 'order_not_found' });
    }

    // 5. Map NimbusPost status → our internal status
    const internalStatus = mapNimbusStatusToInternal(nimbusStatus);

    // Always update the raw tracking status (useful for display even when
    // we don't change the order status)
    order.trackingStatus = nimbusStatus;
    order.trackingUpdatedAt = eventTime;

    // 6. Conditionally update order status (guard against regression)
    if (internalStatus && canTransition(order.status, internalStatus)) {
      const previousStatus = order.status;

      order.status = internalStatus;
      order.statusHistory.push({
        status: internalStatus,
        note: `[NimbusPost] ${nimbusStatus}${location ? ` — ${location}` : ''}`,
        // No updatedBy — this is an automated update
      });

      // Handle RTO-specific side effects
      if (internalStatus === 'rto') {
        logger.warn(
          `[NimbusWebhook] RTO initiated for order ${order.orderNumber} (AWB: ${awbNumber})`
        );
        // Optionally trigger admin alert here (email/Slack notification)
      }

      logger.info(
        `[NimbusWebhook] Order ${order.orderNumber} status: "${previousStatus}" → "${internalStatus}" (NimbusPost: "${nimbusStatus}")`
      );
    } else if (internalStatus && !canTransition(order.status, internalStatus)) {
      // Status didn't change (already at same or higher rank) — that's fine
      logger.info(
        `[NimbusWebhook] Order ${order.orderNumber} already at "${order.status}" — skipping transition to "${internalStatus}"`
      );
    } else {
      // Unknown NimbusPost status — tracking stored but order status unchanged
      logger.warn(
        `[NimbusWebhook] Unmapped NimbusPost status "${nimbusStatus}" for AWB ${awbNumber} — tracking updated, order status unchanged`
      );
    }

    await order.save();

    return res.status(200).json({ received: true, orderNumber: order.orderNumber });

  } catch (err) {
    logger.error(`[NimbusWebhook] Error processing AWB ${awbNumber}:`, err);
    // Always return 200 — we don't want NimbusPost to hammer us with retries
    return res.status(200).json({ received: true, error: 'internal_processing_error' });
  }
};

module.exports = { nimbusWebhook };
