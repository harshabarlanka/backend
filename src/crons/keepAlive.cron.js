/**
 * keepAlive.cron.js
 *
 * Render's free tier spins down after ~15 min of inactivity.
 * Ping the health endpoint every 14 minutes to prevent cold starts.
 *
 * Only runs in production to avoid noisy dev logs.
 */
const cron = require("node-cron");
const logger = require("../utils/logger");

if (process.env.NODE_ENV === "production") {
  const BACKEND_URL = process.env.BACKEND_URL || "https://backend-gyml.onrender.com";

  cron.schedule("*/14 * * * *", async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/health`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) logger.warn(`Keep-alive ping failed: ${res.status}`);
    } catch (err) {
      logger.warn("Keep-alive ping error:", err.message);
    }
  });

  logger.info("Keep-alive cron started (every 14 minutes)");
}
