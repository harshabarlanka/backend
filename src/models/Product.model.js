const mongoose = require("mongoose");
const slugify = require("slugify");

const variantSchema = new mongoose.Schema(
  {
    size: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: [0, "Price must be positive"] },
    mrp: { type: Number, required: true, min: [0, "MRP must be positive"] },
    stock: { type: Number, required: true, min: [0, "Stock cannot be negative"], default: 0 },
    sku: { type: String, trim: true },
  },
  { _id: true },
);

const reviewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    name: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: [500, "Review cannot exceed 500 characters"] },
  },
  { timestamps: true },
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      maxlength: [120, "Name cannot exceed 120 characters"],
    },
    slug: { type: String, unique: true, lowercase: true },
    description: {
      type: String,
      required: [true, "Description is required"],
      maxlength: [2000, "Description cannot exceed 2000 characters"],
    },
    ingredients: { type: String, trim: true },
    category: {
      type: String,
      required: [true, "Category is required"],
      enum: ["veg-pickles", "non-veg-pickles", "sweets", "snacks", "podis", "others"],
      default: "others",
    },
    images: {
      type: [String],
      validate: [(arr) => arr.length <= 6, "Cannot upload more than 6 images"],
    },
    variants: {
      type: [variantSchema],
      validate: [(arr) => arr.length > 0, "At least one variant is required"],
    },
    tags: [{ type: String, lowercase: true, trim: true }],

    // Shipping dimensions (for Shiprocket)
    length: { type: Number, default: 15, min: [0.1, "Length must be positive"] },
    breadth: { type: Number, default: 10, min: [0.1, "Breadth must be positive"] },
    height: { type: Number, default: 10, min: [0.1, "Height must be positive"] },
    weight: { type: Number, default: 500, min: [1, "Weight must be at least 1g"] },

    reviews: [reviewSchema],
    ratings: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    isActive: { type: Boolean, default: true },
    hsn: { type: String, default: "2001" },
    taxRate: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ name: "text", description: "text", tags: "text" });
productSchema.index({ "ratings.average": -1 });

// ─── Virtual: min price ───────────────────────────────────────────────────────
productSchema.virtual("minPrice").get(function () {
  if (!this.variants || this.variants.length === 0) return 0;
  return Math.min(...this.variants.map((v) => v.price));
});

// ─── Pre-save: Generate slug ──────────────────────────────────────────────────
productSchema.pre("save", function (next) {
  if (this.isModified("name") || this.isNew) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

// ─── Pre-save: Recalculate ratings ────────────────────────────────────────────
productSchema.pre("save", function (next) {
  if (this.isModified("reviews")) {
    const count = this.reviews.length;
    const average = count
      ? this.reviews.reduce((sum, r) => sum + r.rating, 0) / count
      : 0;
    this.ratings = { average: Math.round(average * 10) / 10, count };
  }
  next();
});

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
