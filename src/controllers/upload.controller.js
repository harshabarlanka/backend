const { sendResponse } = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

/**
 * POST /api/upload
 * Accepts up to 5 images under the `images` field.
 * Files are streamed directly to Cloudinary by multer-storage-cloudinary —
 * nothing is written to disk.
 * Returns: { images: ["cloudinary_url_1", "cloudinary_url_2", ...] }
 */
const uploadImages = catchAsync(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    throw new ApiError(400, 'No images provided');
  }

  const urls = req.files.map((file) => file.path); // Cloudinary secure URL

  return sendResponse(res, 200, 'Images uploaded successfully', { images: urls });
});

module.exports = { uploadImages };
