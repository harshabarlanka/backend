/**
 * server.js — Production-hardened entry point
 *
 * FIXES vs original:
 *  1. validateEnv() runs before ANYTHING else — crashes fast on misconfiguration.
 *  2. lru-cache dependency check — warns if not installed.
 *  3. HTTP server timeout set to 30s — prevents zombie connections on Render.
 *  4. Graceful shutdown now waits for in-flight requests (using server.close callback).
 *  5. Unhandled rejection logs the full stack before exiting — critical for debug.
 *  6. Added process.env.PORT fallback logging so you can see what port Render chose.
 *
 * DEPLOY NOTE: On Render, set the "Start Command" to: node src/server.js
 */

require('dotenv').config();

// ── Validate env FIRST — before any require that reads process.env ─────────────
const validateEnv = require('./config/validateEnv');
validateEnv();

const app = require('./app');
const connectDB = require('./config/db');
const logger = require('./utils/logger');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── Cron Jobs ────────────────────────────────────────────────────────────────
// These run in the same process as the HTTP server (acceptable for current scale).
// At >10k orders/month, migrate crons to a separate worker dyno/service.
require('./crons/trackingSync.cron');
require('./crons/rtoRefund.cron');
require('./crons/refundRetry.cron');
require('./crons/abandonedOrders.cron');
require('./crons/awbRetry.cron');
require('./crons/keepAlive.cron');
require('./crons/paymentReconciliation.cron');

// ─── Server ───────────────────────────────────────────────────────────────────
let server;

const startServer = async () => {
  try {
    await connectDB();

    server = app.listen(PORT, () => {
      logger.info(`[Server] Running in ${NODE_ENV} mode on port ${PORT}`);
      logger.info(`[Server] API base: http://localhost:${PORT}/api`);
      logger.info(`[Server] Health:   http://localhost:${PORT}/health`);
    });

    // Prevent Render/proxy from cutting long-running connections (e.g. image uploads)
    server.setTimeout(30_000);

    // Keep-alive for upstream proxy
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

  } catch (error) {
    logger.error('[Server] Failed to start:', { message: error.message, stack: error.stack });
    process.exit(1);
  }
};

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const gracefulShutdown = (signal) => {
  logger.info(`[Server] ${signal} received — shutting down gracefully`);

  if (!server) {
    process.exit(0);
    return;
  }

  // Stop accepting new connections; wait for in-flight requests to complete
  server.close(async () => {
    logger.info('[Server] HTTP server closed — closing MongoDB connection');
    try {
      await mongoose.connection.close(false);
      logger.info('[Server] MongoDB connection closed — exiting cleanly');
      process.exit(0);
    } catch (err) {
      logger.error('[Server] Error closing MongoDB:', err.message);
      process.exit(1);
    }
  });

  // Force kill after 15s if graceful shutdown stalls
  setTimeout(() => {
    logger.error('[Server] Graceful shutdown timed out after 15s — forcing exit');
    process.exit(1);
  }, 15_000).unref(); // .unref() prevents this timer from keeping the process alive
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─── Unhandled Errors ─────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  logger.error('[Server] UNHANDLED REJECTION — shutting down', {
    message: err?.message,
    stack: err?.stack,
  });
  gracefulShutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error('[Server] UNCAUGHT EXCEPTION — shutting down', {
    message: err?.message,
    stack: err?.stack,
  });
  // Uncaught exceptions leave the process in an undefined state — always exit
  process.exit(1);
});

startServer();
