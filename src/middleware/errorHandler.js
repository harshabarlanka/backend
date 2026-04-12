const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

/**
 * Transforms known Mongoose / JWT / Razorpay errors into ApiErrors,
 * then sends a consistent JSON error response.
 *
 * Must be registered as the LAST middleware in app.js.
 */

// ─── Error Transformers ───────────────────────────────────────────────────────

const handleCastError = (err) =>
  new ApiError(400, `Invalid ${err.path}: ${err.value}`);

const handleDuplicateKeyError = (err) => {
  const field = Object.keys(err.keyValue)[0];
  const value = err.keyValue[field];
  return new ApiError(409, `"${value}" is already registered for ${field}. Please use a different value.`);
};

const handleValidationError = (err) => {
  const messages = Object.values(err.errors).map((e) => e.message);
  return new ApiError(422, 'Validation failed', messages);
};

const handleJWTError = () =>
  new ApiError(401, 'Invalid token. Please log in again.');

const handleJWTExpiredError = () =>
  new ApiError(401, 'Your session has expired. Please log in again.');

const handleMulterError = (err) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return new ApiError(400, 'File too large. Maximum size per image is 5 MB.');
  if (err.code === 'LIMIT_FILE_COUNT')
    return new ApiError(400, 'Too many files. Maximum 5 images per upload.');
  if (err.code === 'LIMIT_UNEXPECTED_FILE')
    return new ApiError(400, 'Unexpected field. Use the "images" field for uploads.');
  return new ApiError(400, err.message || 'File upload error.');
};

// ─── Response Senders ────────────────────────────────────────────────────────

const sendDevError = (err, res) => {
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
    errors: err.errors || [],
    stack: err.stack,
  });
};

const sendProdError = (err, res) => {
  // Operational / known errors — safe to expose to client
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      errors: err.errors || [],
    });
  }

  // Programming or unknown errors — don't leak details
  logger.error('NON-OPERATIONAL ERROR:', err);
  return res.status(500).json({
    success: false,
    message: 'Something went wrong. Please try again later.',
    errors: [],
  });
};

// ─── Main Error Handler ───────────────────────────────────────────────────────

const errorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;

  logger.error(`${err.statusCode} - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

  if (process.env.NODE_ENV === 'development') {
    return sendDevError(err, res);
  }

  // Transform known error types in production
  let error = { ...err, message: err.message, stack: err.stack };

  if (err.name === 'CastError') error = handleCastError(err);
  if (err.code === 11000) error = handleDuplicateKeyError(err);
  if (err.name === 'ValidationError') error = handleValidationError(err);
  if (err.name === 'JsonWebTokenError') error = handleJWTError();
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();
  if (err.name === 'MulterError') error = handleMulterError(err);

  sendProdError(error, res);
};

module.exports = errorHandler;
