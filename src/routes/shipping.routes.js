/**
 * Shipping Routes
 * ───────────────
 * Hosts the NimbusPost webhook endpoint separately from payment routes
 * to keep concerns clean and allow independent raw-body parsing config.
 *
 * Base: /api/shipping
 */

const express = require('express');
const router = express.Router();

const { nimbusWebhook } = require('../controllers/nimbuspost.webhook.controller');

/**
 * POST /api/shipping/webhook
 *
 * Receives real-time shipment status updates from NimbusPost.
 * - Raw body parsing is configured in app.js for this route
 * - No auth middleware — NimbusPost calls this from their servers
 * - Signature verification is handled inside nimbusWebhook()
 *
 * Register this URL in your NimbusPost dashboard under:
 * Settings → Webhook → Shipment Status Webhook URL
 */
router.post('/webhook', nimbusWebhook);

module.exports = router;
