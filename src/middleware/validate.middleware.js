const Joi = require("joi");
const ApiError = require("../utils/ApiError");

/**
 * Returns an Express middleware that validates req.body against a Joi schema.
 * On failure, collects all messages and throws a 422 ApiError.
 *
 * Usage:
 *   router.post('/register', validate(schemas.register), authController.register);
 */
const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, {
    abortEarly: false, // collect ALL errors, not just the first
    stripUnknown: true, // silently drop unknown keys
    convert: true, // coerce types where possible (e.g. "5" → 5)
  });

  if (error) {
    const messages = error.details.map((d) => d.message.replace(/['"]/g, ""));
    return next(new ApiError(422, "Validation failed", messages));
  }

  next();
};

// ─── Reusable Schemas ────────────────────────────────────────────────────────

const schemas = {
  // Auth
  register: Joi.object({
    name: Joi.string().trim().min(2).max(60).required(),
    email: Joi.string().email().lowercase().required(),
    password: Joi.string().min(8).max(72).required(),
    phone: Joi.string()
      .pattern(/^[6-9]\d{9}$/)
      .optional()
      .messages({
        "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
      }),
  }),

  login: Joi.object({
    email: Joi.string().email().lowercase().required(),
    password: Joi.string().required(),
  }),

  forgotPassword: Joi.object({
    email: Joi.string().email().required(),
  }),

  resetPassword: Joi.object({
    token: Joi.string().required(),
    password: Joi.string().min(8).max(72).required(),
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).max(72).required(),
  }),

  // Product
  //
  // FIX 1: Added `length`, `breadth`, `height` fields — these are present in
  // the Product model and sent by the frontend's toPayload(), but were missing
  // from both schemas. Because Joi uses stripUnknown:true, they were silently
  // dropped, but their absence from the schema caused the req.body validation
  // to strip fields needed by the Product model's Shiprocket dimension logic.
  //
  // FIX 2: Variant sub-schema now allows an optional `_id` string field.
  // The frontend generates a local `crypto.randomUUID()` _id for each variant
  // (used as the React list key). Joi was receiving this field in the POST body,
  // and while stripUnknown:true strips it silently at the top level, Joi does
  // NOT apply stripUnknown recursively to nested objects by default — causing
  // "variant._id is not allowed" validation errors on some Joi versions, or
  // inconsistent 422s. Explicitly allowing it as optional is the safe fix.
  createProduct: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    description: Joi.string().min(10).max(2000).required(),
    ingredients: Joi.string().max(500).optional().allow(""),
    category: Joi.string()
      .valid(
        "veg-pickles",
        "non-veg-pickles",
        "sweets",
        "snacks",
        "podis",
        "others",
      )
      .required(),
    images: Joi.array().items(Joi.string().uri()).max(6).optional(),
    variants: Joi.array()
      .items(
        Joi.object({
          // Allow the frontend's local UUID key — stripped by Mongoose on save
          _id: Joi.string().optional(),
          size: Joi.string().required(),
          price: Joi.number().positive().required(),
          mrp: Joi.number().positive().required(),
          stock: Joi.number().integer().min(0).required(),
          sku: Joi.string().optional().allow(""),
        }),
      )
      .min(1)
      .required(),
    tags: Joi.array().items(Joi.string().lowercase().trim()).optional(),
    // Shipping dimensions — present in Product model, sent by frontend
    weight: Joi.number().positive().optional(),
    length: Joi.number().positive().optional(),
    breadth: Joi.number().positive().optional(),
    height: Joi.number().positive().optional(),
    isFeatured: Joi.boolean().optional(),
    taxRate: Joi.number().min(0).max(100).optional(),
    hsn: Joi.string().optional().allow(""),
  }),

  updateProduct: Joi.object({
    name: Joi.string().trim().min(2).max(120).optional(),
    description: Joi.string().min(10).max(2000).optional(),
    ingredients: Joi.string().max(500).optional().allow(""),
    category: Joi.string()
      .valid(
        "veg-pickles",
        "non-veg-pickles",
        "sweets",
        "snacks",
        "podis",
        "others",
      )
      .optional(),
    images: Joi.array().items(Joi.string().uri()).max(6).optional(),
    variants: Joi.array()
      .items(
        Joi.object({
          // Allow existing MongoDB _id strings from populated product data
          _id: Joi.string().optional(),
          size: Joi.string().required(),
          price: Joi.number().positive().required(),
          mrp: Joi.number().positive().required(),
          stock: Joi.number().integer().min(0).required(),
          sku: Joi.string().optional().allow(""),
        }),
      )
      .min(1)
      .optional(),
    tags: Joi.array().items(Joi.string().lowercase().trim()).optional(),
    // Shipping dimensions
    weight: Joi.number().positive().optional(),
    length: Joi.number().positive().optional(),
    breadth: Joi.number().positive().optional(),
    height: Joi.number().positive().optional(),
    isFeatured: Joi.boolean().optional(),
    isActive: Joi.boolean().optional(),
    taxRate: Joi.number().min(0).max(100).optional(),
    hsn: Joi.string().optional().allow(""),
  }),

  // Cart
  addToCart: Joi.object({
    productId: Joi.string().hex().length(24).required(),
    variantId: Joi.string().hex().length(24).required(),
    quantity: Joi.number().integer().min(1).max(20).required(),
  }),

  updateCartItem: Joi.object({
    quantity: Joi.number().integer().min(1).max(20).required(),
  }),

  // Order
  placeOrder: Joi.object({
    shippingAddress: Joi.object({
      fullName: Joi.string().required(),
      phone: Joi.string()
        .pattern(/^[6-9]\d{9}$/)
        .required(),
      addressLine1: Joi.string().required(),
      addressLine2: Joi.string().allow("").optional(),
      city: Joi.string().required(),
      state: Joi.string().required(),
      pincode: Joi.string()
        .pattern(/^\d{6}$/)
        .required()
        .messages({ "string.pattern.base": "Enter a valid 6-digit pincode" }),
      country: Joi.string().default("India"),
    }).required(),
    paymentMethod: Joi.string().valid("razorpay").required(),
    notes: Joi.string().max(300).allow("").optional(),
  }),

  // Review
  addReview: Joi.object({
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().max(500).allow("").optional(),
    orderId: Joi.string().hex().length(24).optional(),
    variantId: Joi.string().hex().length(24).optional(),
  }),

  // User profile
  updateProfile: Joi.object({
    name: Joi.string().trim().min(2).max(60).optional(),
    phone: Joi.string()
      .pattern(/^[6-9]\d{9}$/)
      .optional(),
  }),

  addAddress: Joi.object({
    label: Joi.string().max(20).optional(),
    fullName: Joi.string().required(),
    phone: Joi.string()
      .pattern(/^[6-9]\d{9}$/)
      .required(),
    addressLine1: Joi.string().required(),
    addressLine2: Joi.string().allow("").optional(),
    city: Joi.string().required(),
    state: Joi.string().required(),
    pincode: Joi.string()
      .pattern(/^\d{6}$/)
      .required(),
    country: Joi.string().default("India"),
    isDefault: Joi.boolean().optional(),
  }),

  // Admin
  updateOrderStatus: Joi.object({
    status: Joi.string()
      .valid(
        "preparing",
        "shipped",
        "out_for_delivery",
        "delivered",
        "cancelled",
        "rto",
        "refunded",
      )
      .required(),
    note: Joi.string().max(200).allow("").optional(),
  }),
};

module.exports = { validate, schemas };
