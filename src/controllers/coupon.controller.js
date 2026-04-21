const Coupon = require("../models/Coupon.model");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

// ─── Admin: Create coupon ─────────────────────────────────────────────────────

const createCoupon = catchAsync(async (req, res) => {
  const {
    code,
    discountType,
    value,
    minOrderAmount,
    maxDiscount,
    expiryDate,
    usageLimit,
    active,
  } = req.body;

  if (!code || !discountType || value == null || !expiryDate) {
    throw new ApiError(400, "code, discountType, value, expiryDate are required.");
  }

  if (!["percentage", "flat"].includes(discountType)) {
    throw new ApiError(400, 'discountType must be "percentage" or "flat".');
  }

  if (discountType === "percentage" && (value <= 0 || value > 100)) {
    throw new ApiError(400, "Percentage discount must be between 1 and 100.");
  }

  const existing = await Coupon.findOne({ code: code.toUpperCase().trim() });
  if (existing) {
    throw new ApiError(409, `Coupon code "${code.toUpperCase()}" already exists.`);
  }

  const coupon = await Coupon.create({
    code: code.toUpperCase().trim(),
    discountType,
    value,
    minOrderAmount: minOrderAmount || 0,
    maxDiscount: maxDiscount || null,
    expiryDate: new Date(expiryDate),
    usageLimit: usageLimit || null,
    active: active !== false,
  });

  logger.info(`[Coupon] Created: ${coupon.code}`);

  return sendResponse(res, 201, "Coupon created successfully.", { coupon });
});

// ─── Admin: Get all coupons ───────────────────────────────────────────────────

const getAllCoupons = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, active } = req.query;
  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Number(limit));

  const filter = {};
  if (active === "true") filter.active = true;
  if (active === "false") filter.active = false;

  const [coupons, total] = await Promise.all([
    Coupon.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Coupon.countDocuments(filter),
  ]);

  return sendResponse(
    res,
    200,
    "Coupons fetched.",
    { coupons },
    { total, page: pageNum, pages: Math.ceil(total / limitNum) }
  );
});

// ─── Admin: Update coupon ─────────────────────────────────────────────────────

const updateCoupon = catchAsync(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw new ApiError(404, "Coupon not found.");

  const allowedFields = [
    "discountType",
    "value",
    "minOrderAmount",
    "maxDiscount",
    "expiryDate",
    "usageLimit",
    "active",
  ];

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      coupon[field] = req.body[field];
    }
  });

  // Code update: only allow if no one has used it yet
  if (req.body.code && req.body.code.toUpperCase() !== coupon.code) {
    if (coupon.usageCount > 0) {
      throw new ApiError(400, "Cannot change code of a coupon that has already been used.");
    }
    const exists = await Coupon.findOne({
      code: req.body.code.toUpperCase().trim(),
      _id: { $ne: coupon._id },
    });
    if (exists) throw new ApiError(409, "Code already in use.");
    coupon.code = req.body.code.toUpperCase().trim();
  }

  await coupon.save();

  logger.info(`[Coupon] Updated: ${coupon.code}`);
  return sendResponse(res, 200, "Coupon updated.", { coupon });
});

// ─── Admin: Delete coupon ─────────────────────────────────────────────────────

const deleteCoupon = catchAsync(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw new ApiError(404, "Coupon not found.");

  await coupon.deleteOne();

  logger.info(`[Coupon] Deleted: ${coupon.code}`);
  return sendResponse(res, 200, "Coupon deleted.");
});

// ─── User: Validate coupon (read-only, does NOT increment usageCount) ─────────

const validateCoupon = catchAsync(async (req, res) => {
  const { code, orderSubtotal } = req.body;

  if (!code) throw new ApiError(400, "Coupon code is required.");
  if (!orderSubtotal || orderSubtotal <= 0) {
    throw new ApiError(400, "orderSubtotal must be a positive number.");
  }

  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
  if (!coupon) throw new ApiError(404, "Coupon not found.");

  if (!coupon.active) throw new ApiError(400, "This coupon is inactive.");

  const now = new Date();
  if (coupon.expiryDate < now) {
    throw new ApiError(400, "This coupon has expired.");
  }

  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new ApiError(400, "Coupon usage limit reached.");
  }

  if (orderSubtotal < coupon.minOrderAmount) {
    throw new ApiError(
      400,
      `Minimum order amount ₹${coupon.minOrderAmount} required for this coupon.`
    );
  }

  const discountAmount = Math.round(coupon.calculateDiscount(orderSubtotal));

  return sendResponse(res, 200, "Coupon is valid.", {
    coupon: {
      code: coupon.code,
      discountType: coupon.discountType,
      value: coupon.value,
      minOrderAmount: coupon.minOrderAmount,
      maxDiscount: coupon.maxDiscount,
      expiryDate: coupon.expiryDate,
    },
    discountAmount,
  });
});

module.exports = {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
};
