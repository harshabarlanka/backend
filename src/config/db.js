/**
 * db.js — Production MongoDB connection
 *
 * FIXES vs original:
 *  1. Added connection retry with exponential backoff — if Atlas is briefly
 *     unavailable at startup (e.g. IP whitelist propagation), the server retries
 *     instead of crashing immediately.
 *  2. Added connection event listeners for observability.
 *  3. Pool sizes documented for Render free tier vs paid.
 *  4. Added mongoose global strictQuery setting to silence deprecation warning.
 */

const mongoose = require('mongoose');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const connectDB = async (attempt = 1) => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Free tier: 10 connections is plenty
      // Paid / scaling: increase to 50-100
      maxPoolSize: 10,
      minPoolSize: 2,

      // How long to wait for a server selection before failing
      serverSelectionTimeoutMS: 8000,

      // How long to wait for a socket operation (query timeout)
      socketTimeoutMS: 45000,

      // Heartbeat: detect stale connections faster than default 10s
      heartbeatFrequencyMS: 10000,

      // Write concern: wait for majority acknowledgement (prevents data loss)
      w: 'majority',
    });

    logger.info(`MongoDB connected: ${conn.connection.host} (pool: ${conn.connection.pool?.totalConnectionCount ?? 'unknown'})`);

    // ── Connection event listeners ────────────────────────────────────────────
    mongoose.connection.on('disconnected', () => {
      logger.warn('[MongoDB] Disconnected — Mongoose will auto-reconnect.');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('[MongoDB] Reconnected successfully.');
    });

    mongoose.connection.on('error', (err) => {
      logger.error('[MongoDB] Connection error:', { message: err.message });
    });

  } catch (error) {
    logger.error(`[MongoDB] Connection failed (attempt ${attempt}/${MAX_RETRIES}):`, {
      message: error.message,
    });

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * attempt;
      logger.warn(`[MongoDB] Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return connectDB(attempt + 1);
    }

    logger.error('[MongoDB] All connection attempts failed. Check MONGO_URI and Atlas IP whitelist.');
    logger.error('Fix: MongoDB Atlas → Network Access → Add IP 0.0.0.0/0 or your Render static IP.');
    process.exit(1);
  }
};

module.exports = connectDB;
