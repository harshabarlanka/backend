const express = require('express');
const router = express.Router();

const {
  getDashboard,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  shipOrder,
  retryShipment, // ADDED
  getAllUsers,
  toggleUserStatus,
  getAnalytics,
} = require('../controllers/admin.controller');

const { protect } = require('../middleware/auth.middleware');
const { restrictTo } = require('../middleware/admin.middleware');
const { validate, schemas } = require('../middleware/validate.middleware');

// All admin routes: must be logged in AND must be admin
router.use(protect, restrictTo('admin'));

// Dashboard
router.get('/dashboard', getDashboard);
router.get('/analytics', getAnalytics);

// Order management
router.get('/orders', getAllOrders);
router.get('/orders/:id', getOrderById);
router.patch('/orders/:id/status', validate(schemas.updateOrderStatus), updateOrderStatus);
router.post('/orders/:id/ship', shipOrder);
router.post('/orders/:id/retry-shipment', retryShipment); // ADDED: retry failed auto-shipments

// User management
router.get('/users', getAllUsers);
router.patch('/users/:id/toggle-status', toggleUserStatus);

module.exports = router;
