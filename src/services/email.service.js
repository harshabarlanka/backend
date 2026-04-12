const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// ─── Transporter ─────────────────────────────────────────────────────────────

const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
};

// ─── Base Send ────────────────────────────────────────────────────────────────

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"Pickle Store" <noreply@picklestore.com>',
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''), // fallback plain text
    });
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`Failed to send email to ${to}:`, err);
    // Don't throw — email failure should not break the main flow
  }
};

// ─── Email Templates ──────────────────────────────────────────────────────────

const baseTemplate = (content) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #333;">
    <div style="border-bottom: 3px solid #e67e22; padding-bottom: 16px; margin-bottom: 24px;">
      <h2 style="margin:0; color: #e67e22;">🫙 Pickle Store</h2>
    </div>
    ${content}
    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
      <p>© ${new Date().getFullYear()} Pickle Store. All rights reserved.</p>
      <p>If you didn't request this email, you can safely ignore it.</p>
    </div>
  </div>
`;

// ─── Specific Email Senders ───────────────────────────────────────────────────

/**
 * Welcome / email verification email after registration.
 */
const sendWelcomeEmail = async ({ email, name }) => {
  const html = baseTemplate(`
    <h3>Welcome, ${name}! 👋</h3>
    <p>Thank you for signing up with Pickle Store. Your account has been created successfully.</p>
    <p>Browse our handcrafted pickle collection and enjoy authentic flavours delivered to your door.</p>
    <a href="${process.env.CLIENT_URL}/products"
       style="display: inline-block; background: #e67e22; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 16px;">
      Shop Now
    </a>
  `);

  await sendEmail({ to: email, subject: 'Welcome to Pickle Store! 🫙', html });
};

/**
 * Password reset email with a one-time link.
 */
const sendPasswordResetEmail = async ({ email, name, resetToken }) => {
  const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;
  const html = baseTemplate(`
    <h3>Password Reset Request</h3>
    <p>Hi ${name},</p>
    <p>We received a request to reset your Pickle Store account password. Click the button below to reset it.</p>
    <a href="${resetUrl}"
       style="display: inline-block; background: #e67e22; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 16px;">
      Reset Password
    </a>
    <p style="margin-top: 16px; font-size: 13px; color: #666;">
      This link will expire in <strong>10 minutes</strong>.<br/>
      If you did not request a password reset, please ignore this email.
    </p>
  `);

  await sendEmail({ to: email, subject: 'Reset your Pickle Store password', html });
};

/**
 * Order confirmation email.
 */
const sendOrderConfirmationEmail = async ({ email, name, order }) => {
  const itemsHtml = order.items
    .map(
      (item) => `
      <tr>
        <td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${item.name} (${item.size})</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0; text-align:center;">${item.quantity}</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0; text-align:right;">₹${item.price * item.quantity}</td>
      </tr>
    `
    )
    .join('');

  const html = baseTemplate(`
    <h3>Order Confirmed! 🎉</h3>
    <p>Hi ${name}, your order has been placed successfully.</p>
    <p><strong>Order Number:</strong> ${order.orderNumber}</p>
    <p><strong>Payment Method:</strong> ${order.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Online Payment'}</p>
    <table style="width:100%; border-collapse: collapse; margin-top: 16px;">
      <thead>
        <tr style="background: #f9f9f9;">
          <th style="padding: 8px 0; text-align:left;">Item</th>
          <th style="padding: 8px 0; text-align:center;">Qty</th>
          <th style="padding: 8px 0; text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="padding: 8px 0; font-weight:bold;">Total</td>
          <td style="padding: 8px 0; text-align:right; font-weight:bold;">₹${order.total}</td>
        </tr>
      </tfoot>
    </table>
    <p style="margin-top: 16px;">We'll notify you once your order is shipped.</p>
    <a href="${process.env.CLIENT_URL}/orders/${order._id}"
       style="display: inline-block; background: #e67e22; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 8px;">
      View Order
    </a>
  `);

  await sendEmail({ to: email, subject: `Order Confirmed — ${order.orderNumber}`, html });
};

/**
 * Shipment dispatched email with tracking info.
 */
const sendShipmentEmail = async ({ email, name, order }) => {
  const html = baseTemplate(`
    <h3>Your order is on its way! 🚚</h3>
    <p>Hi ${name}, great news — your order <strong>${order.orderNumber}</strong> has been shipped.</p>
    ${order.courierName ? `<p><strong>Courier:</strong> ${order.courierName}</p>` : ''}
    ${order.awbCode ? `<p><strong>Tracking Number:</strong> ${order.awbCode}</p>` : ''}
    <a href="${process.env.CLIENT_URL}/orders/${order._id}/track"
       style="display: inline-block; background: #e67e22; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 16px;">
      Track Order
    </a>
  `);

  await sendEmail({ to: email, subject: `Shipped — ${order.orderNumber}`, html });
};

/**
 * Post-delivery review nudge.
 */
const sendReviewRequestEmail = async ({ email, name, order }) => {
  const html = baseTemplate(`
    <h3>How did you like your pickles? 🫙</h3>
    <p>Hi ${name}, your order <strong>${order.orderNumber}</strong> has been delivered. We'd love to hear your feedback!</p>
    <a href="${process.env.CLIENT_URL}/orders/${order._id}"
       style="display: inline-block; background: #e67e22; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 16px;">
      Leave a Review
    </a>
  `);

  await sendEmail({ to: email, subject: 'How was your Pickle Store order?', html });
};

module.exports = {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendOrderConfirmationEmail,
  sendShipmentEmail,
  sendReviewRequestEmail,
};
