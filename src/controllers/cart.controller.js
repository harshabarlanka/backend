const Cart = require('../models/Cart.model');
const Product = require('../models/Product.model');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');

// ─── Get Cart ─────────────────────────────────────────────────────────────────

const getCart = catchAsync(async (req, res) => {
  const cart = await Cart.findOne({ userId: req.user._id });

  if (!cart) {
    return sendResponse(res, 200, 'Cart is empty.', {
      cart: { items: [], subtotal: 0, totalItems: 0 },
    });
  }

  return sendResponse(res, 200, 'Cart fetched.', { cart });
});

// ─── Add Item to Cart ─────────────────────────────────────────────────────────

const addToCart = catchAsync(async (req, res) => {
  const { productId, variantId, quantity } = req.body;

  // Validate product and variant exist, and stock is sufficient
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    throw new ApiError(404, 'Product not found or unavailable.');
  }

  const variant = product.variants.id(variantId);
  if (!variant) {
    throw new ApiError(404, 'Product variant not found.');
  }

  if (variant.stock < quantity) {
    throw new ApiError(400, `Only ${variant.stock} units available in stock.`);
  }

  // Upsert: find existing cart or create one
  let cart = await Cart.findOne({ userId: req.user._id });

  if (!cart) {
    cart = new Cart({ userId: req.user._id, items: [] });
  }

  // Check if the same variant is already in cart
  const existingItemIndex = cart.items.findIndex(
    (item) =>
      item.productId.toString() === productId &&
      item.variantId.toString() === variantId
  );

  if (existingItemIndex > -1) {
    const newQuantity = cart.items[existingItemIndex].quantity + quantity;

    if (newQuantity > 20) {
      throw new ApiError(400, 'Cannot add more than 20 units of one item.');
    }
    if (variant.stock < newQuantity) {
      throw new ApiError(400, `Only ${variant.stock} units available in stock.`);
    }

    cart.items[existingItemIndex].quantity = newQuantity;
    // Refresh price in case it changed
    cart.items[existingItemIndex].price = variant.price;
  } else {
    cart.items.push({
      productId: product._id,
      variantId: variant._id,
      name: product.name,
      image: product.images?.[0] || '',
      size: variant.size,
      price: variant.price,
      quantity,
    });
  }

  await cart.save();

  return sendResponse(res, 200, 'Item added to cart.', { cart });
});

// ─── Update Cart Item Quantity ────────────────────────────────────────────────

const updateCartItem = catchAsync(async (req, res) => {
  const { itemId } = req.params;
  const { quantity } = req.body;

  const cart = await Cart.findOne({ userId: req.user._id });
  if (!cart) throw new ApiError(404, 'Cart not found.');

  const item = cart.items.id(itemId);
  if (!item) throw new ApiError(404, 'Cart item not found.');

  // Verify stock still available
  const product = await Product.findById(item.productId);
  const variant = product?.variants.id(item.variantId);

  if (!variant || variant.stock < quantity) {
    throw new ApiError(400, `Only ${variant?.stock || 0} units available in stock.`);
  }

  item.quantity = quantity;
  // Refresh price
  item.price = variant.price;

  await cart.save();

  return sendResponse(res, 200, 'Cart updated.', { cart });
});

// ─── Remove Cart Item ─────────────────────────────────────────────────────────

const removeCartItem = catchAsync(async (req, res) => {
  const { itemId } = req.params;

  const cart = await Cart.findOne({ userId: req.user._id });
  if (!cart) throw new ApiError(404, 'Cart not found.');

  const item = cart.items.id(itemId);
  if (!item) throw new ApiError(404, 'Cart item not found.');

  item.deleteOne();
  await cart.save();

  return sendResponse(res, 200, 'Item removed from cart.', { cart });
});

// ─── Clear Cart ───────────────────────────────────────────────────────────────

const clearCart = catchAsync(async (req, res) => {
  await Cart.findOneAndUpdate(
    { userId: req.user._id },
    { $set: { items: [], coupon: {} } },
    { new: true }
  );

  return sendResponse(res, 200, 'Cart cleared.');
});

module.exports = {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
};
