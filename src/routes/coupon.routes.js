const express = require("express");
const router = express.Router();

const { validateCoupon } = require("../controllers/coupon.controller");
const { protect } = require("../middleware/auth.middleware");

// All coupon routes require authentication
router.use(protect);

// POST /api/coupons/validate — read-only check, does NOT increment usageCount
router.post("/validate", validateCoupon);

module.exports = router;
