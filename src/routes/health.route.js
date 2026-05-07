const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();

    res.status(200).json({
      success: true,
      message: "Server is awake",
      mongodb: "connected",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      mongodb: "disconnected",
    });
  }
});

module.exports = router;