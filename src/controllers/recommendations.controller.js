const Product = require("../models/Product.model");
const { sendResponse } = require("../utils/ApiResponse");
const catchAsync = require("../utils/catchAsync");

/**
 * Distribution targets:
 *   Pickles:   2 veg-pickles + 2 non-veg-pickles
 *   Sweets:    2
 *   Podis:     2
 *   Snacks:    1
 *   Total:     9
 */
const DISTRIBUTION = [
  { category: "veg-pickles", count: 2 },
  { category: "non-veg-pickles", count: 2 },
  { category: "sweets", count: 2 },
  { category: "podis", count: 2 },
  { category: "snacks", count: 1 },
];

const TOTAL_LIMIT = 9;

const getRecommendations = catchAsync(async (req, res) => {
  // excludeIds: comma-separated list of product IDs to exclude
  const { excludeIds = "" } = req.query;

  const excludeList = excludeIds
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  // Fetch all active products sorted by rating desc, numReviews desc
  // We fetch all and slice to avoid N+1 queries per category
  const allProducts = await Product.find({ isActive: true })
    .sort({ "ratings.average": -1, "ratings.count": -1 })
    .select("_id name slug category images variants ratings isVeg")
    .lean();

  // Build exclusion set
  const excludeSet = new Set(excludeList.map(String));

  // Filter out excluded products
  const eligible = allProducts.filter((p) => !excludeSet.has(String(p._id)));

  const picked = new Set();
  const result = [];

  // ── Phase 1: fill each category slot ─────────────────────────────────────────
  for (const { category, count } of DISTRIBUTION) {
    const pool = eligible.filter(
      (p) => p.category === category && !picked.has(String(p._id))
    );

    const take = pool.slice(0, count);
    for (const p of take) {
      picked.add(String(p._id));
      result.push(p);
    }

    // ── Fallback A: not enough in category – fill from same category again ──
    if (take.length < count) {
      // Already took all available from this category; nothing more to add
      // Fallback B handled below
    }
  }

  // ── Phase 2 (Fallback B): fill remaining slots with top-rated products ────────
  if (result.length < TOTAL_LIMIT) {
    const remaining = TOTAL_LIMIT - result.length;
    const fallbackPool = eligible.filter((p) => !picked.has(String(p._id)));
    const fallback = fallbackPool.slice(0, remaining);
    for (const p of fallback) {
      picked.add(String(p._id));
      result.push(p);
    }
  }

  // ── Deduplicate (safety net) ──────────────────────────────────────────────────
  const seen = new Set();
  const unique = result.filter((p) => {
    const key = String(p._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Add minPrice virtual ──────────────────────────────────────────────────────
  const products = unique.slice(0, TOTAL_LIMIT).map((p) => ({
    ...p,
    minPrice: p.variants?.length
      ? Math.min(...p.variants.map((v) => v.price))
      : 0,
  }));

  return sendResponse(res, 200, "Recommendations fetched.", { products });
});

module.exports = { getRecommendations };
