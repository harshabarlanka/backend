const Order = require("../models/Order.model");
const Cart = require("../models/Cart.model");
const Payment = require("../models/Payment.model");
const Product = require("../models/Product.model");
const { createRazorpayOrder } = require("../services/razorpay.service");
const { trackShipment } = require("../services/shiprocket.service");
const { sendOrderConfirmationEmail } = require("../services/email.service");
const { generateOrderNumber } = require("../utils/orderNumber");
const { deductStock, restoreStock } = require("../utils/stock");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

// ─── Place Order ──────────────────────────────────────────────────────────────

const placeOrder = catchAsync(async (req, res) => {
  const { shippingAddress, notes } = req.body;

  // 1. Fetch user's cart
  const cart = await Cart.findOne({ userId: req.user._id });
  if (!cart || cart.items.length === 0) {
    throw new ApiError(400, "Your cart is empty.");
  }

  // 2. Idempotency check — prevent duplicate orders from double-click / network retry
  const idempotencyKey = `${req.user._id}-${cart.updatedAt.getTime()}`;
  const existingOrder = await Order.findOne({ idempotencyKey });

  if (existingOrder) {
    logger.info(
      `[placeOrder] Idempotency hit — returning existing order ${existingOrder.orderNumber}`,
    );

    if (existingOrder.status === "pending") {
      const existingPayment = await Payment.findById(existingOrder.paymentId);
      return sendResponse(
        res,
        200,
        "Order already created. Complete payment to confirm.",
        {
          order: {
            _id: existingOrder._id,
            orderNumber: existingOrder.orderNumber,
            total: existingOrder.total,
          },
          razorpay: {
            orderId: existingPayment?.razorpayOrderId,
            amount: existingOrder.total * 100,
            currency: "INR",
            keyId: process.env.RAZORPAY_KEY_ID,
          },
        },
      );
    }

    return sendResponse(res, 200, "Order already placed.", {
      order: existingOrder,
    });
  }

  // 3. Validate stock and build order items (snapshot prices at purchase time)
  const orderItems = [];
  let subtotal = 0;

  for (const cartItem of cart.items) {
    const product = await Product.findById(cartItem.productId);
    if (!product || !product.isActive) {
      throw new ApiError(
        400,
        `Product "${cartItem.name}" is no longer available.`,
      );
    }

    const variant = product.variants.id(cartItem.variantId);
    if (!variant) {
      throw new ApiError(400, `Variant for "${cartItem.name}" not found.`);
    }

    if (variant.stock < cartItem.quantity) {
      throw new ApiError(
        400,
        `Insufficient stock for "${cartItem.name} (${variant.size})". Only ${variant.stock} units left.`,
      );
    }

    orderItems.push({
      productId: product._id,
      variantId: variant._id,
      name: product.name,
      size: variant.size,
      image: product.images?.[0] || "",
      price: variant.price,
      quantity: cartItem.quantity,
    });

    subtotal += variant.price * cartItem.quantity;
  }

  // 4. Calculate totals
  const shippingCharge = subtotal >= 500 ? 0 : 60;
  const taxRate = 0.12;
  const tax = Math.round(subtotal * taxRate);
  const total = subtotal + shippingCharge + tax;

  // 5. Create Razorpay order FIRST — so we have rzpOrder.id for the payment record
  const orderNumber = generateOrderNumber();

  const rzpOrder = await createRazorpayOrder(total * 100, orderNumber, {
    userId: req.user._id.toString(),
    customer: req.user.name,
  });

  // 6. Create our Order document (status: pending — confirmed only after payment)
  const order = await Order.create({
    orderNumber,
    idempotencyKey,
    userId: req.user._id,
    items: orderItems,
    shippingAddress,
    paymentMethod: "razorpay",
    notes,
    subtotal,
    shippingCharge,
    tax,
    total,
    status: "pending",
    statusHistory: [
      {
        status: "pending",
        note: "Order created, awaiting payment.",
        updatedBy: req.user._id,
      },
    ],
  });

  // 7. Create Payment record
  const payment = await Payment.create({
    orderId: order._id,
    userId: req.user._id,
    method: "razorpay",
    amount: total * 100,
    currency: "INR",
    status: "created",
    razorpayOrderId: rzpOrder.id,
  });

  order.paymentId = payment._id;
  await order.save();

  logger.info(
    `[placeOrder] Order ${orderNumber} created. Razorpay: ${rzpOrder.id}`,
  );

  return sendResponse(res, 201, "Order created. Complete payment to confirm.", {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      total: order.total,
    },
    razorpay: {
      orderId: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    },
  });
});

// ─── Get My Orders ────────────────────────────────────────────────────────────

const getMyOrders = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, status } = req.query;
  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Number(limit));

  const filter = { userId: req.user._id };
  if (status) filter.status = status;

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select("-statusHistory -trackingHistory"),
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

// ─── Get Single Order ─────────────────────────────────────────────────────────

const getOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).populate("paymentId", "method status amount paidAt razorpayPaymentId");

  if (!order) throw new ApiError(404, "Order not found.");

  return sendResponse(res, 200, "Order fetched.", { order });
});

// ─── Cancel Order ─────────────────────────────────────────────────────────────

const cancelOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).populate("paymentId");

  if (!order) throw new ApiError(404, "Order not found.");

  const cancellableStatuses = ["pending", "confirmed", "packed"];
  if (!cancellableStatuses.includes(order.status)) {
    throw new ApiError(
      400,
      `Order cannot be cancelled — status is "${order.status}". Please contact support.`,
    );
  }

  order.status = "cancelled";
  order.cancelledBy = req.user._id;
  order.cancelledAt = new Date();
  order.statusHistory.push({
    status: "cancelled",
    note: "Cancelled by customer.",
    updatedBy: req.user._id,
  });

  // Restore stock only if payment was captured (stock was deducted)
  if (order.paymentId?.status === "captured") {
    await restoreStock(order.items);
    await Payment.findByIdAndUpdate(order.paymentId._id, {
      status: "refunded",
    });
    // NOTE: Initiate actual Razorpay refund via admin panel separately
  }

  await order.save();

  return sendResponse(res, 200, "Order cancelled successfully.", { order });
});

// ─── Track Order ──────────────────────────────────────────────────────────────

const trackOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!order) throw new ApiError(404, "Order not found.");

  if (!order.awbCode) {
    return sendResponse(res, 200, "Order has not been shipped yet.", {
      order,
      tracking: null,
    });
  }

  // Use cached tracking data if fresh (<30 min) or order is in terminal state
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const terminalStatuses = ["delivered", "cancelled", "rto", "refunded"];
  const isTerminal = terminalStatuses.includes(order.status);
  const isFresh =
    order.trackingUpdatedAt &&
    Date.now() - order.trackingUpdatedAt.getTime() < CACHE_TTL_MS;

  if (isTerminal || isFresh) {
    return sendResponse(res, 200, "Tracking fetched (cached).", {
      order,
      tracking: {
        currentStatus: order.trackingStatus,
        awbNumber: order.awbCode,
        shipmentTrackActivities: order.trackingHistory,
      },
    });
  }

  // Live fetch and update cache
  const tracking = await trackShipment(order.awbCode);

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      trackingStatus: tracking.currentStatus,
      trackingUpdatedAt: new Date(),
      trackingHistory: tracking.shipmentTrackActivities,
    },
  });

  return sendResponse(res, 200, "Tracking information fetched.", {
    order,
    tracking,
  });
});

module.exports = { placeOrder, getMyOrders, getOrder, cancelOrder, trackOrder };
