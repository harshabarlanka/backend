const express = require("express");
const router = express.Router();

const {
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
} = require("../controllers/product.controller");

const { protect } = require("../middleware/auth.middleware");
const { restrictTo } = require("../middleware/admin.middleware");
const { validate, schemas } = require("../middleware/validate.middleware");

// Public routes — ORDER MATTERS: specific routes before /:slug
router.get("/", getProducts);
router.get("/bestsellers", getBestsellers);
router.get("/categories", getCategories);
router.get("/id/:id", getProductById);
router.get("/:slug", getProduct);
router.get("/:id/reviews", getReviews);

// Protected user routes
router.post("/:id/reviews", protect, validate(schemas.addReview), addReview);

// Admin-only routes
router.post(
  "/",
  protect,
  restrictTo("admin"),
  validate(schemas.createProduct),
  createProduct,
);

router.put(
  "/:id",
  protect,
  restrictTo("admin"),
  validate(schemas.updateProduct),
  updateProduct,
);

router.delete("/:id", protect, restrictTo("admin"), deleteProduct);

module.exports = router;
