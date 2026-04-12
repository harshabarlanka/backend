const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    method: {
      type: String,
      enum: ['razorpay', 'cod'],
      required: true,
    },
    amount: {
      type: Number,
      required: true, // in paise (INR * 100) for Razorpay; in rupees for COD
    },
    currency: {
      type: String,
      default: 'INR',
    },
    status: {
      type: String,
      enum: [
        'created',       // Razorpay order created, awaiting payment
        'captured',      // Razorpay payment successful
        'failed',        // Razorpay payment failed
        'cod_pending',   // COD order placed, awaiting delivery
        'cod_collected', // COD payment collected on delivery
        'refunded',      // Refund processed
      ],
      default: 'created',
    },
    // Razorpay-specific fields
    razorpayOrderId: { type: String, default: null },   // order_xxxxxxxx
    razorpayPaymentId: { type: String, default: null }, // pay_xxxxxxxx
    razorpaySignature: { type: String, default: null, select: false }, // Never expose
    // Refund details
    refundId: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0 },
    // Timestamps
    paidAt: { type: Date, default: null },
    // Raw webhook payload for audit
    webhookPayload: { type: Object, default: null, select: false },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
paymentSchema.index({ orderId: 1 });
paymentSchema.index({ userId: 1 });
paymentSchema.index({ razorpayOrderId: 1 });
paymentSchema.index({ razorpayPaymentId: 1 });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
