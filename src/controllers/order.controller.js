const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order.model');
const Cart = require('../models/Cart.model');
const Payment = require('../models/Payment.model');
const Product = require('../models/Product.model');
const Combo = require('../models/Combo.model');
const Coupon = require('../models/Coupon.model');
const { initiateRefund, createRazorpayOrder } = require('../services/razorpay.service');
const {
  getAvailableCouriers,
  trackShipment,
  selectBestCourier,
} = require('../services/shiprocket.service');
const { generateOrderNumber } = require('../utils/orderNumber');
const { restoreStock } = require('../utils/stock');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');
const logger = require('../utils/logger');

// ── Delivery charge rule-based logic ──────────────────────────────────────────
// Free delivery above FREE_DELIVERY_THRESHOLD; otherwise flat DELIVERY_FEE
const FREE_DELIVERY_THRESHOLD = 999;
const DELIVERY_FEE = 49;

const calculateDeliveryCharge = (subtotal) => {
  if (subtotal >= FREE_DELIVERY_THRESHOLD) return 0;
  return DELIVERY_FEE;
};

// ─── Helper: validate & fetch coupon ─────────────────────────────────────────
const resolveCoupon = async (code, subtotal) => {
  if (!code) return { coupon: null, discountAmount: 0 };

  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
  if (!coupon) throw new ApiError(400, `Coupon "${code}" not found.`);
  if (!coupon.active) throw new ApiError(400, 'Coupon is inactive.');
  if (coupon.expiryDate < new Date())
    throw new ApiError(400, 'Coupon has expired.');
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new ApiError(400, 'Coupon usage limit reached.');
  }
  if (subtotal < coupon.minOrderAmount) {
    throw new ApiError(
      400,
      `Minimum order ₹${coupon.minOrderAmount} required for coupon "${coupon.code}".`,
    );
  }

  const discountAmount = Math.round(coupon.calculateDiscount(subtotal));
  return { coupon, discountAmount };
};

// ─── Helper: resolve cheapest prepaid courier & actual rate ──────────────────
const resolveShippingCost = async (pincode, weightKg, subtotal) => {
  try {
    const couriers = await getAvailableCouriers({
      deliveryPincode: pincode,
      weight: weightKg,
      isCod: false,
    });

    if (!couriers.length) {
      throw new ApiError(400, 'Delivery not available to this pincode.');
    }

    const best = selectBestCourier(couriers);

    if (!best) {
      throw new ApiError(400, 'No suitable courier found.');
    }

    return {
      courierId: best.courier_company_id,
      courierName: best.courier_name,
      // Business pricing: free above threshold, flat fee otherwise
      shippingCost: calculateDeliveryCharge(subtotal),
      actualShippingCost: Math.round(best.rate),
      etd: best.etd ? String(best.etd) : '5-7',
    };
  } catch (err) {
    logger.warn('[resolveShippingCost] Failed', {
      error: err.message,
      pincode,
      weightKg,
    });
    throw new ApiError(400, 'Delivery not available to this location.');
  }
};

// ─── Place Order ──────────────────────────────────────────────────────────────
//
// PRODUCTION-SAFE FLOW:
//   1. Validate cart + coupon + stock
//   2. Calculate totals (incl. Shiprocket shipping rate)
//   3. Create Razorpay order (payment gateway)
//   4. Create Payment record with pendingOrderMeta (no Order in DB yet)
//   5. Return Razorpay details to frontend → user pays
//   6. Order is created ONLY inside verifyPayment / webhook after signature check

const placeOrder = catchAsync(async (req, res) => {
  const { shippingAddress, notes, couponCode } = req.body;

  // Reject any attempt to use COD or bypass online payment
  if (req.body.paymentMode && req.body.paymentMode !== 'ONLINE') {
    throw new ApiError(400, 'Only online payment is accepted.');
  }
  if (req.body.paymentMethod && req.body.paymentMethod !== 'razorpay') {
    throw new ApiError(400, 'Only Razorpay online payment is accepted.');
  }

  // 1. Fetch cart
  const cart = await Cart.findOne({ userId: req.user._id });
  if (!cart || cart.items.length === 0) {
    throw new ApiError(400, 'Your cart is empty.');
  }

  // 2. Idempotency guard
  const cartHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        cart.items.map((i) => ({
          id: String(i.productId),
          v: String(i.variantId),
          q: i.quantity,
        })),
      ),
    )
    .digest('hex')
    .slice(0, 16);

  const idempotencyKey = `${req.user._id}-${cartHash}-${couponCode || 'none'}-${shippingAddress.pincode}-ONLINE`;

  const existingPayment = await Payment.findOne({
    'pendingOrderMeta.idempotencyKey': idempotencyKey,
  }).select('+pendingOrderMeta');

  if (existingPayment && existingPayment.status === 'created') {
    logger.info(
      `[placeOrder] Idempotency hit — returning existing payment ${existingPayment.razorpayOrderId}`,
    );
    const meta = existingPayment.pendingOrderMeta;
    return sendResponse(
      res,
      200,
      'Order already initiated. Complete payment to confirm.',
      {
        order: {
          orderNumber: meta.orderNumber,
          subtotal: meta.subtotal,
          shippingCost: meta.shippingCost,
          tax: meta.tax,
          discountAmount: meta.discountAmount,
          total: meta.total,
          couponCode: meta.couponCode,
          courierName: meta.courierName,
          etd: meta.etd,
        },
        razorpay: {
          orderId: existingPayment.razorpayOrderId,
          amount: existingPayment.amount,
          currency: existingPayment.currency,
          keyId: process.env.RAZORPAY_KEY_ID,
        },
      },
    );
  }

  // 3. Validate stock & build order items
  const orderItems = [];
  let subtotal = 0;
  let totalWeightGrams = 0;

  for (const cartItem of cart.items) {
    if (cartItem.itemType === 'combo') {
      // ── Combo item ──────────────────────────────────────────────────────────
      const combo = await Combo.findById(cartItem.comboId).populate(
        'products.product',
        'name images variants isActive weight',
      );

      if (!combo || !combo.isActive) {
        throw new ApiError(400, `Combo "${cartItem.name}" is no longer available.`);
      }

      // Check stock for each product in combo
      for (const entry of combo.products) {
        const product = entry.product;
        if (!product || !product.isActive) {
          throw new ApiError(400, `A product in combo "${combo.name}" is no longer available.`);
        }
        const neededQty = entry.quantity * cartItem.quantity;
        const hasStock = product.variants.some((v) => v.stock >= neededQty);
        if (!hasStock) {
          throw new ApiError(
            400,
            `Insufficient stock for "${product.name}" in combo "${combo.name}".`,
          );
        }
        totalWeightGrams += (product.weight || 500) * neededQty;
      }

      orderItems.push({
        itemType: 'combo',
        comboId: combo._id,
        name: combo.name,
        image: combo.images?.[0] || combo.products[0]?.product?.images?.[0] || '',
        price: combo.price,
        quantity: cartItem.quantity,
        size: '',
        weightGrams: 500,
        comboSnapshot: {
          name: combo.name,
          price: combo.price,
          includedProducts: combo.products.map((e) => ({
            productId: e.product._id,
            name: e.product.name,
            quantity: e.quantity,
          })),
        },
      });

      subtotal += combo.price * cartItem.quantity;
    } else {
      // ── Product item ────────────────────────────────────────────────────────
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

      const itemWeightGrams = product.weight || 500;

      orderItems.push({
        itemType: 'product',
        productId: product._id,
        variantId: variant._id,
        name: product.name,
        size: variant.size,
        image: product.images?.[0] || '',
        price: variant.price,
        quantity: cartItem.quantity,
        weightGrams: itemWeightGrams,
      });

      subtotal += variant.price * cartItem.quantity;
      totalWeightGrams += itemWeightGrams * cartItem.quantity;
    }
  }

  // 4. Validate coupon
  const { coupon, discountAmount } = await resolveCoupon(couponCode, subtotal);

  // 5. Resolve shipping cost from Shiprocket serviceability
  const weightKg = Math.max(0.1, totalWeightGrams / 1000);
  const { courierId, courierName, shippingCost, actualShippingCost, etd } =
    await resolveShippingCost(shippingAddress.pincode, weightKg, subtotal);

  // 6. Calculate totals
  const taxRate = 0;
  const tax = Math.round(subtotal * taxRate);
  const total = Math.max(1, subtotal + shippingCost + tax - discountAmount);

  // Amount to charge via Razorpay (in paise)
  const razorpayAmountPaise = total * 100;

  // 7. Create Razorpay order
  const orderNumber = generateOrderNumber();
  const rzpOrder = await createRazorpayOrder(razorpayAmountPaise, orderNumber, {
    userId: req.user._id.toString(),
    customer: req.user.name,
  });

  // 8. Create Payment record with all pending order metadata.
  //    NO Order document is written to MongoDB at this point.
  await Payment.create({
    orderId: null,
    userId: req.user._id,
    method: 'razorpay',
    amount: razorpayAmountPaise,
    currency: 'INR',
    status: 'created',
    razorpayOrderId: rzpOrder.id,
    pendingOrderMeta: {
      idempotencyKey,
      orderNumber,
      items: orderItems,
      shippingAddress,
      notes: notes || '',
      couponCode: coupon ? coupon.code : null,
      couponId: coupon ? coupon._id : null,
      discountAmount,
      courierId,
      courierName,
      shippingCost,
      actualShippingCost,
      etd,
      subtotal,
      tax,
      total,
    },
  });

  logger.info(
    `[placeOrder] Razorpay order ${rzpOrder.id} created for user ${req.user._id}. ` +
      `Total=₹${total}. Order will be created after payment.`,
  );

  return sendResponse(
    res,
    201,
    'Payment initiated. Complete payment to place order.',
    {
      order: {
        orderNumber,
        subtotal,
        shippingCost,
        tax,
        discountAmount,
        total,
        couponCode: coupon ? coupon.code : null,
        courierName,
        etd,
      },
      razorpay: {
        orderId: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
      },
    },
  );
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
      .select('-statusHistory -trackingHistory'),
    Order.countDocuments(filter),
  ]);

  return sendResponse(
    res,
    200,
    'Orders fetched.',
    { orders },
    { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  );
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

// ─── Cancel Order (User) ──────────────────────────────────────────────────────

const cancelOrder = catchAsync(async (req, res) => {
  const { reason } = req.body;

  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).populate('paymentId');

  if (!order) throw new ApiError(404, 'Order not found.');

  if (order.awbCode) {
    throw new ApiError(400, 'Order cannot be cancelled — already dispatched.');
  }

  if (order.status !== 'confirmed') {
    throw new ApiError(
      400,
      `Order can only be cancelled when it is in "confirmed" status.`,
    );
  }

  const session = await mongoose.startSession();
  let paymentDoc = order.paymentId;

  try {
    await session.withTransaction(async () => {
      await restoreStock(order.items, session);

      if (order.couponId && order.discountAmount > 0) {
        await Coupon.findByIdAndUpdate(
          order.couponId,
          { $inc: { usageCount: -1 } },
          { session },
        );
      }

      order.status = 'cancelled';
      order.cancelledBy = req.user._id;
      order.cancelledAt = new Date();
      order.cancelReason = reason || 'Cancelled by customer.';

      order.statusHistory.push({
        status: 'cancelled',
        note: order.cancelReason,
        updatedBy: req.user._id,
      });

      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  // Refund AFTER transaction
  if (paymentDoc && paymentDoc.method === 'razorpay') {
    if (paymentDoc.status !== 'refunded') {
      try {
        const refund = await initiateRefund(
          paymentDoc.razorpayPaymentId,
          paymentDoc.amount,
        );

        await Payment.findByIdAndUpdate(paymentDoc._id, {
          status: 'refunded',
          refundId: refund.id,
          refundedAt: new Date(),
        });

        logger.info(
          `[cancelOrder] Refund success for order ${order.orderNumber}`,
        );
      } catch (err) {
        logger.error(
          `[cancelOrder] Refund FAILED for order ${order.orderNumber}: ${err.message}`,
        );

        await Payment.findByIdAndUpdate(paymentDoc._id, {
          status: 'refund_failed',
        });
      }
    }
  }

  return sendResponse(res, 200, 'Order cancelled successfully.', { order });
});

// ─── Track Order ──────────────────────────────────────────────────────────────

const trackOrder = catchAsync(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!order) throw new ApiError(404, 'Order not found.');

  if (!order.awbCode) {
    return sendResponse(res, 200, 'Order has not been shipped yet.', {
      order,
      tracking: null,
    });
  }

  const CACHE_TTL_MS = 30 * 60 * 1000;
  const terminalStatuses = ['delivered', 'cancelled', 'rto', 'refunded'];
  const isTerminal = terminalStatuses.includes(order.status);
  const isFresh =
    order.trackingUpdatedAt &&
    Date.now() - order.trackingUpdatedAt.getTime() < CACHE_TTL_MS;

  if (isTerminal || isFresh) {
    return sendResponse(res, 200, 'Tracking fetched (cached).', {
      order,
      tracking: {
        currentStatus: order.trackingStatus,
        awbNumber: order.awbCode,
        shipmentTrackActivities: order.trackingHistory,
      },
    });
  }

  const tracking = await trackShipment(order.awbCode);

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      trackingStatus: tracking.currentStatus,
      trackingUpdatedAt: new Date(),
      trackingHistory: tracking.shipmentTrackActivities,
    },
  });

  return sendResponse(res, 200, 'Tracking information fetched.', {
    order,
    tracking,
  });
});

module.exports = { placeOrder, getMyOrders, getOrder, cancelOrder, trackOrder };
