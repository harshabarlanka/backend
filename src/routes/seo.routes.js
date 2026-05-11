/**
 * seo.routes.js
 * Serves robots.txt, sitemap.xml, and IndexNow key file.
 * Mount BEFORE any rate-limiter so crawlers can always access these.
 */

const express = require("express");
const router = express.Router();
const Product = require("../models/Product.model");
const catchAsync = require("../utils/catchAsync");

const SITE_URL = process.env.CLIENT_URL || "https://naidugariruchulu.com";
// Strip trailing slash for clean URL construction
const BASE = SITE_URL.replace(/\/$/, "");

// ─── Static pages with their SEO priority & changefreq ────────────────────────
const STATIC_PAGES = [
  { path: "/",                   priority: "1.0", changefreq: "daily" },
  { path: "/products",           priority: "0.9", changefreq: "daily" },
  { path: "/combos",             priority: "0.8", changefreq: "weekly" },
  { path: "/products?category=veg-pickles",     priority: "0.8", changefreq: "weekly" },
  { path: "/products?category=non-veg-pickles", priority: "0.8", changefreq: "weekly" },
  { path: "/products?category=sweets",          priority: "0.7", changefreq: "weekly" },
  { path: "/products?category=snacks",          priority: "0.7", changefreq: "weekly" },
  { path: "/products?category=podis",           priority: "0.7", changefreq: "weekly" },
  { path: "/faq",                priority: "0.6", changefreq: "monthly" },
  { path: "/contact",            priority: "0.5", changefreq: "monthly" },
  { path: "/shipping-policy",    priority: "0.4", changefreq: "monthly" },
  { path: "/return-policy",      priority: "0.4", changefreq: "monthly" },
  { path: "/privacy-policy",     priority: "0.3", changefreq: "yearly" },
  { path: "/terms",              priority: "0.3", changefreq: "yearly" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function xmlEscape(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toISODate(date) {
  return date ? new Date(date).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

// ─── GET /robots.txt ──────────────────────────────────────────────────────────
router.get("/robots.txt", (req, res) => {
  const robotsTxt = [
    "# robots.txt — Naidu Gari Ruchulu",
    "# Generated automatically",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    "# Block admin and private routes",
    "Disallow: /admin",
    "Disallow: /admin/",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /forgot-password",
    "Disallow: /reset-password",
    "Disallow: /checkout",
    "Disallow: /orders",
    "Disallow: /orders/",
    "Disallow: /profile",
    "Disallow: /account",
    "Disallow: /cart",
    "",
    "# Block API routes",
    "Disallow: /api/",
    "",
    "# Block utility / auth pages",
    "Disallow: /reset-password*",
    "Disallow: /forgot-password*",
    "",
    "# Allow important assets",
    "Allow: /og-default.jpg",
    "Allow: /logo.png",
    "Allow: /favicon.ico",
    "Allow: /apple-touch-icon.png",
    "Allow: /site.webmanifest",
    "",
    `# Sitemap`,
    `Sitemap: ${BASE}/sitemap.xml`,
    "",
    `# IndexNow`,
    `# https://www.indexnow.org/`,
  ].join("\n");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400"); // 24 hours
  res.send(robotsTxt);
});

// ─── GET /sitemap.xml ─────────────────────────────────────────────────────────
router.get("/sitemap.xml", catchAsync(async (req, res) => {
  const today = toISODate(new Date());

  // Fetch all active products (only slug + updatedAt needed)
  const products = await Product.find({ isActive: true })
    .select("slug updatedAt")
    .lean();

  // Static page entries
  const staticEntries = STATIC_PAGES.map(({ path, priority, changefreq }) =>
    urlEntry(`${BASE}${path}`, today, changefreq, priority)
  );

  // Product entries
  const productEntries = products
    .filter((p) => p.slug)
    .map((p) =>
      urlEntry(
        `${BASE}/product/${p.slug}`,
        toISODate(p.updatedAt),
        "weekly",
        "0.9"
      )
    );

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset`,
    `  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`,
    `  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`,
    "",
    "  <!-- ═══ STATIC PAGES ═══ -->",
    ...staticEntries,
    "",
    "  <!-- ═══ PRODUCT PAGES ═══ -->",
    ...productEntries,
    "",
    "</urlset>",
  ].join("\n");

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour
  res.send(xml);
}));

// ─── GET /sitemap-products.xml — product-only sitemap ─────────────────────────
router.get("/sitemap-products.xml", catchAsync(async (req, res) => {
  const products = await Product.find({ isActive: true })
    .select("slug updatedAt name images category")
    .lean();

  const productEntries = products
    .filter((p) => p.slug)
    .map((p) => {
      const imageTag = p.images?.[0]
        ? `\n    <image:image>\n      <image:loc>${xmlEscape(p.images[0])}</image:loc>\n      <image:title>${xmlEscape(p.name)}</image:title>\n    </image:image>`
        : "";
      return `  <url>
    <loc>${xmlEscape(`${BASE}/product/${p.slug}`)}</loc>
    <lastmod>${toISODate(p.updatedAt)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>${imageTag}
  </url>`;
    });

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`,
    `  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`,
    ...productEntries,
    `</urlset>`,
  ].join("\n");

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(xml);
}));

// ─── GET /sitemap-index.xml — sitemap index ────────────────────────────────────
router.get("/sitemap-index.xml", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${BASE}/sitemap.xml</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${BASE}/sitemap-products.xml</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
</sitemapindex>`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(xml);
});

// ─── IndexNow key file ─────────────────────────────────────────────────────────
// Replace INDEXNOW_KEY with your actual key from https://www.indexnow.org/
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || "YOUR_INDEXNOW_KEY_HERE";

router.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(INDEXNOW_KEY);
});

// POST /api/seo/indexnow — submit URLs to IndexNow on product create/update
router.post("/indexnow", catchAsync(async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ success: false, message: "urls array required" });
  }

  const payload = {
    host: new URL(BASE).hostname,
    key: INDEXNOW_KEY,
    urlList: urls.map((u) => (u.startsWith("http") ? u : `${BASE}${u}`)),
  };

  // Fire and forget — non-blocking
  fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  }).catch(() => {}); // silently ignore errors

  res.json({ success: true, submitted: payload.urlList.length });
}));

module.exports = router;
