const express = require("express");
const router = express.Router();

const {
  placeOrder,
  getMyOrders,
  getOrder,
  cancelOrder,
  trackOrder,
} = require("../controllers/order.controller");

const { protect } = require("../middleware/auth.middleware");
const { validate, schemas } = require("../middleware/validate.middleware");

// All order routes require authentication
router.use(protect);

router.post("/", validate(schemas.placeOrder), placeOrder);
router.get("/", getMyOrders);
router.get("/:id", getOrder);
router.post("/:id/cancel", cancelOrder);
router.get("/:id/track", trackOrder);

module.exports = router;
