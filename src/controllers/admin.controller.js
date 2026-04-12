const Order = require('../models/Order.model');
const Product = require('../models/Product.model');
const User = require('../models/User.model');
const Payment = require('../models/Payment.model');
const {
  createNimbusPostOrder,
  cancelNimbusPostOrder,
} = require('../services/nimbuspost.service');
const { sendShipmentEmail, sendReviewRequestEmail } = require('../services/email.service');
const { restoreStock } = require('./order.controller');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');
const logger = require('../utils/logger');

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

const getDashboard = catchAsync(async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const [
    totalOrders,
    monthOrders,
    lastMonthOrders,
    pendingOrders,
    totalUsers,
    totalRevenue,
    monthRevenue,
    lowStockProducts,
    recentOrders,
    ordersByStatus,
  ] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
    Order.countDocuments({
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
    }),
    Order.countDocuments({ status: { $in: ['pending', 'confirmed', 'packed'] } }),
    User.countDocuments({ role: 'user' }),
    Payment.aggregate([
      { $match: { status: { $in: ['captured', 'cod_collected'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      {
        $match: {
          status: { $in: ['captured', 'cod_collected'] },
          createdAt: { $gte: startOfMonth },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Product.find({ 'variants.stock': { $lte: 10 }, isActive: true })
      .select('name variants')
      .limit(5),
    Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('userId', 'name email')
      .select('orderNumber status total paymentMethod createdAt'),
    Order.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const orderGrowth =
    lastMonthOrders > 0
      ? (((monthOrders - lastMonthOrders) / lastMonthOrders) * 100).toFixed(1)
      : 100;

  return sendResponse(res, 200, 'Dashboard stats fetched.', {
    stats: {
      totalOrders,
      monthOrders,
      orderGrowth: Number(orderGrowth),
      pendingOrders,
      totalUsers,
      totalRevenue: (totalRevenue[0]?.total || 0) / 100, // Convert from paise
      monthRevenue: (monthRevenue[0]?.total || 0) / 100,
    },
    lowStockProducts,
    recentOrders,
    ordersByStatus: ordersByStatus.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
  });
});

// ─── Get All Orders (Admin) ───────────────────────────────────────────────────

const getAllOrders = catchAsync(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status,
    paymentMethod,
    search,
    sort = '-createdAt',
  } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (search) filter.orderNumber = { $regex: search, $options: 'i' };

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Number(limit));

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate('userId', 'name email phone')
      .populate('paymentId', 'status method amount razorpayPaymentId'),
    Order.countDocuments(filter),
  ]);

  return sendResponse(res, 200, 'Orders fetched.', { orders }, {
    total,
    page: pageNum,
    pages: Math.ceil(total / limitNum),
  });
});

// ─── Get Single Order (Admin) ─────────────────────────────────────────────────

const getOrderById = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('userId', 'name email phone')
    .populate('paymentId');

  if (!order) throw new ApiError(404, 'Order not found.');

  return sendResponse(res, 200, 'Order fetched.', { order });
});

// ─── Update Order Status (Admin) ──────────────────────────────────────────────

const updateOrderStatus = catchAsync(async (req, res) => {
  const { status, note } = req.body;

  const order = await Order.findById(req.params.id).populate('userId', 'name email');
  if (!order) throw new ApiError(404, 'Order not found.');

  // Define valid transitions
  const validTransitions = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['packed', 'cancelled'],
    packed: ['shipped', 'cancelled'],
    shipped: ['delivered'],
    delivered: ['refunded'],
    cancelled: [],
    refunded: [],
  };

  if (!validTransitions[order.status]?.includes(status)) {
    throw new ApiError(
      400,
      `Cannot transition order from "${order.status}" to "${status}".`
    );
  }

  order.status = status;
  order.statusHistory.push({
    status,
    note: note || `Status updated to ${status} by admin.`,
    updatedBy: req.user._id,
  });

  // Handle side-effects for specific transitions
  if (status === 'cancelled') {
    await restoreStock(order.items);

    if (order.awbCode) {
      try {
        await cancelNimbusPostOrder(order.awbCode);
      } catch (err) {
        logger.warn(`NimbusPost cancel failed for order ${order.orderNumber}: ${err.message}`);
      }
    }
  }

  if (status === 'delivered') {
    // Trigger post-delivery review email
    sendReviewRequestEmail({
      email: order.userId.email,
      name: order.userId.name,
      order,
    });
  }

  await order.save();

  return sendResponse(res, 200, `Order status updated to "${status}".`, { order });
});

// ─── Ship Order via NimbusPost (Admin) ───────────────────────────────────────

const shipOrder = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('userId', 'name email');
  if (!order) throw new ApiError(404, 'Order not found.');

  if (order.status !== 'packed') {
    throw new ApiError(400, `Order must be in "packed" status to ship. Current: "${order.status}".`);
  }

  if (order.awbCode) {
    throw new ApiError(400, 'This order has already been submitted to NimbusPost.');
  }

  // 1. Create NimbusPost B2B shipment (handles order creation, AWB & pickup in one call)
  const { nimbuspostOrderId, nimbuspostShipmentId, awbCode, courierName, labelUrl } =
    await createNimbusPostOrder(order, order.userId);

  // 2. Update order with NimbusPost details
  order.shiprocketOrderId = nimbuspostOrderId;   // reuse existing field for compatibility
  order.shiprocketShipmentId = nimbuspostShipmentId;
  order.awbCode = awbCode;
  order.courierName = courierName;
  order.status = 'shipped';
  order.statusHistory.push({
    status: 'shipped',
    note: `Shipped via ${courierName}. AWB: ${awbCode}.`,
    updatedBy: req.user._id,
  });
  await order.save();

  // 3. Send shipment email
  sendShipmentEmail({ email: order.userId.email, name: order.userId.name, order });

  return sendResponse(res, 200, 'Order shipped successfully.', {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      awbCode,
      courierName,
      nimbuspostOrderId,
      labelUrl,
    },
  });
});

// ─── Get All Users (Admin) ────────────────────────────────────────────────────

const getAllUsers = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, search, role } = req.query;

  const filter = {};
  if (role) filter.role = role;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Number(limit));

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select('-passwordHash -refreshToken -passwordResetToken'),
    User.countDocuments(filter),
  ]);

  return sendResponse(res, 200, 'Users fetched.', { users }, {
    total,
    page: pageNum,
    pages: Math.ceil(total / limitNum),
  });
});

// ─── Toggle User Active Status (Admin) ───────────────────────────────────────

const toggleUserStatus = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found.');

  if (user.role === 'admin') {
    throw new ApiError(403, 'Cannot deactivate an admin account.');
  }

  user.isActive = !user.isActive;
  await user.save({ validateBeforeSave: false });

  return sendResponse(
    res,
    200,
    `User account ${user.isActive ? 'activated' : 'deactivated'} successfully.`,
    { user: user.toPublicJSON() }
  );
});

// ─── Analytics ────────────────────────────────────────────────────────────────

const getAnalytics = catchAsync(async (req, res) => {
  const { period = '30' } = req.query;
  const days = Math.min(365, Math.max(7, Number(period)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [revenueByDay, topProducts, ordersByPaymentMethod] = await Promise.all([
    // Daily revenue for the period
    Order.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          status: { $in: ['confirmed', 'packed', 'shipped', 'delivered'] },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: '$total' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Top-selling products
    Order.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $first: '$items.name' },
          totalSold: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: 10 },
    ]),

    // Orders split by payment method
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 } } },
    ]),
  ]);

  return sendResponse(res, 200, 'Analytics fetched.', {
    period: days,
    revenueByDay,
    topProducts,
    ordersByPaymentMethod: ordersByPaymentMethod.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
  });
});

module.exports = {
  getDashboard,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  shipOrder,
  getAllUsers,
  toggleUserStatus,
  getAnalytics,
};
