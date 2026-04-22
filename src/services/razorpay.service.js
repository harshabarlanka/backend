const crypto = require('crypto');
const { getRazorpayInstance } = require('../config/razorpay');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Creates a Razorpay order (server-side).
 */
const createRazorpayOrder = async (amountInPaise, receipt, notes = {}) => {
  try {
    const razorpay = getRazorpayInstance();

    const safeReceipt = String(receipt).slice(0, 40);

    // ❌ IMPORTANT:
    // Razorpay Node SDK DOES NOT support custom headers (idempotency key)
    // So we REMOVE it to avoid "cb is not a function"

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: safeReceipt,
      notes,
    });

    logger.info(`Razorpay order created: ${order.id} for receipt: ${safeReceipt}`);
    return order;
  } catch (err) {
    logger.error('Failed to create Razorpay order:', err);
    throw new ApiError(502, 'Payment gateway error. Please try again.');
  }
};

/**
 * Verify payment signature
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

    if (expectedBuf.length !== receivedBuf.length) {
      logger.warn('Razorpay signature length mismatch — invalid.');
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    logger.warn(`Signature verification error: ${err.message}`);
    return false;
  }
};

/**
 * Verify webhook signature
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
      logger.warn('Webhook signature length mismatch.');
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    logger.warn(`Webhook signature verification error: ${err.message}`);
    return false;
  }
};

/**
 * Fetch payment details
 */
const fetchRazorpayPayment = async (paymentId) => {
  try {
    const razorpay = getRazorpayInstance();
    return await razorpay.payments.fetch(paymentId);
  } catch (err) {
    logger.error(`Failed to fetch payment ${paymentId}:`, err);
    throw new ApiError(502, 'Could not fetch payment details.');
  }
};

/**
 * Initiate refund
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
    logger.error(`Refund failed for ${paymentId}:`, err);
    throw new ApiError(502, 'Failed to initiate refund.');
  }
};

module.exports = {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayPayment,
  initiateRefund,
};