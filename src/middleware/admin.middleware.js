const ApiError = require('../utils/ApiError');

/**
 * Restricts route access to users with specific roles.
 * Must be used AFTER the protect middleware (req.user must exist).
 *
 * Usage:
 *   router.delete('/:id', protect, restrictTo('admin'), deleteProduct);
 *   router.patch('/status', protect, restrictTo('admin', 'manager'), updateStatus);
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'You must be logged in to access this resource.'));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        new ApiError(403, 'You do not have permission to perform this action.')
      );
    }

    next();
  };
};

module.exports = { restrictTo };
