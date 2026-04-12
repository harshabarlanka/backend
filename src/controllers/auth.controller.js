const User = require('../models/User.model');
const { createTokenPair, verifyRefreshToken, generatePasswordResetToken, hashToken } = require('../services/token.service');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../services/email.service');
const ApiError = require('../utils/ApiError');
const { sendResponse } = require('../utils/ApiResponse');
const catchAsync = require('../utils/catchAsync');

// ─── Register ─────────────────────────────────────────────────────────────────

const register = catchAsync(async (req, res) => {
  const { name, email, password, phone } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ApiError(409, 'An account with this email already exists.');
  }

  const user = await User.create({
    name,
    email,
    passwordHash: password, // pre-save hook hashes this
    phone,
  });

  const { accessToken, refreshToken } = createTokenPair(user._id, user.role);

  // Store refresh token
  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  // Fire-and-forget welcome email
  sendWelcomeEmail({ email: user.email, name: user.name });

  return sendResponse(res, 201, 'Account created successfully.', {
    user: user.toPublicJSON(),
    accessToken,
    refreshToken,
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────

const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;

  // Explicitly select passwordHash (excluded by default)
  const user = await User.findOne({ email }).select('+passwordHash +refreshToken');

  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Incorrect email or password.');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Your account has been deactivated. Please contact support.');
  }

  const { accessToken, refreshToken } = createTokenPair(user._id, user.role);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return sendResponse(res, 200, 'Logged in successfully.', {
    user: user.toPublicJSON(),
    accessToken,
    refreshToken,
  });
});

// ─── Refresh Access Token ─────────────────────────────────────────────────────

const refreshToken = catchAsync(async (req, res) => {
  const { refreshToken: token } = req.body;

  if (!token) {
    throw new ApiError(400, 'Refresh token is required.');
  }

  const decoded = verifyRefreshToken(token);

  const user = await User.findById(decoded.id).select('+refreshToken');
  if (!user || user.refreshToken !== token) {
    throw new ApiError(401, 'Invalid refresh token. Please log in again.');
  }

  const { accessToken, refreshToken: newRefreshToken } = createTokenPair(user._id, user.role);

  // Rotate refresh token
  user.refreshToken = newRefreshToken;
  await user.save({ validateBeforeSave: false });

  return sendResponse(res, 200, 'Token refreshed.', {
    accessToken,
    refreshToken: newRefreshToken,
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

const logout = catchAsync(async (req, res) => {
  // Invalidate refresh token in DB
  await User.findByIdAndUpdate(req.user._id, { refreshToken: null });

  return sendResponse(res, 200, 'Logged out successfully.');
});

// ─── Get Current User ─────────────────────────────────────────────────────────

const getMe = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  return sendResponse(res, 200, 'User fetched.', { user: user.toPublicJSON() });
});

// ─── Forgot Password ──────────────────────────────────────────────────────────

const forgotPassword = catchAsync(async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  // Always return 200 to avoid user enumeration
  if (!user) {
    return sendResponse(res, 200, 'If an account with this email exists, a reset link has been sent.');
  }

  const { rawToken, hashedToken, expiresAt } = generatePasswordResetToken();

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = expiresAt;
  await user.save({ validateBeforeSave: false });

  sendPasswordResetEmail({ email: user.email, name: user.name, resetToken: rawToken });

  return sendResponse(res, 200, 'If an account with this email exists, a reset link has been sent.');
});

// ─── Reset Password ───────────────────────────────────────────────────────────

const resetPassword = catchAsync(async (req, res) => {
  const { token, password } = req.body;

  const hashedToken = hashToken(token);

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  }).select('+passwordHash');

  if (!user) {
    throw new ApiError(400, 'Reset token is invalid or has expired.');
  }

  user.passwordHash = password; // pre-save hook will re-hash
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.refreshToken = undefined; // force re-login on all devices
  await user.save();

  return sendResponse(res, 200, 'Password reset successfully. Please log in with your new password.');
});

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  getMe,
  forgotPassword,
  resetPassword,
};
