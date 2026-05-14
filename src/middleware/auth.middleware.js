const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

// ── Short-lived user cache keyed by decoded JWT id ────────────────────────────
// Avoids a DB round-trip on every authenticated request.
// TTL matches JWT access token lifetime (typically 15 min).
const userCache = new Map();
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const getCachedUser = async (userId) => {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) return cached.user;

  const user = await User.findById(userId).select('+refreshToken').lean();
  if (user) userCache.set(userId, { user, ts: Date.now() });
  return user;
};

// Invalidate cache when user data changes (call from update/deactivate controllers)
const invalidateUserCache = (userId) => userCache.delete(String(userId));

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

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
    throw new ApiError(401, 'Invalid token. Please log in again.');
  }

  const user = await getCachedUser(decoded.id);
  if (!user) {
    throw new ApiError(401, 'The user belonging to this token no longer exists.');
  }
  if (!user.isActive) {
    throw new ApiError(401, 'Your account has been deactivated. Please contact support.');
  }

  req.user = user;
  next();
});

module.exports = { protect, invalidateUserCache };
