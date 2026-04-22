const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Coupon code is required"],
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
      default: null,
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
  },
);

// ✅ Proper indexes
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ active: 1, expiryDate: 1 });

// Virtual
couponSchema.virtual("isValid").get(function () {
  const now = new Date();
  if (!this.active) return false;
  if (this.expiryDate < now) return false;
  if (this.usageLimit !== null && this.usageCount >= this.usageLimit)
    return false;
  return true;
});

// Method
couponSchema.methods.calculateDiscount = function (orderSubtotal) {
  if (orderSubtotal < this.minOrderAmount) return 0;

  if (this.discountType === "flat") {
    return Math.min(this.value, orderSubtotal);
  }

  const raw = (orderSubtotal * this.value) / 100;

  if (this.maxDiscount !== null) {
    return Math.min(raw, this.maxDiscount);
  }

  return raw;
};

module.exports = mongoose.model("Coupon", couponSchema);
