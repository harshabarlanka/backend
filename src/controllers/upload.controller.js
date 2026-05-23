const { sendResponse } = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

/**
 * POST /api/upload
 * Accepts up to 5 images under the `images` field.
 *
 * FIX: The previous version read `req.files.map(f => f.path)` — but
 * `validateAndUploadImages` middleware (which runs before this controller)
 * streams files to Cloudinary and stores results in `req.cloudinaryFiles`,
 * NOT back into `req.files`. The raw multer memoryStorage objects in
 * `req.files` have no `.path` property, so every upload returned
 * `[undefined, undefined, ...]` — causing blank image previews and
 * empty `form.images` on the frontend.
 *
 * CORRECT: read from `req.cloudinaryFiles` (set by validateAndUploadImages)
 * and map `.secure_url` for the URL array.
 *
 * Returns: { images: ["https://res.cloudinary.com/...", ...] }
 */
const uploadImages = catchAsync(async (req, res) => {
  // req.cloudinaryFiles is set by validateAndUploadImages middleware
  const cloudinaryFiles = req.cloudinaryFiles;

  if (!cloudinaryFiles || cloudinaryFiles.length === 0) {
    throw new ApiError(400, 'No images provided');
  }

  // Extract secure URLs from Cloudinary result objects
  const urls = cloudinaryFiles.map((file) => file.secure_url);

  return sendResponse(res, 200, 'Images uploaded successfully', { images: urls });
});

module.exports = { uploadImages };
