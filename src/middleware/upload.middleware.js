/**
 * upload.middleware.js — Production-hardened file upload
 *
 * FIX: Original used CloudinaryStorage which streams files directly to Cloudinary
 * without ever populating file.buffer. This meant magic-byte validation was
 * ALWAYS silently skipped. Any file (PHP, EXE, JS) could be uploaded by
 * renaming it to image.jpg.
 *
 * SOLUTION:
 *  1. Use multer.memoryStorage() — files land in RAM as Buffer
 *  2. Validate magic bytes from file.buffer using file-type
 *  3. Stream validated buffer to Cloudinary via upload_stream()
 *  4. This guarantees no file reaches Cloudinary before validation passes
 *
 * INSTALL: npm install file-type  (already in package.json)
 */

const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

// ─── Use memory storage — populates file.buffer for magic-byte check ──────────
const storage = multer.memoryStorage();

// ─── Multer instance ──────────────────────────────────────────────────────────
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB per file
    files: 5,                   // max 5 files per request
  },
  fileFilter: (_req, file, cb) => {
    // First layer: MIME type check (fast, but client-controlled)
    if (!file.mimetype.startsWith('image/')) {
      return cb(new ApiError(400, `File "${file.originalname}" is not an image.`), false);
    }
    cb(null, true);
  },
});

// ─── Allowed magic byte signatures ───────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * validateAndUploadImages
 * ─────────────────────────
 * Express middleware that:
 *  1. Validates magic bytes of every uploaded file (cannot be spoofed)
 *  2. Uploads each valid file to Cloudinary via stream
 *  3. Replaces req.files with Cloudinary result objects
 *
 * Must be used AFTER multer() processes the request.
 * Cloudinary result objects have: .secure_url, .public_id, .format, .width, .height
 */
const validateAndUploadImages = async (req, res, next) => {
  if (!req.files || req.files.length === 0) return next();

  let fileTypeFromBuffer;
  try {
    const mod = await import('file-type');
    fileTypeFromBuffer = mod.fileTypeFromBuffer;
  } catch {
    // file-type not installed — hard fail in production (don't silently bypass)
    logger.error('[Upload] file-type package not installed. Run: npm install file-type');
    return next(new ApiError(500, 'Upload service misconfigured. Contact support.'));
  }

  const uploadedFiles = [];

  for (const file of req.files) {
    // ── Magic byte check ────────────────────────────────────────────────────
    if (!file.buffer || file.buffer.length === 0) {
      return next(new ApiError(400, `File "${file.originalname}" has no content.`));
    }

    const detected = await fileTypeFromBuffer(file.buffer);

    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      logger.warn(
        `[Upload] Magic-byte rejection: "${file.originalname}" ` +
        `claimed="${file.mimetype}" detected="${detected?.mime || 'unknown'}"`,
      );
      return next(
        new ApiError(
          400,
          `File "${file.originalname}" is not a valid image. ` +
          `Detected: ${detected?.mime || 'unknown'}. Allowed: JPEG, PNG, WebP.`,
        ),
      );
    }

    // ── Stream to Cloudinary ────────────────────────────────────────────────
    try {
      const result = await streamToCloudinary(file.buffer, {
        folder: 'products',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        resource_type: 'image',
      });

      uploadedFiles.push({
        secure_url: result.secure_url,
        public_id: result.public_id,
        format: result.format,
        width: result.width,
        height: result.height,
        originalname: file.originalname,
      });
    } catch (err) {
      logger.error(`[Upload] Cloudinary upload failed for "${file.originalname}": ${err.message}`);
      return next(new ApiError(502, `Failed to upload "${file.originalname}". Please try again.`));
    }
  }

  // Replace req.files with Cloudinary results so controllers can use them
  req.cloudinaryFiles = uploadedFiles;
  next();
};

/**
 * Promisify cloudinary.uploader.upload_stream
 */
const streamToCloudinary = (buffer, options) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(buffer);
  });
};

module.exports = { upload, validateAndUploadImages };
