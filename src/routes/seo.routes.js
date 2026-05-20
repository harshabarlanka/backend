/**
 * seo.routes.js — Production-hardened SEO routes
 *
 * FIXES:
 *  1. POST /indexnow now requires admin auth — was completely unauthenticated.
 *     Anyone could spam arbitrary URLs to IndexNow under our key.
 *  2. Blog posts are now included in /sitemap.xml — they were missing entirely
 *     from the live sitemap while appearing in the static generate-sitemap.mjs.
 *  3. /sitemap-products.xml preserved with image sitemaps for Google Images.
 *  4. sitemap-index.xml now references both sitemaps.
 *
 * DEPLOY NOTE: When you add a new blog post to blogData.js, also add its slug
 * to the BLOG_POSTS array below. This is intentional — the sitemap should only
 * include published posts, not drafts.
 */

const express = require('express');
const router = express.Router();
const Product = require('../models/Product.model');
const catchAsync = require('../utils/catchAsync');
const { protect } = require('../middleware/auth.middleware');
const { restrictTo } = require('../middleware/admin.middleware');
const logger = require('../utils/logger');

const SITE_URL = process.env.CLIENT_URL || 'https://naidugariruchulu.vercel.app';
const BASE = SITE_URL.replace(/\/$/, '');

// ─── Blog posts for sitemap ───────────────────────────────────────────────────
// Keep in sync with pickle-frontend/src/data/blogData.js
// Add new posts here when published (status: 'published' only)
const BLOG_POSTS = [
  { slug: 'best-andhra-pickles-online-india',          updatedAt: '2025-05-01', priority: '0.8' },
  { slug: 'traditional-andhra-chicken-pickle-recipe',  updatedAt: '2025-04-15', priority: '0.8' },
  { slug: 'why-gongura-pickle-is-famous',              updatedAt: '2025-04-20', priority: '0.7' },
  { slug: 'how-homemade-avakaya-is-prepared',          updatedAt: '2025-05-01', priority: '0.7' },
  { slug: 'best-non-veg-pickles-andhra-pradesh',       updatedAt: '2025-05-01', priority: '0.7' },
];

// ─── Static pages ─────────────────────────────────────────────────────────────
const STATIC_PAGES = [
  { path: '/',                              priority: '1.0', changefreq: 'daily' },
  { path: '/products',                      priority: '0.9', changefreq: 'daily' },
  { path: '/combos',                        priority: '0.8', changefreq: 'weekly' },
  { path: '/blog',                          priority: '0.8', changefreq: 'weekly' },
  { path: '/products?category=veg-pickles',     priority: '0.8', changefreq: 'weekly' },
  { path: '/products?category=non-veg-pickles', priority: '0.8', changefreq: 'weekly' },
  { path: '/products?category=sweets',      priority: '0.7', changefreq: 'weekly' },
  { path: '/products?category=snacks',      priority: '0.7', changefreq: 'weekly' },
  { path: '/products?category=podis',       priority: '0.7', changefreq: 'weekly' },
  { path: '/faq',                           priority: '0.6', changefreq: 'monthly' },
  { path: '/contact',                       priority: '0.5', changefreq: 'monthly' },
  { path: '/shipping-policy',               priority: '0.4', changefreq: 'monthly' },
  { path: '/return-policy',                 priority: '0.4', changefreq: 'monthly' },
  { path: '/privacy-policy',               priority: '0.3', changefreq: 'yearly' },
  { path: '/terms',                         priority: '0.3', changefreq: 'yearly' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toISODate(date) {
  return date
    ? new Date(date).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

// ─── GET /robots.txt ──────────────────────────────────────────────────────────
router.get('/robots.txt', (req, res) => {
  const robotsTxt = [
    '# robots.txt — Naidu Gari Ruchulu',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    '# Block admin and private routes',
    'Disallow: /admin',
    'Disallow: /admin/',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /forgot-password',
    'Disallow: /reset-password',
    'Disallow: /checkout',
    'Disallow: /orders',
    'Disallow: /orders/',
    'Disallow: /profile',
    'Disallow: /account',
    'Disallow: /cart',
    '',
    '# Block API routes',
    'Disallow: /api/',
    '',
    '# Allow important assets',
    'Allow: /og-default.webp',
    'Allow: /logo.webp',
    'Allow: /favicon.ico',
    'Allow: /apple-touch-icon.png',
    'Allow: /site.webmanifest',
    '',
    `Sitemap: ${BASE}/sitemap.xml`,
    `Sitemap: ${BASE}/sitemap-products.xml`,
    `Sitemap: ${BASE}/sitemap-index.xml`,
  ].join('\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(robotsTxt);
});

// ─── GET /sitemap.xml — static + blog + products ──────────────────────────────
router.get(
  '/sitemap.xml',
  catchAsync(async (req, res) => {
    const today = toISODate(new Date());

    const products = await Product.find({ isActive: true })
      .select('slug updatedAt')
      .lean();

    const staticEntries = STATIC_PAGES.map(({ path, priority, changefreq }) =>
      urlEntry(`${BASE}${path}`, today, changefreq, priority),
    );

    const blogEntries = BLOG_POSTS.map((p) =>
      urlEntry(`${BASE}/blog/${p.slug}`, p.updatedAt, 'monthly', p.priority),
    );

    const productEntries = products
      .filter((p) => p.slug)
      .map((p) =>
        urlEntry(`${BASE}/product/${p.slug}`, toISODate(p.updatedAt), 'weekly', '0.9'),
      );

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<urlset`,
      `  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`,
      `  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`,
      '',
      '  <!-- ═══ STATIC PAGES ═══ -->',
      ...staticEntries,
      '',
      '  <!-- ═══ BLOG POSTS ═══ -->',
      ...blogEntries,
      '',
      '  <!-- ═══ PRODUCT PAGES ═══ -->',
      ...productEntries,
      '',
      '</urlset>',
    ].join('\n');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  }),
);

// ─── GET /sitemap-products.xml — product-only sitemap with image data ─────────
router.get(
  '/sitemap-products.xml',
  catchAsync(async (req, res) => {
    const products = await Product.find({ isActive: true })
      .select('slug updatedAt name images category')
      .lean();

    const productEntries = products
      .filter((p) => p.slug)
      .map((p) => {
        const imageTag = p.images?.[0]
          ? `\n    <image:image>\n      <image:loc>${xmlEscape(p.images[0])}</image:loc>\n      <image:title>${xmlEscape(p.name)}</image:title>\n    </image:image>`
          : '';
        return `  <url>\n    <loc>${xmlEscape(`${BASE}/product/${p.slug}`)}</loc>\n    <lastmod>${toISODate(p.updatedAt)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>${imageTag}\n  </url>`;
      });

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`,
      `  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`,
      ...productEntries,
      `</urlset>`,
    ].join('\n');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  }),
);

// ─── GET /sitemap-index.xml ────────────────────────────────────────────────────
router.get('/sitemap-index.xml', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>${BASE}/sitemap.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n  <sitemap>\n    <loc>${BASE}/sitemap-products.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n</sitemapindex>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(xml);
});

// ─── IndexNow key file (public — needed for domain verification) ───────────────
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || '';

if (INDEXNOW_KEY) {
  router.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(INDEXNOW_KEY);
  });
}

// ─── POST /indexnow — FIXED: now requires admin auth ─────────────────────────
// Was unauthenticated — anyone could spam IndexNow under our key.
router.post(
  '/indexnow',
  protect,
  restrictTo('admin'),
  catchAsync(async (req, res) => {
    if (!INDEXNOW_KEY) {
      return res.status(503).json({ success: false, message: 'IndexNow not configured.' });
    }

    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ success: false, message: 'urls array required.' });
    }

    const payload = {
      host: new URL(BASE).hostname,
      key: INDEXNOW_KEY,
      urlList: urls.map((u) => (u.startsWith('http') ? u : `${BASE}${u}`)),
    };

    fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => logger.warn(`[IndexNow] Submission failed: ${err.message}`));

    res.json({ success: true, submitted: payload.urlList.length });
  }),
);

module.exports = router;
