const express = require('express');
const router = express.Router();

const { uploadImages } = require('../controllers/upload.controller');
const { protect }      = require('../middleware/auth.middleware');
const { restrictTo }   = require('../middleware/admin.middleware');
const upload           = require('../middleware/upload.middleware');

/**
 * POST /api/upload
 * Admin-only. Accepts `images` field (multipart/form-data), max 5 files.
 */
router.post(
  '/',
  protect,
  restrictTo('admin'),
  upload.array('images', 5),
  uploadImages
);

module.exports = router;
