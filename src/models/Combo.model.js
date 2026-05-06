const mongoose = require('mongoose');

const comboProductSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity: { type: Number, default: 1, min: 1 },
  },
  { _id: false },
);

const comboSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    products: {
      type: [comboProductSchema],
      validate: [(arr) => arr.length > 0, 'Combo must contain at least one product'],
    },
    price: { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, default: 0 },
    category: { type: String, default: '' },
    images: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

comboSchema.index({ isActive: 1, createdAt: -1 });

comboSchema.virtual('discountPercent').get(function () {
  if (!this.originalPrice || this.originalPrice <= this.price) return 0;
  return Math.round(((this.originalPrice - this.price) / this.originalPrice) * 100);
});

comboSchema.virtual('savings').get(function () {
  if (!this.originalPrice || this.originalPrice <= this.price) return 0;
  return this.originalPrice - this.price;
});

comboSchema.set('toJSON', { virtuals: true });
comboSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Combo', comboSchema);
