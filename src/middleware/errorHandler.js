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

// ─── Observability hook ───────────────────────────────────────────────────────
// To enable Sentry error monitoring:
//   1. npm install @sentry/node
//   2. Add SENTRY_DSN to your Render environment variables
//   3. Uncomment the three lines below
//
// const Sentry = require('@sentry/node');
// Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
// const captureException = (err, req) => Sentry.captureException(err, { extra: { url: req.originalUrl, method: req.method } });
//
// When Sentry is not configured, this is a silent no-op:
const captureException = process.env.SENTRY_DSN
  ? (() => {
      try {
        // Only require Sentry if the DSN is set — avoids crash when package is not installed
        const Sentry = require('@sentry/node');
        Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
        return (err, req) =>
          Sentry.captureException(err, {
            extra: { url: req?.originalUrl, method: req?.method, ip: req?.ip },
          });
      } catch {
        logger.warn('[errorHandler] SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node');
        return () => {};
      }
    })()
  : () => {}; // no-op when SENTRY_DSN not configured

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

  // Report non-operational (unexpected) errors to the observability service.
  // Operational errors (4xx, known ApiErrors) are intentional control flow —
  // they are logged above but not forwarded to Sentry to avoid noise.
  if (!error.isOperational) {
    captureException(err, req);
  }

  sendProdError(error, res);
};

module.exports = errorHandler;
