const Product = require('../models/Product.model');
const Order = require('../models/Order.model');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');

// ─── Get All Products (with filtering, sorting, pagination) ───────────────────

const getProducts = catchAsync(async (req, res) => {
  const {
    page = 1,
    limit = 12,
    category,
    search,
    minPrice,
    maxPrice,
    sort = '-createdAt',
    featured,
  } = req.query;

  const filter = { isActive: true };

  if (category) filter.category = category;
  if (featured === 'true') filter.isFeatured = true;

  // Full-text search
  if (search) {
    filter.$text = { $search: search };
  }

  // Price filter (applied against minimum variant price)
  if (minPrice || maxPrice) {
    filter['variants.price'] = {};
    if (minPrice) filter['variants.price'].$gte = Number(minPrice);
    if (maxPrice) filter['variants.price'].$lte = Number(maxPrice);
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));
  const skip = (pageNum - 1) * limitNum;

  // Allowed sort fields
  const allowedSorts = ['-createdAt', 'createdAt', '-ratings.average', 'minPrice', '-minPrice'];
  const sortField = allowedSorts.includes(sort) ? sort : '-createdAt';

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort(sortField)
      .skip(skip)
      .limit(limitNum)
      .select('-reviews'), // Don't send review array in list view
    Product.countDocuments(filter),
  ]);

  return sendResponse(res, 200, 'Products fetched.', { products }, {
    total,
    page: pageNum,
    pages: Math.ceil(total / limitNum),
    limit: limitNum,
  });
});

// ─── Get Single Product by Slug ───────────────────────────────────────────────

const getProduct = catchAsync(async (req, res) => {
  const product = await Product.findOne({
    slug: req.params.slug,
    isActive: true,
  }).populate('reviews.userId', 'name');

  if (!product) {
    throw new ApiError(404, 'Product not found.');
  }

  return sendResponse(res, 200, 'Product fetched.', { product });
});

// ─── Get Product by ID (internal / admin use) ─────────────────────────────────

const getProductById = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  return sendResponse(res, 200, 'Product fetched.', { product });
});

// ─── Get All Categories ───────────────────────────────────────────────────────

const getCategories = catchAsync(async (req, res) => {
  const categories = await Product.distinct('category', { isActive: true });
  return sendResponse(res, 200, 'Categories fetched.', { categories });
});

// ─── Create Product (Admin) ───────────────────────────────────────────────────

const createProduct = catchAsync(async (req, res) => {
  const product = await Product.create(req.body);
  return sendResponse(res, 201, 'Product created successfully.', { product });
});

// ─── Update Product (Admin) ───────────────────────────────────────────────────

const updateProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!product) throw new ApiError(404, 'Product not found.');

  return sendResponse(res, 200, 'Product updated successfully.', { product });
});

// ─── Delete Product (Admin - soft delete) ────────────────────────────────────

const deleteProduct = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');

  product.isActive = false;
  await product.save();

  return sendResponse(res, 200, 'Product deactivated successfully.');
});

// ─── Add Review ───────────────────────────────────────────────────────────────

const addReview = catchAsync(async (req, res) => {
  const { rating, comment, orderId } = req.body;
  const product = await Product.findById(req.params.id);

  if (!product) throw new ApiError(404, 'Product not found.');

  // Prevent duplicate reviews from same user on same product
  const alreadyReviewed = product.reviews.some(
    (r) => r.userId.toString() === req.user._id.toString()
  );
  if (alreadyReviewed) {
    throw new ApiError(409, 'You have already reviewed this product.');
  }

  // Verify buyer: orderId must belong to this user and contain this product
  if (orderId) {
    const order = await Order.findOne({
      _id: orderId,
      userId: req.user._id,
      'items.productId': product._id,
      status: 'delivered',
    });
    if (!order) {
      throw new ApiError(403, 'You can only review products from delivered orders.');
    }
  }

  product.reviews.push({
    userId: req.user._id,
    name: req.user.name,
    orderId: orderId || undefined,
    rating,
    comment,
  });

  await product.save(); // pre-save hook recalculates ratings

  return sendResponse(res, 201, 'Review added successfully.', {
    ratings: product.ratings,
  });
});

// ─── Get Reviews ──────────────────────────────────────────────────────────────

const getReviews = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id)
    .select('reviews ratings')
    .populate('reviews.userId', 'name');

  if (!product) throw new ApiError(404, 'Product not found.');

  return sendResponse(res, 200, 'Reviews fetched.', {
    reviews: product.reviews,
    ratings: product.ratings,
  });
});

module.exports = {
  getProducts,
  getProduct,
  getProductById,
  getCategories,
  createProduct,
  updateProduct,
  deleteProduct,
  addReview,
  getReviews,
};
