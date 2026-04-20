/**
 * Shiprocket Authentication Config
 * ─────────────────────────────────
 * Manages Shiprocket JWT token with in-memory caching.
 * Shiprocket tokens are valid for 24 hours.
 */

const logger = require('../utils/logger');

let tokenCache = {
  token: null,
  expiresAt: null,
};

const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

/**
 * Fetches a fresh Shiprocket JWT token.
 * Token is cached to avoid repeated logins.
 */
const getShiprocketToken = async () => {
  const now = Date.now();

  // Return cached token if still valid (with 30-min buffer)
  if (tokenCache.token && tokenCache.expiresAt && now < tokenCache.expiresAt - 30 * 60 * 1000) {
    return tokenCache.token;
  }

  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Shiprocket auth failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.token) {
    throw new Error(`Shiprocket auth failed: ${data.message || 'No token returned'}`);
  }

  tokenCache.token = data.token;
  // Cache for 23 hours (Shiprocket token valid for 24h)
  tokenCache.expiresAt = now + 23 * 60 * 60 * 1000;

  logger.info('[Shiprocket] Token refreshed successfully');
  return tokenCache.token;
};

const getShiprocketHeaders = async () => {
  const token = await getShiprocketToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
};

/** Force-invalidate the cached token (call on 401 responses) */
const invalidateToken = () => {
  tokenCache.token = null;
  tokenCache.expiresAt = null;
};

module.exports = { getShiprocketToken, getShiprocketHeaders, invalidateToken, BASE_URL };
