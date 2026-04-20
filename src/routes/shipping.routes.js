/**
 * Shipping Routes
 * ───────────────
 * Hosts the Shiprocket webhook endpoint separately from payment routes
 * to keep concerns clean and allow independent raw-body parsing config.
 *
 * Base: /api/shipping
 */

const express = require('express');
const router = express.Router();

const { shiprocketWebhook } = require('../controllers/shiprocket.webhook.controller');

/**
 * POST /api/shipping/webhook
 *
 * Receives real-time shipment status updates from Shiprocket.
 * - Raw body parsing is configured in app.js for this route
 * - No auth middleware — Shiprocket calls this from their servers
 * - Signature verification is handled inside shiprocketWebhook()
 *
 * Register this URL in your Shiprocket dashboard under:
 * Settings → API → Webhook URL
 */
router.post('/webhook', shiprocketWebhook);

module.exports = router;
