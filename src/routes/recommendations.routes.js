const express = require("express");
const router = express.Router();
const { getRecommendations } = require("../controllers/recommendations.controller");

// GET /api/recommendations?excludeIds=id1,id2
router.get("/", getRecommendations);

module.exports = router;
