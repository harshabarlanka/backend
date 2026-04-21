const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // COD REMOVED
    method: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
      required: true,
    },

    // Amount in paise (INR × 100) — always
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

    // Refund
    refundId: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0 },

    paidAt: { type: Date, default: null },

    // Raw webhook payload for audit — never expose to client
    webhookPayload: { type: Object, default: null, select: false },
  },
  { timestamps: true },
);

paymentSchema.index({ orderId: 1 });
paymentSchema.index({ userId: 1 });
paymentSchema.index({ razorpayOrderId: 1 });
paymentSchema.index({ razorpayPaymentId: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
