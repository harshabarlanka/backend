const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [20, "Code cannot exceed 20 characters"],
    },
    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      required: [true, "Discount type is required"],
    },
    value: {
      type: Number,
      required: [true, "Discount value is required"],
      min: [0, "Value must be positive"],
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: [0, "Min order amount must be non-negative"],
    },
    // Only for percentage: caps the rupee discount
    maxDiscount: {
      type: Number,
      default: null,
    },
    expiryDate: {
      type: Date,
      required: [true, "Expiry date is required"],
    },
    usageLimit: {
      type: Number,
      default: null, // null = unlimited
    },
    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

couponSchema.index({ code: 1 });
couponSchema.index({ active: 1, expiryDate: 1 });

// Virtual: is this coupon currently usable?
couponSchema.virtual("isValid").get(function () {
  const now = new Date();
  if (!this.active) return false;
  if (this.expiryDate < now) return false;
  if (this.usageLimit !== null && this.usageCount >= this.usageLimit)
    return false;
  return true;
});

/**
 * Calculate the discount amount for a given order subtotal.
 * Returns 0 if the coupon is not applicable.
 */
couponSchema.methods.calculateDiscount = function (orderSubtotal) {
  if (orderSubtotal < this.minOrderAmount) return 0;
  if (this.discountType === "flat") {
    return Math.min(this.value, orderSubtotal);
  }
  // percentage
  const raw = (orderSubtotal * this.value) / 100;
  if (this.maxDiscount !== null) {
    return Math.min(raw, this.maxDiscount);
  }
  return raw;
};

module.exports = mongoose.model("Coupon", couponSchema);
