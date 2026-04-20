/**
 * Shiprocket Webhook Controller
 * ──────────────────────────────
 * Receives real-time shipment status updates from Shiprocket and updates
 * the corresponding order in our database.
 *
 * Endpoint: POST /api/shipping/webhook
 * Auth:     HMAC-SHA256 signature verification using SHIPROCKET_WEBHOOK_SECRET
 *
 * Shiprocket sends a POST request with JSON body whenever a shipment
 * status changes (e.g. Picked Up → In Transit → Delivered → RTO).
 *
 * Design principles:
 * - Always return HTTP 200 to Shiprocket (prevents retries for handled events)
 * - Never throw — log errors and respond 200
 * - Idempotent — re-processing the same event is safe
 * - Status transitions are additive (only advance, never regress)
 */

const crypto = require('crypto');
const Order = require('../models/Order.model');
const { mapShiprocketStatusToInternal } = require('../services/shiprocket.service');
const logger = require('../utils/logger');

// ─── Status Transition Guard ──────────────────────────────────────────────────

const STATUS_RANK = {
  pending:          0,
  confirmed:        1,
  packed:           2,
  shipped:          3,
  out_for_delivery: 4,
  delivered:        5,
  rto:              5, // terminal
  cancelled:        5, // terminal
  refunded:         6,
};

const canTransition = (currentStatus, newStatus) => {
  const current = STATUS_RANK[currentStatus] ?? -1;
  const next    = STATUS_RANK[newStatus]    ?? -1;
  if (current >= 5) return false; // never overwrite terminal state
  return next > current;
};

// ─── Verify Shiprocket Webhook Signature ──────────────────────────────────────
//
// Shiprocket signs the raw request body with HMAC-SHA256.
// Header: X-Shiprocket-Hmac-Sha256

const verifyShiprocketSignature = (rawBody, signature) => {
  const secret = process.env.SHIPROCKET_WEBHOOK_SECRET;

  if (!secret) {
    logger.warn(
      '[ShiprocketWebhook] SHIPROCKET_WEBHOOK_SECRET not set — skipping signature verification. Set it in production!'
    );
    return true; // Allow in dev — MUST set secret in production
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
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
};

// ─── Webhook Handler ──────────────────────────────────────────────────────────

const shiprocketWebhook = async (req, res) => {
  const rawBody  = req.body; // Buffer — raw body parsing set in app.js
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
  // Shiprocket webhook payload shape:
  // { awb, order_id, current_status, shipment_status, location, updated_at, ... }
  const awbNumber     = event.awb || event.awb_number;
  const srStatus      = event.current_status || event.shipment_status || event.status;
  const location      = event.location || event.city || '';
  const eventTime     = event.updated_at ? new Date(event.updated_at) : new Date();

  logger.info(
    `[ShiprocketWebhook] Received: AWB=${awbNumber} | Status="${srStatus}" | Location="${location}"`
  );

  if (!awbNumber || !srStatus) {
    logger.warn('[ShiprocketWebhook] Missing awb or current_status in payload', event);
    return res.status(200).json({ received: true, skipped: true, reason: 'missing_fields' });
  }

  // 4. Find order by AWB
  try {
    const order = await Order.findOne({ awbCode: awbNumber });

    if (!order) {
      logger.warn(`[ShiprocketWebhook] No order found for AWB ${awbNumber}`);
      return res.status(200).json({ received: true, skipped: true, reason: 'order_not_found' });
    }

    // 5. Map Shiprocket status → internal status
    const internalStatus = mapShiprocketStatusToInternal(srStatus);

    // Always update raw tracking status
    order.trackingStatus    = srStatus;
    order.trackingUpdatedAt = eventTime;

    // 6. Conditionally update order status (guard against regression)
    if (internalStatus && canTransition(order.status, internalStatus)) {
      const previousStatus = order.status;

      order.status = internalStatus;
      order.statusHistory.push({
        status: internalStatus,
        note: `[Shiprocket] ${srStatus}${location ? ` — ${location}` : ''}`,
      });

      if (internalStatus === 'rto') {
        logger.warn(
          `[ShiprocketWebhook] RTO initiated for order ${order.orderNumber} (AWB: ${awbNumber})`
        );
      }

      logger.info(
        `[ShiprocketWebhook] Order ${order.orderNumber}: "${previousStatus}" → "${internalStatus}" (Shiprocket: "${srStatus}")`
      );
    } else if (internalStatus && !canTransition(order.status, internalStatus)) {
      logger.info(
        `[ShiprocketWebhook] Order ${order.orderNumber} already at "${order.status}" — skipping transition to "${internalStatus}"`
      );
    } else {
      logger.warn(
        `[ShiprocketWebhook] Unmapped status "${srStatus}" for AWB ${awbNumber} — tracking updated, order status unchanged`
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
