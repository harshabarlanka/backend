const express = require('express');
const router = express.Router();
const {
  getCart,
  addToCart,
  addComboToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
} = require('../controllers/cart.controller');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

router.get('/', getCart);
router.post('/add', addToCart);
router.post('/add-combo', addComboToCart);
router.patch('/item/:itemId', updateCartItem);
router.delete('/item/:itemId', removeCartItem);
router.delete('/clear', clearCart);

module.exports = router;
