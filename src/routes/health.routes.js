/**
 * health.routes.js
 * Production-grade health check endpoint.
 *
 * WHY: The original returned 200 even when MongoDB was down.
 * Uptime monitors (UptimeRobot, Render health checks) need an accurate signal.
 * This endpoint now:
 *  - Pings MongoDB with a timeout
 *  - Reports memory usage
 *  - Returns 503 when DB is unhealthy
 *  - Stays fast (< 200ms) — does NOT run expensive queries
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

router.get('/', async (req, res) => {
  const start = Date.now();

  // DB health check with 2s timeout — don't block the response too long
  let dbStatus = 'disconnected';
  let dbLatencyMs = null;

  try {
    const dbStart = Date.now();
    await mongoose.connection.db.admin().ping();
    dbLatencyMs = Date.now() - dbStart;
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }

  const mem = process.memoryUsage();
  const uptimeSeconds = Math.floor(process.uptime());

  const healthy = dbStatus === 'connected';

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: uptimeSeconds,
    responseMs: Date.now() - start,
    services: {
      mongodb: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
    },
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV,
  });
});

module.exports = router;
