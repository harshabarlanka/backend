const express = require('express');
const router = express.Router();
const {
  getCombos,
  getComboBySlug,
} = require('../controllers/combo.controller');

// Public
router.get('/', getCombos);
router.get('/:slug', getComboBySlug);

module.exports = router;
