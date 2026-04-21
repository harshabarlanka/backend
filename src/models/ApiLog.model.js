const mongoose = require('mongoose');

const apiLogSchema = new mongoose.Schema({
  service: {
    type: String,
    enum: ['razorpay', 'shiprocket'],
    required: true,
  },
  endpoint: {
    type: String,
    default: '',
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
  },
  error: {
    type: String,
    required: true,
  },
  payload: {
    type: Object,
    default: null,
  },
  resolved: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: '30d', // auto-delete after 30 days
  },
});

const ApiLog = mongoose.model('ApiLog', apiLogSchema);

module.exports = ApiLog;