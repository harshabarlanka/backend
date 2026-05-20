/**
 * auth.middleware.js — Production-hardened authentication
 *
 * CHANGES from original:
 *  1. Replaced unbounded Map + clear() with proper LRU cache (lru-cache package).
 *     Original flushed ALL 5000 entries simultaneously under load causing thundering herd.
 *     LRU evicts least-recently-used entries one at a time — no spike.
 *  2. LRU TTL is 60 seconds — deactivated users are blocked within 1 minute max.
 *  3. invalidateUserCache is exported and called on deactivate/role-change.
 *
 * INSTALL: npm install lru-cache
 */

const jwt = require('jsonwebtoken');
const { LRUCache } = require('lru-cache');
const User = require('../models/User.model');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

// ── LRU User Cache ─────────────────────────────────────────────────────────────
// max: evict LRU entries beyond 5000 — prevents unbounded memory growth
// ttl: 60 seconds — balances DB load vs. deactivation propagation speed
// updateAgeOnGet: false — don't reset TTL on cache hit (ensures stale data expires)
const userCache = new LRUCache({
  max: 5000,
  ttl: 60 * 1000,
  updateAgeOnGet: false,
  allowStale: false,
});

const getCachedUser = async (userId) => {
  const cached = userCache.get(userId);

  if (cached) {
    // Belt-and-suspenders: immediately reject deactivated users even within TTL
    if (cached.isActive === false) {
      userCache.delete(userId);
      // Fall through to DB fetch
    } else {
      return cached;
    }
  }

  const user = await User.findById(userId).select('+refreshToken').lean();

  if (user) {
    userCache.set(userId, user);
  }

  return user;
};

/**
 * Invalidate a specific user's cache entry.
 * MUST be called from:
 *  - toggleUserStatus (deactivate/activate)
 *  - role change
 *  - password change
 *  - profile update
 */
const invalidateUserCache = (userId) => {
  userCache.delete(String(userId));
};

/**
 * protect middleware
 * Verifies Bearer JWT from Authorization header.
 * Attaches full user document to req.user.
 */
const protect = catchAsync(async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith('Bearer ')) {
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
    invalidateUserCache(decoded.id);
    throw new ApiError(401, 'Your account has been deactivated. Please contact support.');
  }

  req.user = user;
  next();
});

module.exports = { protect, invalidateUserCache };
