const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order.model");
const Cart = require("../models/Cart.model");
const Payment = require("../models/Payment.model");
const Product = require("../models/Product.model");
const Coupon = require("../models/Coupon.model");
const { initiateRefund } = require("../services/razorpay.service");
const { createRazorpayOrder } = require("../services/razorpay.service");
const {
  getAvailableCouriers,
  trackShipment,
} = require("../services/shiprocket.service");
const { generateOrderNumber } = require("../utils/orderNumber");
const { restoreStock } = require("../utils/stock");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

// ─── Helper: validate & fetch coupon ─────────────────────────────────────────

const resolveCoupon = async (code, subtotal) => {
  if (!code) return { coupon: null, discountAmount: 0 };

  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
  if (!coupon) throw new ApiError(400, `Coupon "${code}" not found.`);
  if (!coupon.active) throw new ApiError(400, "Coupon is inactive.");
  if (coupon.expiryDate < new Date())
    throw new ApiError(400, "Coupon has expired.");
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new ApiError(400, "Coupon usage limit reached.");
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

const resolveShippingCost = async (pincode, weightKg) => {
  try {
    const couriers = await getAvailableCouriers({
      deliveryPincode: pincode,
      weight: weightKg,
      isCod: false,
    });

    // ❌ No courier → block order
    if (!couriers.length) {
      throw new ApiError(400, "Delivery not available to this pincode.");
    }

    // ✅ Pick first available courier (no sorting needed)
    const selected = couriers[0];

    return {
      courierId: selected.courier_company_id,
      courierName: selected.courier_name,
      shippingCost: 60, // ✅ Flat price
      etd: selected.etd ? String(selected.etd) : "5-7",
    };
  } catch (err) {
    logger.warn("[resolveShippingCost] Failed", {
      error: err.message,
    });

    // ❌ DO NOT silently allow order
    throw new ApiError(400, "Delivery not available to this location.");
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
//
// Audit fix 2.3: idempotency key is now a hash of cart contents, not the
// cart.updatedAt timestamp. This prevents orphaned Payment records when a user
// adds/removes/re-adds items that result in the same cart.

const placeOrder = catchAsync(async (req, res) => {
  const { shippingAddress, notes, couponCode, paymentMode } = req.body;

  // ── Validate paymentMode ────────────────────────────────────────────────────
  // Accepted values: 'ONLINE' (default) | 'COD_PARTIAL'
  const resolvedPaymentMode =
    paymentMode === "COD_PARTIAL" ? "COD_PARTIAL" : "ONLINE";

  // 1. Fetch cart
  const cart = await Cart.findOne({ userId: req.user._id });
  if (!cart || cart.items.length === 0) {
    throw new ApiError(400, "Your cart is empty.");
  }

  // 2. Idempotency guard — hash cart contents (not timestamp) so that
  //    identical carts from different tabs or after add/remove/re-add cycles
  //    produce the same key and reuse the existing Razorpay order.
  const cartHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        cart.items.map((i) => ({
          id: String(i.productId),
          v: String(i.variantId),
          q: i.quantity,
        })),
      ),
    )
    .digest("hex")
    .slice(0, 16);

  const idempotencyKey = `${req.user._id}-${cartHash}-${couponCode || "none"}-${shippingAddress.pincode}-${resolvedPaymentMode}`;

  const existingPayment = await Payment.findOne({
    "pendingOrderMeta.idempotencyKey": idempotencyKey,
  }).select("+pendingOrderMeta");

  if (existingPayment && existingPayment.status === "created") {
    logger.info(
      `[placeOrder] Idempotency hit — returning existing payment ${existingPayment.razorpayOrderId}`,
    );
    const meta = existingPayment.pendingOrderMeta;
    return sendResponse(
      res,
      200,
      "Order already initiated. Complete payment to confirm.",
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
          // ── Partial COD fields ───────────────────────────
          paymentMode: meta.paymentMode,
          codFee: meta.codFee || 0,
          advancePaidAmount: meta.advancePaidAmount || 0,
          codRemainingAmount: meta.codRemainingAmount || 0,
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
      productId: product._id,
      variantId: variant._id,
      name: product.name,
      size: variant.size,
      image: product.images?.[0] || "",
      price: variant.price,
      quantity: cartItem.quantity,
      weightGrams: itemWeightGrams, // audit fix 5.4: store actual weight
    });

    subtotal += variant.price * cartItem.quantity;
    totalWeightGrams += itemWeightGrams * cartItem.quantity;
  }

  // 4. Validate coupon (check validity only — do NOT increment usageCount yet)
  const { coupon, discountAmount } = await resolveCoupon(couponCode, subtotal);

  // 5. Resolve shipping cost from Shiprocket serviceability
  const weightKg = Math.max(0.1, totalWeightGrams / 1000);
  const { courierId, courierName, shippingCost, etd } =
    await resolveShippingCost(shippingAddress.pincode, weightKg);

  // 6. Calculate totals
  const taxRate = 0;
  const tax = Math.round(subtotal * taxRate);

  // ── Partial COD Calculation ────────────────────────────────────────────────
  // For COD_PARTIAL: add ₹50 COD handling fee (charged by Shiprocket).
  // IMPORTANT: advancePaidAmount is 20% of (subtotal + shipping + codFee),
  // i.e., the COD fee is included BEFORE splitting 20/80.
  // Backend always recalculates — never trusts frontend values.
  const COD_FEE = 50;
  const codFee = resolvedPaymentMode === "COD_PARTIAL" ? COD_FEE : 0;
  const total = Math.max(
    1,
    subtotal + shippingCost + tax - discountAmount + codFee,
  );

  // For COD_PARTIAL: Razorpay collects only 20% upfront; remaining 80% paid at door
  const advancePaidAmount =
    resolvedPaymentMode === "COD_PARTIAL" ? Math.round(total * 0.2) : total;
  const codRemainingAmount =
    resolvedPaymentMode === "COD_PARTIAL" ? total - advancePaidAmount : 0;

  // Amount to charge via Razorpay (in paise)
  const razorpayAmountPaise = advancePaidAmount * 100;

  // 7. Create Razorpay order (with idempotency key — audit fix 2.6)
  const orderNumber = generateOrderNumber();
  const rzpOrder = await createRazorpayOrder(razorpayAmountPaise, orderNumber, {
    userId: req.user._id.toString(),
    customer: req.user.name,
    paymentMode: resolvedPaymentMode,
  });

  // 8. Create Payment record with all pending order metadata.
  //    NO Order document is written to MongoDB at this point.
  //    The Order will be created inside verifyPayment after signature verification.
  await Payment.create({
    orderId: null, // will be set after order creation in verifyPayment
    userId: req.user._id,
    method: "razorpay",
    amount: razorpayAmountPaise, // advance amount only for COD_PARTIAL
    currency: "INR",
    status: "created",
    razorpayOrderId: rzpOrder.id,
    pendingOrderMeta: {
      // Idempotency
      idempotencyKey,
      orderNumber,
      // Cart snapshot
      items: orderItems,
      shippingAddress,
      notes: notes || "",
      // Coupon
      couponCode: coupon ? coupon.code : null,
      couponId: coupon ? coupon._id : null,
      discountAmount,
      // Shipping
      courierId,
      courierName,
      shippingCost,
      etd,
      // Pricing
      subtotal,
      tax,
      total,
      // ── Partial COD fields ────────────────────────────────────────────────
      paymentMode: resolvedPaymentMode,
      codFee,
      advancePaidAmount,
      codRemainingAmount,
    },
  });

  logger.info(
    `[placeOrder] Razorpay order ${rzpOrder.id} created for user ${req.user._id}. ` +
      `Mode=${resolvedPaymentMode}. Advance=${advancePaidAmount}. ` +
      `Order will be created after payment.`,
  );

  return sendResponse(
    res,
    201,
    "Payment initiated. Complete payment to place order.",
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
        // ── Partial COD fields ───────────────────────────
        paymentMode: resolvedPaymentMode,
        codFee,
        advancePaidAmount,
        codRemainingAmount,
      },
      razorpay: {
        orderId: rzpOrder.id,
        amount: rzpOrder.amount, // advance only for COD_PARTIAL
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
      .select("-statusHistory -trackingHistory"),
    Order.countDocuments(filter),
  ]);

  return sendResponse(
    res,
    200,
    "Orders fetched.",
    { orders },
    { total, page: pageNum, pages: Math.ceil(total / limitNum) },
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

// ─── Cancel Order (User) ──────────────────────────────────────────────────────
// Allowed: status = confirmed OR preparing AND no AWB assigned
//
// Audit fix 1.5: all mutations are wrapped in a MongoDB transaction so that
// stock restore, coupon reverse, order save, and payment update are atomic.

const cancelOrder = catchAsync(async (req, res) => {
  const { reason } = req.body;

  const order = await Order.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).populate("paymentId");

  if (!order) throw new ApiError(404, "Order not found.");

  if (order.awbCode) {
    throw new ApiError(400, "Order cannot be cancelled — already dispatched.");
  }

  if (order.status !== "confirmed") {
    throw new ApiError(
      400,
      `Order can only be cancelled when it is in "confirmed" status.`,
    );
  }

  const session = await mongoose.startSession();

  let paymentDoc = order.paymentId;

  try {
    await session.withTransaction(async () => {
      // Restore stock
      await restoreStock(order.items, session);

      // Reverse coupon
      if (order.couponId && order.discountAmount > 0) {
        await Coupon.findByIdAndUpdate(
          order.couponId,
          { $inc: { usageCount: -1 } },
          { session },
        );
      }

      // Update order
      order.status = "cancelled";
      order.cancelledBy = req.user._id;
      order.cancelledAt = new Date();
      order.cancelReason = reason || "Cancelled by customer.";

      order.statusHistory.push({
        status: "cancelled",
        note: order.cancelReason,
        updatedBy: req.user._id,
      });

      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  // 🔥 IMPORTANT: Refund AFTER transaction
  if (paymentDoc && paymentDoc.method === "razorpay") {
    if (paymentDoc.status !== "refunded") {
      try {
        const refund = await initiateRefund(
          paymentDoc.razorpayPaymentId,
          paymentDoc.amount,
        );

        await Payment.findByIdAndUpdate(paymentDoc._id, {
          status: "refunded",
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
          status: "refund_failed", // 🔥 important
        });
      }
    }
  }

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
