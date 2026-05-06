const mongoose = require('mongoose');

// ─── Product cart item ────────────────────────────────────────────────────────
const productCartItemSchema = new mongoose.Schema(
  {
    itemType: { type: String, enum: ['product', 'combo'], default: 'product' },

    // For product items
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    size: { type: String, default: '' },

    // For combo items
    comboId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Combo',
    },
    // Snapshot of included products for combo (stored for display)
    comboProducts: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: { type: String },
        quantity: { type: Number, default: 1 },
        _id: false,
      },
    ],

    // Common fields
    name: { type: String, required: true },
    image: { type: String, default: '' },
    price: { type: Number, required: true },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1'],
      max: [20, 'Cannot add more than 20 of one item'],
    },
  },
  { _id: true },
);

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    items: [productCartItemSchema],
    coupon: {
      code: { type: String, trim: true, uppercase: true },
      discountPercent: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// ✅ SINGLE source of truth for index
cartSchema.index({ userId: 1 }, { unique: true });

// ─── Virtuals ─────────────────────────────────────────────────────────────────
cartSchema.virtual('subtotal').get(function () {
  return this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
});

cartSchema.virtual('totalItems').get(function () {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

cartSchema.set('toJSON', { virtuals: true });
cartSchema.set('toObject', { virtuals: true });

const Cart = mongoose.model('Cart', cartSchema);

module.exports = Cart;
