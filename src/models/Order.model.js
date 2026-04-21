const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    size: { type: String, required: true },
    image: { type: String, default: "" },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: true },
);

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: { type: String, default: "" },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, default: "India" },
  },
  { _id: false },
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    note: { type: String, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const trackingEventSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true },
    status: { type: String, required: true },
    location: { type: String, default: "" },
    activity: { type: String, default: "" },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true, required: true },

    // Idempotency: prevents duplicate orders from double-click or network retry
    idempotencyKey: { type: String, sparse: true, unique: true },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    items: {
      type: [orderItemSchema],
      validate: [
        (arr) => arr.length > 0,
        "Order must contain at least one item",
      ],
    },

    shippingAddress: { type: shippingAddressSchema, required: true },

    // COD REMOVED — only razorpay
    paymentMethod: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
      required: true,
    },

    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },

    status: {
      type: String,
      enum: [
        "pending",
        "confirmed",
        "packed",
        "shipped",
        "out_for_delivery",
        "delivered",
        "cancelled",
        "rto",
        "refunded",
      ],
      default: "pending",
    },

    statusHistory: [statusHistorySchema],

    // ── Shiprocket Fields ──────────────────────────────────────────────────────
    shiprocketOrderId: { type: String, default: null },
    shiprocketShipmentId: { type: String, default: null },
    awbCode: { type: String, default: null },
    courierName: { type: String, default: null },

    // Raw status string from Shiprocket (e.g. "In Transit", "Delivered")
    trackingStatus: { type: String, default: null },
    trackingUpdatedAt: { type: Date, default: null },

    // Full tracking event log — persisted to avoid repeated API calls
    trackingHistory: { type: [trackingEventSchema], default: [] },

    // Estimated delivery date from Shiprocket
    estimatedDeliveryDate: { type: Date, default: null },

    // AWB retry cron tracking (BUG-5 fix)
    awbRetryCount: { type: Number, default: 0 },

    // ── Pricing ───────────────────────────────────────────────────────────────
    subtotal: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    notes: { type: String, maxlength: 300, default: "" },

    // ── Cancellation metadata ─────────────────────────────────────────────────
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancelledAt: { type: Date },
    cancelReason: { type: String, maxlength: 300 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ── Indexes ────────────────────────────────────────────────────────────────────
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ awbCode: 1 });
orderSchema.index({ shiprocketOrderId: 1 });
orderSchema.index({ trackingStatus: 1, createdAt: -1, awbRetryCount: 1 }); // AWB retry cron
orderSchema.index({ idempotencyKey: 1 }); // duplicate guard

orderSchema.virtual("isDelivered").get(function () {
  return this.status === "delivered";
});

module.exports = mongoose.model("Order", orderSchema);
