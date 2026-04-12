const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

/**
 * Verifies the Bearer token in the Authorization header.
 * Attaches the user document to req.user.
 */
const protect = catchAsync(async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    throw new ApiError(401, 'You are not logged in. Please log in to get access.');
  }

  // Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
    throw new ApiError(401, 'Invalid token. Please log in again.');
  }

  // Check if user still exists and is active
  const user = await User.findById(decoded.id).select('+refreshToken');
  if (!user) {
    throw new ApiError(401, 'The user belonging to this token no longer exists.');
  }

  if (!user.isActive) {
    throw new ApiError(401, 'Your account has been deactivated. Please contact support.');
  }

  req.user = user;
  next();
});

module.exports = { protect };
