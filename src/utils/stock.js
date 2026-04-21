/**
 * Stock management helpers.
 * Extracted from order.controller to avoid circular dependency.
 * Session-aware for MongoDB transactions (Feature 5).
 */
const Product = require("../models/Product.model");

/**
 * Atomically decrements stock for all order items using bulkWrite.
 * Accepts optional Mongoose session for transaction support.
 */
const deductStock = async (items, session = null) => {
  const ops = items.map((item) => ({
    updateOne: {
      filter: { _id: item.productId, "variants._id": item.variantId },
      update: { $inc: { "variants.$.stock": -item.quantity } },
    },
  }));
  const options = session ? { session } : {};
  await Product.bulkWrite(ops, options);
};

/**
 * Re-increments stock on order cancellation.
 * Accepts optional Mongoose session for transaction support.
 */
const restoreStock = async (items, session = null) => {
  const ops = items.map((item) => ({
    updateOne: {
      filter: { _id: item.productId, "variants._id": item.variantId },
      update: { $inc: { "variants.$.stock": item.quantity } },
    },
  }));
  const options = session ? { session } : {};
  await Product.bulkWrite(ops, options);
};

module.exports = { deductStock, restoreStock };
