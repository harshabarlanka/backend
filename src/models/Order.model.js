const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Snapshot fields — price/name locked at purchase time
    name: { type: String, required: true },
    size: { type: String, required: true },
    image: { type: String, default: '' },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: true }
);

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
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    note: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    items: {
      type: [orderItemSchema],
      validate: [(arr) => arr.length > 0, 'Order must contain at least one item'],
    },
    shippingAddress: {
      type: shippingAddressSchema,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ['razorpay', 'cod'],
      required: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rto', 'refunded'],
      default: 'pending',
    },
    statusHistory: [statusHistorySchema],

    // ─── Shiprocket Shipment Fields ──────────────────────────────────────────
    // shiprocket* fields store Shiprocket order_id and shipment_id.
    shiprocketOrderId: { type: String, default: null },
    shiprocketShipmentId: { type: String, default: null },
    awbCode: { type: String, default: null },
    courierName: { type: String, default: null },
    // Raw tracking status string from Shiprocket webhook/polling
    trackingStatus: { type: String, default: null },
    // Timestamp of last tracking update from Shiprocket
    trackingUpdatedAt: { type: Date, default: null },
    // Flag to distinguish auto-created vs manually-created shipments
    shipmentAutoCreated: { type: Boolean, default: false },

    // Pricing breakdown
    subtotal: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    // Customer notes
    notes: { type: String, maxlength: 300, default: '' },

    // COD specific
    isCodCollected: { type: Boolean, default: false },
    codCollectedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ awbCode: 1 });

// ─── Virtual: isDelivered ────────────────────────────────────────────────────
orderSchema.virtual('isDelivered').get(function () {
  return this.status === 'delivered';
});

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
