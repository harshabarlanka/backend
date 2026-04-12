const express = require('express');
const router = express.Router();

const {
  updateProfile,
  changePassword,
  addAddress,
  updateAddress,
  deleteAddress,
} = require('../controllers/user.controller');

const { protect } = require('../middleware/auth.middleware');
const { validate, schemas } = require('../middleware/validate.middleware');

// All user routes require authentication
router.use(protect);

router.put('/profile', validate(schemas.updateProfile), updateProfile);
router.patch('/change-password', validate(schemas.changePassword), changePassword);

router.post('/address', validate(schemas.addAddress), addAddress);
router.put('/address/:addressId', validate(schemas.addAddress), updateAddress);
router.delete('/address/:addressId', deleteAddress);

module.exports = router;
