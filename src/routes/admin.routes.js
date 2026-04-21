const express = require("express");
const router = express.Router();

const {
  getDashboard,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  markReadyForPickup,
  getOrderInvoice,
  getOrderLabel,
  shipOrder,
  retryShipment,
  refundOrder,
  getAllUsers,
  toggleUserStatus,
  getAnalytics,
} = require("../controllers/admin.controller");

const {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon,
} = require("../controllers/coupon.controller");

const { protect } = require("../middleware/auth.middleware");
const { restrictTo } = require("../middleware/admin.middleware");
const { validate, schemas } = require("../middleware/validate.middleware");

// All admin routes: must be logged in AND must be admin
router.use(protect, restrictTo("admin"));

// ── Dashboard ────────────────────────────────────────────────────────────────
router.get("/dashboard", getDashboard);
router.get("/analytics", getAnalytics);

// ── Order management ──────────────────────────────────────────────────────────
router.get("/orders", getAllOrders);
router.get("/orders/:id", getOrderById);
router.patch(
  "/orders/:id/status",
  validate(schemas.updateOrderStatus),
  updateOrderStatus
);

// Made-to-order shipment trigger:
// Admin calls this after physically preparing the order.
// This is the ONLY endpoint that creates Shiprocket order / AWB / pickup.
router.post("/orders/:id/ready-for-pickup", markReadyForPickup);

// Manual override (edge cases only)
router.post("/orders/:id/ship", shipOrder);
router.post("/orders/:id/retry-shipment", retryShipment);

// Invoice & Label download (with DB caching)
router.get("/orders/:id/invoice", getOrderInvoice);
router.get("/orders/:id/label", getOrderLabel);

router.post("/orders/:id/refund", refundOrder);

// ── User management ───────────────────────────────────────────────────────────
router.get("/users", getAllUsers);
router.patch("/users/:id/toggle-status", toggleUserStatus);

// ── Coupon Management (Admin) ──────────────────────────────────────────────────
router.get("/coupons", getAllCoupons);
router.post("/coupons", createCoupon);
router.put("/coupons/:id", updateCoupon);
router.delete("/coupons/:id", deleteCoupon);

module.exports = router;
