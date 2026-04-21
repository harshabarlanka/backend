const Order = require("../models/Order.model");
const Product = require("../models/Product.model");
const User = require("../models/User.model");
const Payment = require("../models/Payment.model");
const {
  createShiprocketOrder,
  cancelShiprocketOrder,
  autoCreateShipment,
} = require("../services/shiprocket.service");
const {
  sendShipmentEmail,
  sendReviewRequestEmail,
} = require("../services/email.service");
const { restoreStock } = require("./order.controller");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");
const { generateLabel } = require("../services/shiprocket.service");
const { initiateRefund } = require("../services/razorpay.service");

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
    // ADDED: Count orders where auto-shipment failed (confirmed but no AWB)
    shipmentPendingOrders,
  ] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
    Order.countDocuments({
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
    }),
    Order.countDocuments({
      status: { $in: ["pending", "confirmed", "packed"] },
    }),
    User.countDocuments({ role: "user" }),
    Payment.aggregate([
      { $match: { status: { $in: ["captured", "cod_collected"] } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Payment.aggregate([
      {
        $match: {
          status: { $in: ["captured", "cod_collected"] },
          createdAt: { $gte: startOfMonth },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Product.find({ "variants.stock": { $lte: 10 }, isActive: true })
      .select("name variants")
      .limit(5),
    Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("userId", "name email")
      .select(
        "orderNumber status total paymentMethod createdAt awbCode courierName",
      ),
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    // ADDED: Orders confirmed but without AWB — these need admin attention
    Order.countDocuments({
      status: { $in: ["confirmed", "packed", "shipped"] },
      awbCode: null,
    }),
  ]);

  const orderGrowth =
    lastMonthOrders > 0
      ? (((monthOrders - lastMonthOrders) / lastMonthOrders) * 100).toFixed(1)
      : 100;

  return sendResponse(res, 200, "Dashboard stats fetched.", {
    stats: {
      totalOrders,
      monthOrders,
      orderGrowth: Number(orderGrowth),
      pendingOrders,
      totalUsers,
      totalRevenue: (totalRevenue[0]?.total || 0) / 100,
      monthRevenue: (monthRevenue[0]?.total || 0) / 100,
      shipmentPendingOrders, // ADDED: surface in dashboard so admin can act
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
    sort = "-createdAt",
    // ADDED: filter to find orders missing a shipment
    noAwb,
  } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (search) filter.orderNumber = { $regex: search, $options: "i" };
  // ADDED: ?noAwb=true returns confirmed/shipped orders without an AWB
  if (noAwb === "true") {
    filter.awbCode = null;
    filter.status = { $in: ["confirmed", "packed", "shipped"] };
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Number(limit));

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("userId", "name email phone")
      .populate("paymentId", "status method amount razorpayPaymentId"),
    Order.countDocuments(filter),
  ]);

  return sendResponse(
    res,
    200,
    "Orders fetched.",
    { orders },
    {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  );
});

// ─── Get Single Order (Admin) ─────────────────────────────────────────────────

const getOrderById = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate("userId", "name email phone")
    .populate("paymentId");

  if (!order) throw new ApiError(404, "Order not found.");

  return sendResponse(res, 200, "Order fetched.", { order });
});
// ─── Order Actions ─────────────────────────────────────────

const generateShipmentLabel = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id);

  if (!order || !order.shiprocketShipmentId) {
    throw new ApiError(404, "Shipment not found");
  }

  const labelUrl = await generateLabel(order.shiprocketShipmentId);

  return sendResponse(res, 200, "Label generated", { labelUrl });
});
// ─── Update Order Status (Admin) ──────────────────────────────────────────────

const updateOrderStatus = catchAsync(async (req, res) => {
  const { status, note } = req.body;

  const order = await Order.findById(req.params.id).populate(
    "userId",
    "name email",
  );
  if (!order) throw new ApiError(404, "Order not found.");

  // Valid transitions — CHANGED: added rto as a valid terminal state
  const validTransitions = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["packed", "cancelled"],
    packed: ["shipped", "cancelled"],
    shipped: ["out_for_delivery", "delivered", "rto"],
    out_for_delivery: ["delivered", "rto"],
    delivered: ["refunded"],
    rto: [],
    cancelled: [],
    refunded: [],
  };

  if (!validTransitions[order.status]?.includes(status)) {
    throw new ApiError(
      400,
      `Cannot transition order from "${order.status}" to "${status}".`,
    );
  }

  order.status = status;
  order.statusHistory.push({
    status,
    note: note || `Status updated to ${status} by admin.`,
    updatedBy: req.user._id,
  });

  // Handle side-effects for specific transitions
  if (status === "cancelled") {
    await restoreStock(order.items);

    if (order.awbCode) {
      try {
        await cancelShiprocketOrder(order.awbCode);
        logger.info(
          `Shiprocket shipment cancelled for order ${order.orderNumber}`,
        );
      } catch (err) {
        logger.warn(
          `Shiprocket cancel failed for order ${order.orderNumber}: ${err.message}`,
        );
      }
    }
  }

  if (status === "delivered") {
    sendReviewRequestEmail({
      email: order.userId.email,
      name: order.userId.name,
      order,
    });
  }

  await order.save();

  return sendResponse(res, 200, `Order status updated to "${status}".`, {
    order,
  });
});

// ─── Ship Order via Shiprocket (Admin) ───────────────────────────────────────
//
// Manual ship endpoint — still available for admin to override or
// retry when auto-creation failed.

const refundOrder = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate("paymentId");

  if (!order) throw new ApiError(404, "Order not found.");
  if (!order.paymentId?.razorpayPaymentId)
    throw new ApiError(400, "No captured payment to refund.");

  const refund = await initiateRefund(
    order.paymentId.razorpayPaymentId,
    order.total * 100,
  );

  await Payment.findByIdAndUpdate(order.paymentId._id, {
    $set: {
      status: "refunded",
      refundId: refund.id,
      refundedAt: new Date(),
    },
  });

  order.status = "refunded";
  order.statusHistory.push({
    status: "refunded",
    note: `Refund initiated: ${refund.id}`,
    updatedBy: req.user._id,
  });

  await order.save();

  return sendResponse(res, 200, "Refund initiated.", {
    refundId: refund.id,
  });
});
const shipOrder = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate(
    "userId",
    "name email",
  );
  if (!order) throw new ApiError(404, "Order not found.");

  if (!["confirmed", "packed"].includes(order.status)) {
    throw new ApiError(
      400,
      `Order must be in "confirmed" or "packed" status to ship. Current: "${order.status}".`,
    );
  }

  if (order.awbCode) {
    throw new ApiError(
      400,
      "This order has already been submitted to Shiprocket.",
    );
  }

  const {
    shiprocketOrderId,
    shiprocketShipmentId,
    awbCode,
    courierName,
    labelUrl,
  } = await createShiprocketOrder(order, order.userId);

  order.shiprocketOrderId = shiprocketOrderId;
  order.shiprocketShipmentId = shiprocketShipmentId;
  order.awbCode = awbCode;
  order.courierName = courierName;
  order.trackingStatus = "Booked";
  order.trackingUpdatedAt = new Date();
  order.status = "shipped";
  order.statusHistory.push({
    status: "shipped",
    note: `Manually shipped via ${courierName}. AWB: ${awbCode}.`,
    updatedBy: req.user._id,
  });
  await order.save();

  sendShipmentEmail({
    email: order.userId.email,
    name: order.userId.name,
    order,
  });

  return sendResponse(res, 200, "Order shipped successfully.", {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      awbCode,
      courierName,
      shiprocketOrderId,
      labelUrl,
    },
  });
});

// ─── ADDED: Retry Auto-Shipment (Admin) ──────────────────────────────────────
//
// POST /api/admin/orders/:id/retry-shipment
//
// For orders where the auto-shipment creation failed on placement
// (e.g. Shiprocket was down, balance was insufficient), admin can trigger a retry
// without needing to change order status.

const retryShipment = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate(
    "userId",
    "name email",
  );
  if (!order) throw new ApiError(404, "Order not found.");

  if (order.awbCode) {
    throw new ApiError(
      400,
      `Order already has AWB: ${order.awbCode}. No retry needed.`,
    );
  }

  const allowedStatuses = ["confirmed", "packed"];
  if (!allowedStatuses.includes(order.status)) {
    throw new ApiError(
      400,
      `Shipment retry is only available for confirmed/packed orders. Current: "${order.status}".`,
    );
  }

  // autoCreateShipment is non-throwing — check awbCode after call to detect failure
  await autoCreateShipment(order, order.userId);
  await order.save();

  if (!order.awbCode) {
    throw new ApiError(
      502,
      "Shipment creation failed again. Check Shiprocket account and courier settings.",
    );
  }

  logger.info(
    `Admin retried shipment for order ${order.orderNumber}. AWB: ${order.awbCode}`,
  );

  return sendResponse(res, 200, "Shipment created successfully on retry.", {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      awbCode: order.awbCode,
      courierName: order.courierName,
      trackingStatus: order.trackingStatus,
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
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Number(limit));

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select("-passwordHash -refreshToken -passwordResetToken"),
    User.countDocuments(filter),
  ]);

  return sendResponse(
    res,
    200,
    "Users fetched.",
    { users },
    {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  );
});

// ─── Toggle User Active Status (Admin) ───────────────────────────────────────

const toggleUserStatus = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, "User not found.");

  if (user.role === "admin") {
    throw new ApiError(403, "Cannot deactivate an admin account.");
  }

  user.isActive = !user.isActive;
  await user.save({ validateBeforeSave: false });

  return sendResponse(
    res,
    200,
    `User account ${user.isActive ? "activated" : "deactivated"} successfully.`,
    { user: user.toPublicJSON() },
  );
});

// ─── Analytics ────────────────────────────────────────────────────────────────

const getAnalytics = catchAsync(async (req, res) => {
  const { period = "30" } = req.query;
  const days = Math.min(365, Math.max(7, Number(period)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [revenueByDay, topProducts, ordersByPaymentMethod] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          status: {
            $in: [
              "confirmed",
              "packed",
              "shipped",
              "out_for_delivery",
              "delivered",
            ],
          },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    Order.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $ne: "cancelled" } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          name: { $first: "$items.name" },
          totalSold: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: 10 },
    ]),

    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$paymentMethod", count: { $sum: 1 } } },
    ]),
  ]);

  return sendResponse(res, 200, "Analytics fetched.", {
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
  generateShipmentLabel,
  shipOrder,
  retryShipment, // ADDED
  refundOrder,
  getAllUsers,
  toggleUserStatus,
  getAnalytics,
};
