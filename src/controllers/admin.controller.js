const Order = require("../models/Order.model");
const Product = require("../models/Product.model");
const User = require("../models/User.model");
const Payment = require("../models/Payment.model");
const Coupon = require("../models/Coupon.model");
const {
  createShiprocketOrder,
  cancelShiprocketOrder,
  generateInvoice,
  generateLabel,
} = require("../services/shiprocket.service");
const {
  sendShipmentEmail,
  sendReviewRequestEmail,
} = require("../services/email.service");
const { restoreStock } = require("../utils/stock");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");
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
    shipmentPendingOrders,
  ] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
    Order.countDocuments({
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
    }),
    Order.countDocuments({
      status: { $in: ["confirmed", "preparing", "ready_for_pickup"] },
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
      .select("orderNumber status total paymentMethod createdAt awbCode courierName"),
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    // Orders ready for pickup but not yet shipped (Shiprocket not yet created)
    Order.countDocuments({
      status: "ready_for_pickup",
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
      shipmentPendingOrders,
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
    noAwb,
  } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (search) filter.orderNumber = { $regex: search, $options: "i" };
  if (noAwb === "true") {
    filter.awbCode = null;
    filter.status = { $in: ["ready_for_pickup", "shipped"] };
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
    { total, page: pageNum, pages: Math.ceil(total / limitNum) }
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

// ─── Generate Invoice PDF (Admin) ─────────────────────────────────────────────

const getOrderInvoice = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id);

  if (!order) throw new ApiError(404, "Order not found.");

  if (!order.shiprocketOrderId) {
    throw new ApiError(400, "Shiprocket order not yet created for this order.");
  }

  if (order.invoiceUrl) {
    logger.info(`[getOrderInvoice] Returning cached invoice for ${order.orderNumber}`);
    return sendResponse(res, 200, "Invoice URL fetched.", { invoiceUrl: order.invoiceUrl });
  }

  const invoiceUrl = await generateInvoice(order.shiprocketOrderId);

  if (!invoiceUrl) {
    throw new ApiError(502, "Shiprocket returned no invoice URL.");
  }

  order.invoiceUrl = invoiceUrl;
  await order.save();

  logger.info(`[getOrderInvoice] Invoice generated for ${order.orderNumber}: ${invoiceUrl}`);

  return sendResponse(res, 200, "Invoice generated.", { invoiceUrl });
});

// ─── Generate Label PDF (Admin) ───────────────────────────────────────────────

const getOrderLabel = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id);

  if (!order) throw new ApiError(404, "Order not found.");

  if (!order.shiprocketShipmentId) {
    throw new ApiError(400, "Shipment not yet created for this order.");
  }

  if (order.labelUrl) {
    logger.info(`[getOrderLabel] Returning cached label for ${order.orderNumber}`);
    return sendResponse(res, 200, "Label URL fetched.", { labelUrl: order.labelUrl });
  }

  const labelUrl = await generateLabel(order.shiprocketShipmentId);

  if (!labelUrl) {
    throw new ApiError(502, "Shiprocket returned no label URL.");
  }

  order.labelUrl = labelUrl;
  await order.save();

  logger.info(`[getOrderLabel] Label generated for ${order.orderNumber}: ${labelUrl}`);

  return sendResponse(res, 200, "Label generated.", { labelUrl });
});

// ─── Update Order Status (Admin) ──────────────────────────────────────────────
//
// MADE-TO-ORDER FLOW:
//   confirmed → preparing → ready_for_pickup → [Shiprocket triggered here]
//   → shipped → out_for_delivery → delivered
//
// Shiprocket is NOT triggered here; it is triggered in markReadyForPickup.

const updateOrderStatus = catchAsync(async (req, res) => {
  const { status, note } = req.body;

  const order = await Order.findById(req.params.id).populate("userId", "name email");
  if (!order) throw new ApiError(404, "Order not found.");

  const validTransitions = {
    confirmed: ["preparing", "cancelled"],
    preparing: ["ready_for_pickup", "cancelled"],
    ready_for_pickup: ["shipped", "cancelled"],
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
      `Cannot transition order from "${order.status}" to "${status}".`
    );
  }

  // Block direct transition to ready_for_pickup via this endpoint —
  // use the dedicated markReadyForPickup endpoint instead (it triggers Shiprocket).
  if (status === "ready_for_pickup") {
    throw new ApiError(
      400,
      'Use POST /admin/orders/:id/ready-for-pickup to mark an order as ready. This triggers Shiprocket automatically.'
    );
  }

  order.status = status;
  order.statusHistory.push({
    status,
    note: note || `Status updated to ${status} by admin.`,
    updatedBy: req.user._id,
  });

  if (status === "cancelled") {
    await restoreStock(order.items);

    // Reverse coupon usage
    if (order.couponId && order.discountAmount > 0) {
      await Coupon.findByIdAndUpdate(order.couponId, {
        $inc: { usageCount: -1 },
      });
    }

    if (order.shiprocketOrderId) {
      try {
        await cancelShiprocketOrder(order.shiprocketOrderId);
        logger.info(`Shiprocket shipment cancelled for order ${order.orderNumber}`);
      } catch (err) {
        logger.warn(`Shiprocket cancel failed for ${order.orderNumber}: ${err.message}`);
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

  return sendResponse(res, 200, `Order status updated to "${status}".`, { order });
});

// ─── Mark Ready for Pickup (Admin) ────────────────────────────────────────────
//
// MADE-TO-ORDER SHIPMENT TRIGGER:
//   This is the ONLY place Shiprocket order creation / AWB assignment / pickup
//   generation happens. It fires when admin marks the order as ready after
//   physical preparation (1-2 days for pickles).
//
// Flow:
//   1. Validate order is in "preparing" status
//   2. Create Shiprocket order → assign AWB → generate pickup
//   3. Set order.status = "ready_for_pickup"
//   4. Send shipment notification email to customer

const markReadyForPickup = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate("userId", "name email");
  if (!order) throw new ApiError(404, "Order not found.");

  if (order.status !== "preparing") {
    throw new ApiError(
      400,
      `Order must be in "preparing" status to mark as ready for pickup. Current: "${order.status}".`
    );
  }

  if (order.awbCode) {
    throw new ApiError(400, `Order already has AWB: ${order.awbCode}. Shipment already created.`);
  }

  // Trigger Shiprocket: create order → assign AWB → generate pickup
  const { shiprocketOrderId, shiprocketShipmentId, awbCode, courierName } =
    await createShiprocketOrder(order, order.userId);

  order.shiprocketOrderId = shiprocketOrderId;
  order.shiprocketShipmentId = shiprocketShipmentId;
  order.awbCode = awbCode;
  order.courierName = courierName;
  order.trackingStatus = "Booked";
  order.trackingUpdatedAt = new Date();
  order.status = "ready_for_pickup";
  order.statusHistory.push({
    status: "ready_for_pickup",
    note: `Order ready for pickup. Shiprocket AWB: ${awbCode} via ${courierName}.`,
    updatedBy: req.user._id,
  });

  await order.save();

  // Notify customer that their order has been dispatched for pickup
  sendShipmentEmail({
    email: order.userId.email,
    name: order.userId.name,
    order,
  }).catch((err) =>
    logger.warn(`[markReadyForPickup] Shipment email failed for ${order.orderNumber}: ${err.message}`)
  );

  logger.info(`[markReadyForPickup] Order ${order.orderNumber} ready for pickup. AWB: ${awbCode} via ${courierName}`);

  return sendResponse(res, 200, "Order marked as ready for pickup. Shiprocket AWB assigned.", {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      awbCode,
      courierName,
      shiprocketOrderId,
      shiprocketShipmentId,
    },
  });
});

// ─── Ship Order via Shiprocket (Admin manual override) ────────────────────────
//
// Manual override for edge cases where markReadyForPickup wasn't used.
// Only allowed on confirmed or preparing orders that have no AWB yet.

const shipOrder = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate("userId", "name email");
  if (!order) throw new ApiError(404, "Order not found.");

  if (!["confirmed", "preparing"].includes(order.status)) {
    throw new ApiError(
      400,
      `Order must be "confirmed" or "preparing" to manually ship. Current: "${order.status}". Use mark-ready-for-pickup for normal flow.`
    );
  }

  if (order.awbCode) {
    throw new ApiError(400, "This order has already been submitted to Shiprocket.");
  }

  const { shiprocketOrderId, shiprocketShipmentId, awbCode, courierName } =
    await createShiprocketOrder(order, order.userId);

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
  }).catch((err) =>
    logger.warn(`[shipOrder] Email failed for ${order.orderNumber}: ${err.message}`)
  );

  return sendResponse(res, 200, "Order shipped successfully.", {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      awbCode,
      courierName,
      shiprocketOrderId,
    },
  });
});

// ─── Retry Shipment (Admin) ───────────────────────────────────────────────────

const retryShipment = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate("userId", "name email");
  if (!order) throw new ApiError(404, "Order not found.");

  if (order.awbCode) {
    throw new ApiError(400, `Order already has AWB: ${order.awbCode}. No retry needed.`);
  }

  const allowedStatuses = ["confirmed", "preparing", "ready_for_pickup"];
  if (!allowedStatuses.includes(order.status)) {
    throw new ApiError(
      400,
      `Shipment retry only for confirmed/preparing/ready_for_pickup orders. Current: "${order.status}".`
    );
  }

  const { shiprocketOrderId, shiprocketShipmentId, awbCode, courierName } =
    await createShiprocketOrder(order, order.userId);

  order.shiprocketOrderId = shiprocketOrderId;
  order.shiprocketShipmentId = shiprocketShipmentId;
  order.awbCode = awbCode;
  order.courierName = courierName;
  order.trackingStatus = "Booked";
  order.trackingUpdatedAt = new Date();
  order.statusHistory.push({
    status: order.status,
    note: `Shipment retried. AWB: ${awbCode} via ${courierName}.`,
    updatedBy: req.user._id,
  });

  await order.save();

  if (!order.awbCode) {
    throw new ApiError(502, "Shipment creation failed again. Check Shiprocket account.");
  }

  logger.info(`Admin retried shipment for ${order.orderNumber}. AWB: ${order.awbCode}`);

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

// ─── Refund Order (Admin) ─────────────────────────────────────────────────────

const refundOrder = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id).populate("paymentId");

  if (!order) throw new ApiError(404, "Order not found.");
  if (!order.paymentId?.razorpayPaymentId) {
    throw new ApiError(400, "No captured payment to refund.");
  }

  const refund = await initiateRefund(
    order.paymentId.razorpayPaymentId,
    order.total * 100
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

  return sendResponse(res, 200, "Refund initiated.", { refundId: refund.id });
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
    { total, page: pageNum, pages: Math.ceil(total / limitNum) }
  );
});

// ─── Toggle User Status (Admin) ───────────────────────────────────────────────

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
    { user: user.toPublicJSON() }
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
              "confirmed", "preparing", "ready_for_pickup",
              "shipped", "out_for_delivery", "delivered",
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
  markReadyForPickup,
  getOrderInvoice,
  getOrderLabel,
  shipOrder,
  retryShipment,
  refundOrder,
  getAllUsers,
  toggleUserStatus,
  getAnalytics,
};
