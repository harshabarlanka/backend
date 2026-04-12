// In-memory token cache — NimbusPost token is valid for ~3 hours
let tokenCache = {
  token: null,
  expiresAt: null,
};

const BASE_URL = 'https://ship.nimbuspost.com/api';

/**
 * Fetches a fresh NimbusPost auth token.
 * Token is cached to avoid repeated logins.
 */
const getNimbusPostToken = async () => {
  const now = Date.now();

  // Return cached token if still valid (with 5-min buffer)
  if (tokenCache.token && tokenCache.expiresAt && now < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  const response = await fetch(`${BASE_URL}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.NIMBUSPOST_EMAIL,
      password: process.env.NIMBUSPOST_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`NimbusPost auth failed: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.status || !data.data) {
    throw new Error(`NimbusPost auth failed: ${data.message || 'Invalid credentials'}`);
  }

  tokenCache.token = data.data;
  // Cache for 2.5 hours (conservative)
  tokenCache.expiresAt = now + 2.5 * 60 * 60 * 1000;

  return tokenCache.token;
};

const getNimbusPostHeaders = async () => {
  const token = await getNimbusPostToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
};

module.exports = { getNimbusPostToken, getNimbusPostHeaders, BASE_URL };
