/**
 * keepAlive.cron.js
 *
 * Render's free tier spins down after ~15 min of inactivity.
 * Ping the health endpoint every 14 minutes to prevent cold starts.
 *
 * Only runs in production to avoid noisy dev logs.
 *
 * FIX: Removed hardcoded fallback URL "https://backend-gyml.onrender.com".
 * That URL was your internal Render hostname — committing it exposes your
 * infrastructure layout. BACKEND_URL must be set explicitly in Render's
 * environment variables. validateEnv() already warns if it is missing.
 */
const cron = require("node-cron");
const logger = require("../utils/logger");

if (process.env.NODE_ENV === "production") {
  const BACKEND_URL = process.env.BACKEND_URL;

  if (!BACKEND_URL) {
    // validateEnv already warns, but log here too so it's obvious at cron init time
    logger.warn(
      "[keepAlive] BACKEND_URL is not set — keep-alive cron will not run. " +
        "Set BACKEND_URL in Render env vars to prevent cold starts.",
    );
  } else {
    cron.schedule("*/14 * * * *", async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/health`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          logger.warn(`[keepAlive] Ping failed: HTTP ${res.status}`);
        }
      } catch (err) {
        logger.warn("[keepAlive] Ping error:", err.message);
      }
    });

    logger.info(
      `[keepAlive] Cron started — pinging ${BACKEND_URL}/health every 14 min`,
    );
  }
}
