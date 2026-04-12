/**
 * Generates a unique, human-readable order number.
 * Format: PKL-YYYYMMDD-XXXXX  (PKL = Pickle, followed by date, then 5 random chars)
 */
const generateOrderNumber = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `PKL-${year}${month}${day}-${random}`;
};

module.exports = { generateOrderNumber };
