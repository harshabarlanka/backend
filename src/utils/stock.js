/**
 * Stock management helpers.
 * Extracted from order.controller to avoid circular dependency
 * between order.controller and payment.controller.
 */
const Product = require('../models/Product.model');

/**
 * Atomically decrements stock for all order items using bulkWrite.
 * Safe against concurrent orders (uses $inc, not read-modify-write).
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
 * Re-increments stock on order cancellation.
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

module.exports = { deductStock, restoreStock };