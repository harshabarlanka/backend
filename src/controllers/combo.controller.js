const Combo = require('../models/Combo.model');
const Product = require('../models/Product.model');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');
const slugify = require('slugify');

// ─── Public: list all active combos ──────────────────────────────────────────
const getCombos = catchAsync(async (req, res) => {
  const combos = await Combo.find({ isActive: true })
    .populate('products.product', 'name images variants price')
    .sort({ createdAt: -1 });

  return sendResponse(res, 200, 'Combos fetched.', { combos });
});

// ─── Public: get combo by slug ────────────────────────────────────────────────
const getComboBySlug = catchAsync(async (req, res) => {
  const combo = await Combo.findOne({ slug: req.params.slug, isActive: true }).populate(
    'products.product',
    'name images variants price slug category',
  );

  if (!combo) throw new ApiError(404, 'Combo not found.');

  return sendResponse(res, 200, 'Combo fetched.', { combo });
});

// ─── Admin: create combo ──────────────────────────────────────────────────────
const createCombo = catchAsync(async (req, res) => {
  const { name, description, products, price, category, images } = req.body;

  if (!name || !products || !Array.isArray(products) || products.length === 0) {
    throw new ApiError(400, 'Name and at least one product are required.');
  }
  if (typeof price !== 'number' || price < 0) {
    throw new ApiError(400, 'Valid combo price is required.');
  }

  // Auto-calculate originalPrice from product variant min prices × quantities
  let originalPrice = 0;
  for (const entry of products) {
    const product = await Product.findById(entry.product);
    if (!product || !product.isActive) {
      throw new ApiError(400, `Product ${entry.product} not found or inactive.`);
    }
    if (!product.variants || product.variants.length === 0) {
      throw new ApiError(400, `Product "${product.name}" has no variants.`);
    }
    const minPrice = Math.min(...product.variants.map((v) => v.price));
    originalPrice += minPrice * (entry.quantity || 1);
  }

  const baseSlug = slugify(name, { lower: true, strict: true });
  let slug = baseSlug;
  let counter = 1;
  while (await Combo.exists({ slug })) {
    slug = `${baseSlug}-${counter++}`;
  }

  const combo = await Combo.create({
    name,
    slug,
    description: description || '',
    products,
    price,
    originalPrice: Math.round(originalPrice),
    category: category || '',
    images: images || [],
  });

  const populated = await Combo.findById(combo._id).populate(
    'products.product',
    'name images variants price slug',
  );

  return sendResponse(res, 201, 'Combo created.', { combo: populated });
});

// ─── Admin: update combo ──────────────────────────────────────────────────────
const updateCombo = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { name, description, products, price, category, images, isActive } = req.body;

  const combo = await Combo.findById(id);
  if (!combo) throw new ApiError(404, 'Combo not found.');

  if (name && name !== combo.name) {
    const baseSlug = slugify(name, { lower: true, strict: true });
    let slug = baseSlug;
    let counter = 1;
    while (await Combo.exists({ slug, _id: { $ne: id } })) {
      slug = `${baseSlug}-${counter++}`;
    }
    combo.slug = slug;
    combo.name = name;
  }

  if (description !== undefined) combo.description = description;
  if (category !== undefined) combo.category = category;
  if (images !== undefined) combo.images = images;
  if (isActive !== undefined) combo.isActive = isActive;

  if (products && Array.isArray(products) && products.length > 0) {
    // Recalculate originalPrice
    let originalPrice = 0;
    for (const entry of products) {
      const product = await Product.findById(entry.product);
      if (!product || !product.isActive) {
        throw new ApiError(400, `Product ${entry.product} not found or inactive.`);
      }
      const minPrice = Math.min(...product.variants.map((v) => v.price));
      originalPrice += minPrice * (entry.quantity || 1);
    }
    combo.products = products;
    combo.originalPrice = Math.round(originalPrice);
  }

  if (price !== undefined) combo.price = price;

  await combo.save();

  const populated = await Combo.findById(combo._id).populate(
    'products.product',
    'name images variants price slug',
  );

  return sendResponse(res, 200, 'Combo updated.', { combo: populated });
});

// ─── Admin: soft delete (set isActive false) ──────────────────────────────────
const deleteCombo = catchAsync(async (req, res) => {
  const { id } = req.params;

  const combo = await Combo.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!combo) throw new ApiError(404, 'Combo not found.');

  return sendResponse(res, 200, 'Combo deleted.', { combo });
});

module.exports = {
  getCombos,
  getComboBySlug,
  createCombo,
  updateCombo,
  deleteCombo,
};
