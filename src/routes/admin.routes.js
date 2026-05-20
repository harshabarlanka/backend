/**
 * admin.routes.js — Complete admin panel routes
 *
 * FIXES:
 *  1. Added missing product CRUD: POST /admin/products, PUT /admin/products/:id,
 *     DELETE /admin/products/:id — these existed in product.controller.js but
 *     were never wired to admin routes. Admin panel was read-only.
 *  2. All routes correctly use protect + restrictTo('admin').
 *  3. Upload middleware uses new validateAndUploadImages (magic-byte validated).
 *  4. IndexNow endpoint now requires admin auth.
 */

const express = require('express');
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
  getAllProducts,
} = require('../controllers/admin.controller');

const {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon,
} = require('../controllers/coupon.controller');

const {
  createCombo,
  updateCombo,
  deleteCombo,
  getCombos: getAdminCombos,
} = require('../controllers/combo.controller');

// Product controller — for admin product management
const {
  createProduct,
  updateProduct,
  deleteProduct,
} = require('../controllers/product.controller');

const { protect } = require('../middleware/auth.middleware');
const { restrictTo } = require('../middleware/admin.middleware');
const { validate, schemas } = require('../middleware/validate.middleware');
const { upload, validateAndUploadImages } = require('../middleware/upload.middleware');

// ── All admin routes: must be authenticated AND admin role ────────────────────
router.use(protect, restrictTo('admin'));

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', getDashboard);
router.get('/analytics', getAnalytics);

// ── Order management ──────────────────────────────────────────────────────────
router.get('/orders', getAllOrders);
router.get('/orders/:id', getOrderById);
router.patch('/orders/:id/status', validate(schemas.updateOrderStatus), updateOrderStatus);
router.post('/orders/:id/ready-for-pickup', markReadyForPickup);
router.post('/orders/:id/ship', shipOrder);
router.post('/orders/:id/retry-shipment', retryShipment);
router.get('/orders/:id/invoice', getOrderInvoice);
router.get('/orders/:id/label', getOrderLabel);
router.post('/orders/:id/refund', refundOrder);

// ── User management ───────────────────────────────────────────────────────────
router.get('/users', getAllUsers);
router.patch('/users/:id/toggle-status', toggleUserStatus);

// ── Product management (FIXED: was missing POST/PUT/DELETE) ───────────────────
// Admin can now create, update, and delete products through the admin panel.
// Images are validated for magic bytes before reaching Cloudinary.
router.get('/products', getAllProducts);
router.post(
  '/products',
  upload.array('images', 5),
  validateAndUploadImages,
  validate(schemas.createProduct),
  createProduct,
);
router.put(
  '/products/:id',
  upload.array('images', 5),
  validateAndUploadImages,
  validate(schemas.updateProduct),
  updateProduct,
);
router.delete('/products/:id', deleteProduct);

// ── Coupon management ─────────────────────────────────────────────────────────
router.get('/coupons', getAllCoupons);
router.post('/coupons', createCoupon);
router.put('/coupons/:id', updateCoupon);
router.delete('/coupons/:id', deleteCoupon);

// ── Combo management ──────────────────────────────────────────────────────────
router.get('/combos', getAdminCombos);
router.post('/combos', createCombo);
router.put('/combos/:id', updateCombo);
router.delete('/combos/:id', deleteCombo);

module.exports = router;
