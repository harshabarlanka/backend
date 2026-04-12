const express = require('express');
const router = express.Router();

const {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
} = require('../controllers/cart.controller');

const { protect } = require('../middleware/auth.middleware');
const { validate, schemas } = require('../middleware/validate.middleware');

// All cart routes require authentication
router.use(protect);

router.get('/', getCart);
router.post('/add', validate(schemas.addToCart), addToCart);
router.patch('/item/:itemId', validate(schemas.updateCartItem), updateCartItem);
router.delete('/item/:itemId', removeCartItem);
router.delete('/clear', clearCart);

module.exports = router;
