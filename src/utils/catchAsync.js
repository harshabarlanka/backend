/**
 * Wraps an async route handler and forwards any thrown errors to Express's
 * next(err) — eliminating repetitive try/catch in every controller.
 *
 * Usage:
 *   router.get('/route', catchAsync(async (req, res) => { ... }));
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = catchAsync;
