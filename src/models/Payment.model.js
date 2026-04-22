const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    // orderId is null until order is created post-payment-verification
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    method: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
      required: true,
    },

    // Amount in paise (INR × 100)
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },

    status: {
      type: String,
      enum: ["created", "captured", "failed", "refunded"],
      default: "created",
    },

    // Razorpay IDs
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    razorpaySignature: { type: String, default: null, select: false },

    // Pending order metadata — stored here before the Order document is created.
    // Cleared (kept for audit) after order creation.
    pendingOrderMeta: {
      type: Object,
      default: null,
      select: false, // never expose to client
    },

    // Refund
    refundId: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0 },

    paidAt: { type: Date, default: null },

    // Raw webhook payload for audit
    webhookPayload: { type: Object, default: null, select: false },
  },
  { timestamps: true },
);

paymentSchema.index({ orderId: 1 });
paymentSchema.index({ userId: 1 });
paymentSchema.index({ razorpayOrderId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ razorpayPaymentId: 1 });

// Idempotency key index — fixes full collection scan on every checkout (audit fix 5.3)
paymentSchema.index({ "pendingOrderMeta.idempotencyKey": 1 }, { sparse: true });

module.exports = mongoose.model("Payment", paymentSchema);
