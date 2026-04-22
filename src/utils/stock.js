/**
 * Stock management helpers.
 * Extracted from order.controller to avoid circular dependency.
 * Session-aware for MongoDB transactions (Feature 5).
 */
const Product = require('../models/Product.model');

/**
 * Atomically decrements stock for all order items one-by-one.
 * Uses a $gte guard to prevent overselling under concurrent load.
 * Throws if any item has insufficient stock — caller's transaction rolls back.
 *
 * @param {Array}           items    - Array of { productId, variantId, quantity }
 * @param {ClientSession}   session  - Optional Mongoose session for transaction support
 */
const deductStock = async (items, session = null) => {
  for (const item of items) {
    const result = await Product.updateOne(
      {
        _id: item.productId,
        'variants._id': item.variantId,
        'variants.stock': { $gte: item.quantity }, // ← CRITICAL oversell guard
      },
      { $inc: { 'variants.$.stock': -item.quantity } },
      session ? { session } : {},
    );

    if (result.modifiedCount === 0) {
      // Another concurrent order won the race — abort the transaction
      throw new Error(
        `Insufficient stock for product ${item.productId} variant ${item.variantId}. ` +
          `Requested: ${item.quantity}`,
      );
    }
  }
};

/**
 * Re-increments stock on order cancellation / RTO.
 * Accepts optional Mongoose session for transaction support.
 */
const restoreStock = async (items, session = null) => {
  const ops = items.map((item) => ({
    updateOne: {
      filter: { _id: item.productId, 'variants._id': item.variantId },
      update: { $inc: { 'variants.$.stock': item.quantity } },
    },
  }));
  const options = session ? { session } : {};
  await Product.bulkWrite(ops, options);
};

module.exports = { deductStock, restoreStock };
