const mongoose = require('mongoose');

// ── Order Item ───────────────────────────────────────────────────────────────
const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    size: { type: String, required: true },
    image: { type: String, default: '' },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    weightGrams: { type: Number, default: 500 },
  },
  { _id: true },
);

// ── Shipping Address ─────────────────────────────────────────────────────────
const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, default: 'India' },
  },
  { _id: false },
);

// ── Status History ───────────────────────────────────────────────────────────
const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    note: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// ── Tracking Events ──────────────────────────────────────────────────────────
const trackingEventSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true },
    status: { type: String, required: true },
    location: { type: String, default: '' },
    activity: { type: String, default: '' },
  },
  { _id: false },
);

// ── Main Order Schema ─────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      required: true,
    },

    idempotencyKey: {
      type: String,
      sparse: true,
      unique: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    items: {
      type: [orderItemSchema],
      validate: [
        (arr) => arr.length > 0,
        'Order must contain at least one item',
      ],
    },

    shippingAddress: { type: shippingAddressSchema, required: true },

    // Only razorpay is accepted — COD is not supported
    paymentMethod: {
      type: String,
      enum: ['razorpay'],
      default: 'razorpay',
      required: true,
    },

    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

    // ── Order Status ─────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: [
        'confirmed',
        'preparing',
        'ready_for_pickup',
        'shipped',
        'out_for_delivery',
        'delivered',
        'cancelled',
        'rto',
        'refunded',
      ],
      default: 'confirmed',
    },

    statusHistory: [statusHistorySchema],

    // ── Shiprocket ───────────────────────────────────────────────────────────
    shiprocketOrderId: { type: String, default: null },
    shiprocketShipmentId: { type: String, default: null },
    awbCode: { type: String, default: null },

    courierId: { type: Number, default: null },
    courierName: { type: String, default: null },
    shippingCost: { type: Number, default: 0 },
    etd: { type: String, default: null },

    trackingStatus: { type: String, default: null },
    trackingUpdatedAt: { type: Date, default: null },
    trackingHistory: { type: [trackingEventSchema], default: [] },

    estimatedDeliveryDate: { type: Date, default: null },

    awbRetryCount: { type: Number, default: 0 },

    // ── RTO fields ───────────────────────────────────────────────────────────
    rtoStatus: {
      type: String,
      enum: ['none', 'initiated', 'in_transit', 'delivered'],
      default: 'none',
    },
    rtoReason: { type: String, default: null, maxlength: 300 },
    rtoInitiatedAt: { type: Date, default: null },
    rtoDeliveredAt: { type: Date, default: null },
    autoRefundAttempted: { type: Boolean, default: false },
    autoRefundId: { type: String, default: null },

    // ── Docs ─────────────────────────────────────────────────────────────────
    invoiceUrl: { type: String, default: null },
    labelUrl: { type: String, default: null },

    // ── Coupon ───────────────────────────────────────────────────────────────
    couponCode: { type: String, default: null, uppercase: true },
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Coupon',
      default: null,
    },
    discountAmount: { type: Number, default: 0 },

    // ── Pricing ──────────────────────────────────────────────────────────────
    subtotal: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    notes: { type: String, maxlength: 300, default: '' },

    // ── Cancellation ─────────────────────────────────────────────────────────
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
    cancelReason: { type: String, maxlength: 300 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ── Indexes ───────────────────────────────────────────────────────────────────
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ awbCode: 1 });
orderSchema.index({ awbCode: 1, status: 1 });
orderSchema.index({ shiprocketOrderId: 1 });
orderSchema.index({ trackingStatus: 1, createdAt: -1, awbRetryCount: 1 });
orderSchema.index({ couponCode: 1 });
orderSchema.index({ rtoStatus: 1, autoRefundAttempted: 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────
orderSchema.virtual('isDelivered').get(function () {
  return this.status === 'delivered';
});

orderSchema.virtual('canCancel').get(function () {
  if (this.awbCode) return false;
  return ['confirmed', 'preparing'].includes(this.status);
});

module.exports = mongoose.model('Order', orderSchema);
