/**
 * Standardised API response wrapper.
 * All controllers should use this for consistent response shape.
 */
class ApiResponse {
  constructor(statusCode, message, data = null, meta = null) {
    this.success = statusCode >= 200 && statusCode < 400;
    this.statusCode = statusCode;
    this.message = message;
    if (data !== null) this.data = data;
    if (meta !== null) this.meta = meta; // pagination, counts, etc.
  }
}

const sendResponse = (res, statusCode, message, data = null, meta = null) => {
  const response = new ApiResponse(statusCode, message, data, meta);
  return res.status(statusCode).json(response);
};

module.exports = { ApiResponse, sendResponse };
