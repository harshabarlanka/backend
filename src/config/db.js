const mongoose = require("mongoose");
const logger = require("../utils/logger");

let isConnected = false;

const connectDB = async () => {
  try {
    if (isConnected) {
      logger.info("Using existing MongoDB connection");
      return;
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Connection pool: 10 is fine for Render hobby; increase for production scaling
      maxPoolSize: 10,
      minPoolSize: 2,             // Keep 2 idle connections ready (reduces connection latency)
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      // Heartbeat: detect stale connections faster
      heartbeatFrequencyMS: 10000,
      // Write concern: journal for durability without blocking reads
      w: "majority",
      // Compress wire protocol traffic
      compressors: ["snappy", "zlib"],
    });

    isConnected = conn.connections[0].readyState === 1;

    logger.info(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on("disconnected", () => {
      logger.warn("MongoDB disconnected");
      isConnected = false;
    });

    mongoose.connection.on("reconnected", () => {
      logger.info("MongoDB reconnected");
      isConnected = true;
    });

  } catch (error) {
    logger.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

module.exports = connectDB;