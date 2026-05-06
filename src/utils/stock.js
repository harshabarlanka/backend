/**
 * Stock management helpers.
 * Extracted from order.controller to avoid circular dependency.
 * Session-aware for MongoDB transactions (Feature 5).
 */
const Product = require('../models/Product.model');
const Combo = require('../models/Combo.model');

/**
 * Atomically decrements stock for all order items one-by-one.
 * Supports both product items and combo items.
 * Uses a $gte guard to prevent overselling under concurrent load.
 * Throws if any item has insufficient stock — caller's transaction rolls back.
 *
 * @param {Array}           items    - Array of order items (product or combo type)
 * @param {ClientSession}   session  - Optional Mongoose session for transaction support
 */
const deductStock = async (items, session = null) => {
  for (const item of items) {
    if (item.itemType === 'combo') {
      // Deduct stock for each product inside the combo
      const combo = await Combo.findById(item.comboId).session(session);
      if (!combo) {
        throw new Error(`Combo ${item.comboId} not found during stock deduction.`);
      }
      for (const entry of combo.products) {
        const neededQty = entry.quantity * item.quantity;
        // Find variant with lowest price (the one used for pricing) and deduct from it
        const product = await Product.findById(entry.product).session(session);
        if (!product) {
          throw new Error(`Product ${entry.product} not found.`);
        }
        // Find first variant with sufficient stock
        const variant = product.variants.find((v) => v.stock >= neededQty);
        if (!variant) {
          throw new Error(
            `Insufficient stock for product "${product.name}" in combo "${combo.name}". ` +
              `Requested: ${neededQty}`,
          );
        }
        const result = await Product.updateOne(
          {
            _id: entry.product,
            'variants._id': variant._id,
            'variants.stock': { $gte: neededQty },
          },
          { $inc: { 'variants.$.stock': -neededQty } },
          session ? { session } : {},
        );
        if (result.modifiedCount === 0) {
          throw new Error(
            `Insufficient stock for product "${product.name}" in combo "${combo.name}".`,
          );
        }
      }
    } else {
      // Standard product item
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
  }
};

/**
 * Re-increments stock on order cancellation / RTO.
 * Accepts optional Mongoose session for transaction support.
 */
const restoreStock = async (items, session = null) => {
  const productOps = [];

  for (const item of items) {
    if (item.itemType === 'combo') {
      // Restore stock for each product in combo snapshot
      const combo = await Combo.findById(item.comboId);
      if (!combo) continue;
      for (const entry of combo.products) {
        const product = await Product.findById(entry.product);
        if (!product || !product.variants.length) continue;
        const variant = product.variants[0]; // restore to first variant
        productOps.push({
          updateOne: {
            filter: { _id: entry.product, 'variants._id': variant._id },
            update: { $inc: { 'variants.$.stock': entry.quantity * item.quantity } },
          },
        });
      }
    } else if (item.productId && item.variantId) {
      productOps.push({
        updateOne: {
          filter: { _id: item.productId, 'variants._id': item.variantId },
          update: { $inc: { 'variants.$.stock': item.quantity } },
        },
      });
    }
  }

  if (productOps.length > 0) {
    const options = session ? { session } : {};
    await Product.bulkWrite(productOps, options);
  }
};

module.exports = { deductStock, restoreStock };
