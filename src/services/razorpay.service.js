const crypto = require('crypto');
const { getRazorpayInstance } = require('../config/razorpay');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Creates a Razorpay order (server-side).
 * The returned order_id is sent to the frontend to open the checkout modal.
 *
 * @param {number} amountInPaise  - Amount in paise (₹1 = 100 paise)
 * @param {string} receipt        - Internal reference (our order number, max 40 chars)
 * @param {object} notes          - Optional metadata attached to the order
 */
const createRazorpayOrder = async (amountInPaise, receipt, notes = {}) => {
  try {
    const razorpay = getRazorpayInstance();

    // FIX Bug 7-related: Razorpay receipt field is limited to 40 characters.
    // Our order numbers (PKL-20240101-AB3XY = 18 chars) are well within limit,
    // but we truncate defensively to prevent any future format change from crashing.
    const safeReceipt = String(receipt).slice(0, 40);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: safeReceipt,
      notes,
      payment_capture: 1, // Auto-capture on successful payment
    });

    logger.info(`Razorpay order created: ${order.id} for receipt: ${safeReceipt}`);
    return order;
  } catch (err) {
    logger.error('Failed to create Razorpay order:', err);
    throw new ApiError(502, 'Payment gateway error. Please try again.');
  }
};

/**
 * Verifies the HMAC-SHA256 signature returned by Razorpay after payment.
 * This is the critical security step — never skip this.
 *
 * Signature formula:
 *   HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
 *
 * FIX Bug 3: crypto.timingSafeEqual() throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
 * if buffers have different byte lengths (e.g. tampered/truncated signature).
 * We now check lengths first and wrap in try/catch so a bad signature returns
 * false (→ 400) instead of crashing the server with an unhandled exception (→ 500).
 *
 * @returns {boolean} true if signature is valid
 */
const verifyPaymentSignature = ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new ApiError(400, 'Missing payment verification fields.');
  }

  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  try {
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(razorpaySignature, 'hex');

    // Buffers must be equal length for timingSafeEqual; a length mismatch
    // means the signature is definitely invalid — return false immediately.
    if (expectedBuf.length !== receivedBuf.length) {
      logger.warn('Razorpay signature length mismatch — signature is invalid.');
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    // Catches cases like invalid hex strings (odd-length, non-hex chars).
    logger.warn(`Razorpay signature verification error: ${err.message}`);
    return false;
  }
};

/**
 * Verifies the Razorpay webhook signature.
 * The raw request body (Buffer) must be used — not parsed JSON.
 *
 * FIX Bug 3 (same): wrap timingSafeEqual in try/catch and check lengths.
 *
 * @param {Buffer} rawBody    - req.body (must be raw Buffer, not parsed)
 * @param {string} signature  - X-Razorpay-Signature header value
 */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!signature) {
    throw new ApiError(400, 'Missing webhook signature header.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');

    if (expectedBuf.length !== receivedBuf.length) {
      logger.warn('Razorpay webhook signature length mismatch.');
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    logger.warn(`Razorpay webhook signature verification error: ${err.message}`);
    return false;
  }
};

/**
 * Fetches payment details from Razorpay (for verification fallback / admin).
 */
const fetchRazorpayPayment = async (paymentId) => {
  try {
    const razorpay = getRazorpayInstance();
    return await razorpay.payments.fetch(paymentId);
  } catch (err) {
    logger.error(`Failed to fetch Razorpay payment ${paymentId}:`, err);
    throw new ApiError(502, 'Could not fetch payment details from gateway.');
  }
};

/**
 * Initiates a refund for a given payment.
 *
 * @param {string} paymentId       - Razorpay payment ID
 * @param {number} amountInPaise   - Amount to refund (partial or full)
 */
const initiateRefund = async (paymentId, amountInPaise) => {
  try {
    const razorpay = getRazorpayInstance();
    const refund = await razorpay.payments.refund(paymentId, {
      amount: amountInPaise,
      speed: 'normal',
    });
    logger.info(`Refund initiated: ${refund.id} for payment: ${paymentId}`);
    return refund;
  } catch (err) {
    logger.error(`Failed to initiate refund for payment ${paymentId}:`, err);
    throw new ApiError(502, 'Failed to initiate refund. Please try again.');
  }
};

module.exports = {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayPayment,
  initiateRefund,
};
