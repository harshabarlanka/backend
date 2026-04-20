const Order = require('../models/Order.model');
const Cart = require('../models/Cart.model');
const Payment = require('../models/Payment.model');
const Product = require('../models/Product.model');
const { createRazorpayOrder } = require('../services/razorpay.service');
const { trackShipment, autoCreateShipment } = require('../services/shiprocket.service');
const { sendOrderConfirmationEmail } = require('../services/email.service');
const { generateOrderNumber } = require('../utils/orderNumber');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');
const logger = require('../utils/logger');

// ─── Place Order ──────────────────────────────────────────────────────────────

const placeOrder = catchAsync(async (req, res) => {
  const { shippingAddress, paymentMethod, notes } = req.body;

  // 1. Fetch user's cart
  const cart = await Cart.findOne({ userId: req.user._id });
  if (!cart || cart.items.length === 0) {
    throw new ApiError(400, 'Your cart is empty. Please add items before placing an order.');
  }

  // 2. Validate stock and build order items (snapshot at purchase time)
  const orderItems = [];
  let subtotal = 0;

  for (const cartItem of cart.items) {
    const product = await Product.findById(cartItem.productId);
    if (!product || !product.isActive) {
      throw new ApiError(400, `Product "${cartItem.name}" is no longer available.`);
    }

    const variant = product.variants.id(cartItem.variantId);
    if (!variant) {
      throw new ApiError(400, `Variant for "${cartItem.name}" not found.`);
    }

    if (variant.stock < cartItem.quantity) {
      throw new ApiError(
        400,
        `Insufficient stock for "${cartItem.name} (${variant.size})". Only ${variant.stock} units left.`
      );
    }

    orderItems.push({
      productId: product._id,
      variantId: variant._id,
      name: product.name,
      size: variant.size,
      image: product.images?.[0] || '',
      price: variant.price,
      quantity: cartItem.quantity,
    });

    subtotal += variant.price * cartItem.quantity;
  }

  // 3. Calculate totals
  const shippingCharge = subtotal >= 500 ? 0 : 60;
  const taxRate = 0.12;
  const tax = Math.round(subtotal * taxRate);
  const total = subtotal + shippingCharge + tax;

  // 4. Generate order number
  const orderNumber = generateOrderNumber();

  // 5. Create order document
  const order = await Order.create({
    orderNumber,
    userId: req.user._id,
    items: orderItems,
    shippingAddress,
    paymentMethod,
    notes,
    subtotal,
    shippingCharge,
    tax,
    total,
    status: paymentMethod === 'cod' ? 'confirmed' : 'pending',
    statusHistory: [
      {
        status: paymentMethod === 'cod' ? 'confirmed' : 'pending',
        note:
          paymentMethod === 'cod'
            ? 'Order placed with Cash on Delivery.'
            : 'Order created, awaiting payment.',
        updatedBy: req.user._id,
      },
    ],
  });

  // 6. Create payment record
  const paymentData = {
    orderId: order._id,
    userId: req.user._id,
    method: paymentMethod,
    amount: paymentMethod === 'razorpay' ? total * 100 : total,
    currency: 'INR',
    status: paymentMethod === 'cod' ? 'cod_pending' : 'created',
  };

  // 7a. Razorpay: create RZP order and return credentials to frontend.
  //     Stock is NOT deducted here — deducted only after payment is verified.
  //     Shiprocket shipment is also NOT created here — created after verification.
  if (paymentMethod === 'razorpay') {
    const rzpOrder = await createRazorpayOrder(total * 100, orderNumber, {
      order_id: order._id.toString(),
      customer: req.user.name,
    });

    paymentData.razorpayOrderId = rzpOrder.id;
    const payment = await Payment.create(paymentData);

    order.paymentId = payment._id;
    await order.save();

    return sendResponse(res, 201, 'Order created. Complete payment to confirm.', {
      order: { _id: order._id, orderNumber: order.orderNumber, total: order.total },
      razorpay: {
        orderId: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
      },
    });
  }

  // 7b. COD: confirm immediately, deduct stock, clear cart, then auto-create shipment
  const payment = await Payment.create(paymentData);
  order.paymentId = payment._id;
  await order.save();

  await deductStock(orderItems);
  await Cart.findOneAndUpdate({ userId: req.user._id }, { $set: { items: [] } });

  // ADDED: Auto-create Shiprocket shipment for COD orders immediately on placement.
  // The order is already 'confirmed' at this point so we have all the info needed.
  // autoCreateShipment is non-throwing — failure is logged and noted, order still goes through.
  await autoCreateShipment(order, req.user);
  await order.save(); // persist AWB and shipment fields written by autoCreateShipment

  logger.info(
    `COD order ${order.orderNumber} confirmed. AWB: ${order.awbCode || 'pending (auto-create failed)'}`
  );

  // Fire-and-forget confirmation email
  sendOrderConfirmationEmail({ email: req.user.email, name: req.user.name, order });

  return sendResponse(res, 201, 'Order placed successfully.', {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total,
      paymentMethod: order.paymentMethod,
      awbCode: order.awbCode,       // ADDED: surface AWB in response for COD
      courierName: order.courierName, // ADDED
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
      .select('-statusHistory'),
    Order.countDocuments(filter),
  ]);

  return sendResponse(res, 200, 'Orders fetched.', { orders }, {
    total,
    page: pageNum,
    pages: Math.ceil(total / limitNum),
  });
});

// ─── Get Single Order ─────────────────────────────────────────────────────────

const getOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).populate('paymentId', 'method status amount paidAt razorpayPaymentId');

  if (!order) throw new ApiError(404, 'Order not found.');

  return sendResponse(res, 200, 'Order fetched.', { order });
});

// ─── Cancel Order ─────────────────────────────────────────────────────────────

const cancelOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).populate('paymentId');

  if (!order) throw new ApiError(404, 'Order not found.');

  const cancellableStatuses = ['pending', 'confirmed', 'packed'];
  if (!cancellableStatuses.includes(order.status)) {
    throw new ApiError(
      400,
      `Order cannot be cancelled — current status is "${order.status}". Please contact support.`
    );
  }

  order.status = 'cancelled';
  order.statusHistory.push({
    status: 'cancelled',
    note: 'Cancelled by customer.',
    updatedBy: req.user._id,
  });

  // Only restore stock if payment was captured (i.e. stock was actually deducted).
  // 'pending' = Razorpay order not yet paid → stock never deducted → skip restore.
  const paymentCaptured =
    order.paymentId &&
    (order.paymentId.status === 'captured' || order.paymentId.status === 'cod_pending');

  if (paymentCaptured) {
    await restoreStock(order.items);
  }

  await order.save();

  // Mark online payment as refunded if it was already captured
  if (order.paymentId && order.paymentId.status === 'captured') {
    await Payment.findByIdAndUpdate(order.paymentId._id, { status: 'refunded' });
  }

  return sendResponse(res, 200, 'Order cancelled successfully.', { order });
});

// ─── Track Order ──────────────────────────────────────────────────────────────

const trackOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).select('awbCode status statusHistory orderNumber courierName trackingStatus trackingUpdatedAt');

  if (!order) throw new ApiError(404, 'Order not found.');

  if (!order.awbCode) {
    return sendResponse(res, 200, 'Order has not been shipped yet.', {
      order,
      tracking: null,
    });
  }

  const tracking = await trackShipment(order.awbCode);

  return sendResponse(res, 200, 'Tracking information fetched.', { order, tracking });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decrements stock for all items in the order atomically.
 * Uses bulkWrite with $inc to handle concurrent orders safely.
 */
const deductStock = async (items) => {
  const ops = items.map((item) => ({
    updateOne: {
      filter: { _id: item.productId, 'variants._id': item.variantId },
      update: { $inc: { 'variants.$.stock': -item.quantity } },
    },
  }));
  await Product.bulkWrite(ops);
};

/**
 * Re-increments stock when an order is cancelled.
 */
const restoreStock = async (items) => {
  const ops = items.map((item) => ({
    updateOne: {
      filter: { _id: item.productId, 'variants._id': item.variantId },
      update: { $inc: { 'variants.$.stock': item.quantity } },
    },
  }));
  await Product.bulkWrite(ops);
};

module.exports = {
  placeOrder,
  getMyOrders,
  getOrder,
  cancelOrder,
  trackOrder,
  deductStock,
  restoreStock,
};
