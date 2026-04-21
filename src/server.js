require("dotenv").config();

const validateEnv = require("./config/validateEnv");
validateEnv();

const app = require("./app");
const connectDB = require("./config/db");
const logger = require("./utils/logger");
const mongoose = require("mongoose");
require("./crons/abandonedOrders.cron");
require("./crons/awbRetry.cron");

const PORT = process.env.PORT || 5000;

// ✅ IMPORTANT: define server in outer scope
let server;

const startServer = async () => {
  try {
    await connectDB();

    server = app.listen(PORT, () => {
      logger.info(
        `Server running in ${process.env.NODE_ENV} mode on port ${PORT}`,
      );
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

// ─── Graceful Shutdown ─────────────────────────────────────────────

const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);

  if (server) {
    server.close(async () => {
      await mongoose.connection.close();
      logger.info("MongoDB connection closed.");
      process.exit(0);
    });
  }

  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ─── Error Handlers ────────────────────────────────────────────────

process.on("unhandledRejection", (err) => {
  logger.error("UNHANDLED REJECTION! Shutting down...", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION! Shutting down...", err);
  process.exit(1);
});

// ─── Start Server ─────────────────────────────────────────────────

startServer();
