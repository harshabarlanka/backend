const Product = require("../models/Product.model");
const Order = require("../models/Order.model");
const ApiError = require("../utils/ApiError");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");

// ─── Get All Products (sorting, pagination) ───────────────────────────────────

const getProducts = catchAsync(async (req, res) => {
  const { page = 1, limit = 12, category, sort = "-createdAt" } = req.query;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));
  const skip = (pageNum - 1) * limitNum;

  const match = { isActive: true };
  if (category) match.category = category;

  const pipeline = [
    { $match: match },
    { $addFields: { minPrice: { $min: "$variants.price" } } },
  ];

  const SORT_MAP = {
    minPrice: { minPrice: 1 },
    "-minPrice": { minPrice: -1 },
    createdAt: { createdAt: 1 },
    "-createdAt": { createdAt: -1 },
    "-ratings.average": { "ratings.average": -1 },
  };

  pipeline.push({ $sort: SORT_MAP[sort] || { createdAt: -1 } });
  pipeline.push({ $skip: skip }, { $limit: limitNum });

  const [products, total] = await Promise.all([
    Product.aggregate(pipeline),
    Product.countDocuments(match),
  ]);

  return sendResponse(
    res,
    200,
    "Products fetched.",
    { products },
    { total, page: pageNum, pages: Math.ceil(total / limitNum), limit: limitNum },
  );
});

// ─── Get Bestsellers ──────────────────────────────────────────────────────────
// Priority: totalOrders DESC → averageRating DESC

const getBestsellers = catchAsync(async (req, res) => {
  const { limit = 4, page = 1 } = req.query;
  const limitNum = Math.min(100, Math.max(1, Number(limit)));
  const pageNum = Math.max(1, Number(page));
  const skip = (pageNum - 1) * limitNum;

  // Single aggregation: join order counts into products
  const pipeline = [
    { $match: { isActive: true } },
    {
      $lookup: {
        from: "orders",
        let: { productId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $in: ["$status", ["delivered", "shipped", "confirmed", "preparing", "ready_for_pickup"]] },
                  { $in: ["$$productId", "$items.productId"] },
                ],
              },
            },
          },
          { $unwind: "$items" },
          {
            $match: {
              $expr: { $eq: ["$items.productId", "$$productId"] },
            },
          },
          {
            $group: {
              _id: null,
              totalOrders: { $sum: "$items.quantity" },
            },
          },
        ],
        as: "orderStats",
      },
    },
    {
      $addFields: {
        totalOrders: {
          $ifNull: [{ $arrayElemAt: ["$orderStats.totalOrders", 0] }, 0],
        },
        minPrice: { $min: "$variants.price" },
      },
    },
    { $unset: "orderStats" },
    {
      $sort: { totalOrders: -1, "ratings.average": -1 },
    },
  ];

  // Count total before pagination
  const countPipeline = [...pipeline, { $count: "total" }];
  const [countResult, products] = await Promise.all([
    Product.aggregate(countPipeline),
    Product.aggregate([...pipeline, { $skip: skip }, { $limit: limitNum }]),
  ]);

  const total = countResult[0]?.total || 0;

  return sendResponse(
    res,
    200,
    "Bestsellers fetched.",
    { products },
    { total, page: pageNum, pages: Math.ceil(total / limitNum), limit: limitNum },
  );
});

// ─── Get Single Product by Slug ───────────────────────────────────────────────

const getProduct = catchAsync(async (req, res) => {
  const product = await Product.findOne({
    slug: req.params.slug,
    isActive: true,
  }).populate("reviews.userId", "name");

  if (!product) throw new ApiError(404, "Product not found.");

  return sendResponse(res, 200, "Product fetched.", { product });
});

// ─── Get Product by ID ────────────────────────────────────────────────────────

const getProductById = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, "Product not found.");
  return sendResponse(res, 200, "Product fetched.", { product });
});

// ─── Categories ───────────────────────────────────────────────────────────────

const getCategories = catchAsync(async (req, res) => {
  const categories = await Product.distinct("category", { isActive: true });
  return sendResponse(res, 200, "Categories fetched.", { categories });
});

// ─── Create Product ───────────────────────────────────────────────────────────

const createProduct = catchAsync(async (req, res) => {
  const product = await Product.create(req.body);
  return sendResponse(res, 201, "Product created successfully.", { product });
});

// ─── Update Product ───────────────────────────────────────────────────────────

const updateProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true, runValidators: true },
  );
  if (!product) throw new ApiError(404, "Product not found.");
  return sendResponse(res, 200, "Product updated successfully.", { product });
});

// ─── Delete Product (soft delete) ─────────────────────────────────────────────

const deleteProduct = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, "Product not found.");
  product.isActive = false;
  await product.save();
  return sendResponse(res, 200, "Product deactivated successfully.");
});

// ─── Add Review ───────────────────────────────────────────────────────────────

const addReview = catchAsync(async (req, res) => {
  const { rating, comment, orderId } = req.body;
  const product = await Product.findById(req.params.id);

  if (!product) throw new ApiError(404, "Product not found.");

  const alreadyReviewed = product.reviews.some(
    (r) => r.userId.toString() === req.user._id.toString(),
  );
  if (alreadyReviewed) throw new ApiError(409, "You have already reviewed this product.");

  if (orderId) {
    const order = await Order.findOne({
      _id: orderId,
      userId: req.user._id,
      "items.productId": product._id,
      status: "delivered",
    });
    if (!order) throw new ApiError(403, "You can only review products from delivered orders.");
  }

  product.reviews.push({
    userId: req.user._id,
    name: req.user.name,
    orderId: orderId || undefined,
    rating,
    comment,
  });

  await product.save();

  return sendResponse(res, 201, "Review added successfully.", {
    ratings: product.ratings,
  });
});

// ─── Get Reviews ──────────────────────────────────────────────────────────────

const getReviews = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id)
    .select("reviews ratings")
    .populate("reviews.userId", "name");

  if (!product) throw new ApiError(404, "Product not found.");

  return sendResponse(res, 200, "Reviews fetched.", {
    reviews: product.reviews,
    ratings: product.ratings,
  });
});

module.exports = {
  getProducts,
  getBestsellers,
  getProduct,
  getProductById,
  getCategories,
  createProduct,
  updateProduct,
  deleteProduct,
  addReview,
  getReviews,
};
