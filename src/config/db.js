const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  const conn = await mongoose.connect(process.env.MONGO_URI, {
    // Mongoose 8+ handles these automatically, kept for clarity
  });

  logger.info(`MongoDB connected: ${conn.connection.host}`);

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected. Attempting to reconnect...');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });
};

module.exports = connectDB;
