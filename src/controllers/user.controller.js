const User = require('../models/User.model');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');

// ─── Update Profile ───────────────────────────────────────────────────────────

const updateProfile = catchAsync(async (req, res) => {
  const { name, phone } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { name, phone } },
    { new: true, runValidators: true }
  );

  return sendResponse(res, 200, 'Profile updated successfully.', {
    user: user.toPublicJSON(),
  });
});

// ─── Change Password ──────────────────────────────────────────────────────────

const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+passwordHash');

  if (!(await user.comparePassword(currentPassword))) {
    throw new ApiError(401, 'Current password is incorrect.');
  }

  if (currentPassword === newPassword) {
    throw new ApiError(400, 'New password must be different from your current password.');
  }

  user.passwordHash = newPassword; // pre-save hook re-hashes
  user.refreshToken = null;        // force re-login on all devices
  await user.save();

  return sendResponse(res, 200, 'Password changed successfully. Please log in again.');
});

// ─── Add Address ──────────────────────────────────────────────────────────────

const addAddress = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (user.addresses.length >= 5) {
    throw new ApiError(400, 'You can save a maximum of 5 addresses. Please delete one first.');
  }

  // If this is the first address or isDefault requested, clear other defaults
  if (req.body.isDefault || user.addresses.length === 0) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
    });
    req.body.isDefault = true;
  }

  user.addresses.push(req.body);
  await user.save();

  return sendResponse(res, 201, 'Address added successfully.', {
    addresses: user.addresses,
  });
});

// ─── Update Address ───────────────────────────────────────────────────────────

const updateAddress = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);

  const address = user.addresses.id(req.params.addressId);
  if (!address) throw new ApiError(404, 'Address not found.');

  // If setting as default, clear others
  if (req.body.isDefault) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
    });
  }

  Object.assign(address, req.body);
  await user.save();

  return sendResponse(res, 200, 'Address updated successfully.', {
    addresses: user.addresses,
  });
});

// ─── Delete Address ───────────────────────────────────────────────────────────

const deleteAddress = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);

  const address = user.addresses.id(req.params.addressId);
  if (!address) throw new ApiError(404, 'Address not found.');

  address.deleteOne();
  await user.save();

  return sendResponse(res, 200, 'Address deleted successfully.', {
    addresses: user.addresses,
  });
});

module.exports = {
  updateProfile,
  changePassword,
  addAddress,
  updateAddress,
  deleteAddress,
};
