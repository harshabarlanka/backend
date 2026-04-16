const { getNimbusPostHeaders, BASE_URL } = require('../config/nimbuspost');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

// ─── Helper: Authenticated Fetch ─────────────────────────────────────────────

const npFetch = async (endpoint, options = {}) => {
  const headers = await getNimbusPostHeaders();
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      502,
      `NimbusPost request failed with status ${response.status}: ${response.statusText}`
    );
  }

  if (!response.ok || data.status === false) {
    logger.error(`NimbusPost API error [${endpoint}]:`, data);
    throw new ApiError(
      502,
      data.message || `NimbusPost request failed: ${response.statusText}`
    );
  }

  return data;
};

// ─── ADDED: Map NimbusPost tracking statuses → internal order statuses ────────
//
// NimbusPost sends raw status strings in webhooks and tracking responses.
// This mapper translates them to our internal order status enum so the DB
// stays clean and frontend gets consistent values.
//
// Reference: NimbusPost B2B status documentation
const NIMBUS_STATUS_MAP = {
  // In-transit states
  'booked':              'confirmed',
  'pickup pending':      'confirmed',
  'pickup scheduled':    'confirmed',
  'pickup generated':    'confirmed',
  'out for pickup':      'confirmed',
  'picked up':           'shipped',
  'in transit':          'shipped',
  'dispatched':          'shipped',
  'reached at hub':      'shipped',
  'out for delivery':    'out_for_delivery',

  // Terminal states
  'delivered':           'delivered',
  'delivery attempted':  'out_for_delivery',

  // RTO states (Return to Origin)
  'rto initiated':       'rto',
  'rto in transit':      'rto',
  'rto delivered':       'rto',
  'return initiated':    'rto',

  // Cancelled
  'cancelled':           'cancelled',
  'shipment cancelled':  'cancelled',
  'lost':                'cancelled',
};

/**
 * ADDED: Maps a raw NimbusPost status string to our internal order status.
 * Falls back to null if no mapping is found (unknown statuses are logged but ignored).
 *
 * @param {string} nimbusStatus - Raw status string from NimbusPost
 * @returns {string|null} - Internal order status or null
 */
const mapNimbusStatusToInternal = (nimbusStatus) => {
  if (!nimbusStatus) return null;
  const normalized = nimbusStatus.toLowerCase().trim();
  return NIMBUS_STATUS_MAP[normalized] || null;
};

// ─── ADDED: Build NimbusPost shipment payload ─────────────────────────────────
//
// Extracted as a pure function so both prepaid and COD orders share
// the exact same payload builder — no duplication.

const buildShipmentPayload = (order, user) => {
  const addr = order.shippingAddress;

  const products = order.items.map((item) => ({
    product_name: `${item.name} (${item.size})`,
    product_hsn_code: '6109',
    product_lbh_unit: 'cm',
    no_of_box: String(item.quantity),
    product_tax_per: '0',
    product_price: String(item.price),
    product_weight_unit: 'gram',
    product_length: '30',
    product_breadth: '25',
    product_height: '5',
    product_weight: 500,
  }));

  return {
    order_id: order.orderNumber,
    // ADDED: payment_method is dynamic — COD orders get 'cod', prepaid get 'prepaid'
    payment_method: order.paymentMethod === 'cod' ? 'cod' : 'prepaid',
    // ADDED: For COD orders, include the collection amount NimbusPost needs
    ...(order.paymentMethod === 'cod' && { cod_amount: String(order.total) }),
    consignee_name: addr.fullName,
    consignee_company_name: addr.fullName,
    consignee_phone: addr.phone,
    consignee_email: user.email || '',
    consignee_gst_number: '',
    consignee_address: addr.addressLine1,
    consignee_pincode: Number(addr.pincode),
    consignee_city: addr.city,
    consignee_state: addr.state,
    no_of_invoices: 1,
    no_of_boxes: order.items.reduce((sum, i) => sum + i.quantity, 0),
    courier_id: Number(process.env.NIMBUSPOST_COURIER_ID || '244'),
    request_auto_pickup: 'yes',
    invoice: [
      {
        invoice_number: order.orderNumber,
        invoice_date: new Date(order.createdAt)
          .toLocaleDateString('en-GB')
          .replace(/\//g, '-'),
        invoice_value: String(order.subtotal),
        ebn_number: '',
        ebn_expiry_date: '',
      },
    ],
    pickup: {
      warehouse_name: process.env.NIMBUSPOST_WAREHOUSE_NAME || 'Primary',
      name: process.env.NIMBUSPOST_PICKUP_NAME || 'Naidu Gari Ruchulu',
      address: process.env.NIMBUSPOST_PICKUP_ADDRESS,
      address_2: '',
      city: process.env.NIMBUSPOST_PICKUP_CITY,
      state: process.env.NIMBUSPOST_PICKUP_STATE,
      pincode: Number(process.env.NIMBUSPOST_PICKUP_PINCODE),
      phone: Number(process.env.NIMBUSPOST_PICKUP_PHONE),
    },
    products,
  };
};

// ─── Create NimbusPost B2B Shipment ──────────────────────────────────────────
//
// CHANGED: Now accepts both COD and prepaid orders.
// Previously only sent payment_method: 'prepaid' — now dynamically
// sets it based on order.paymentMethod and includes cod_amount for COD.

const createNimbusPostOrder = async (order, user) => {
  try {
    // DEV MODE — no wallet / no KYC needed
    if (process.env.DEV_MODE === 'true') {
      logger.warn('⚠️  DEV MODE: Using fake NimbusPost shipment');

      return {
        nimbuspostOrderId: `DEV-${order.orderNumber}`,
        nimbuspostShipmentId: `DEV-SHIP-${Date.now()}`,
        awbCode: `TEST${Date.now()}`,
        courierName: 'Delhivery (Test)',
        labelUrl: null,
        manifestUrl: null,
      };
    }

    const payload = buildShipmentPayload(order, user);

    const data = await npFetch('/shipmentcargo/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const result = data.data;

    logger.info(
      `NimbusPost shipment created: order_id=${result.order_id} | awb=${result.awb_number} | payment=${payload.payment_method}`
    );

    return {
      nimbuspostOrderId: String(result.order_id),
      nimbuspostShipmentId: String(result.shipment_id),
      awbCode: String(result.awb_number),
      courierName: result.courier_name || 'NimbusPost Courier',
      labelUrl: result.label || null,
      manifestUrl: result.manifest || null,
    };
  } catch (error) {
    throw error;
  }
};

// ─── ADDED: Auto-create shipment and update order atomically ─────────────────
//
// Centralised helper called from order.controller (COD) and payment.controller
// (prepaid) immediately after an order is confirmed. This is the key function
// that automates the previously-manual NimbusPost step.
//
// Design decisions:
// - Does NOT throw on failure — logs the error and marks order with a note
//   so the admin can manually retry. A shipment failure must never block
//   order confirmation from the customer's perspective.
// - Idempotent — skips silently if awbCode is already set.
// - Marks shipmentAutoCreated: true so admin dashboard can distinguish.

const autoCreateShipment = async (order, user) => {
  // Guard: don't create duplicate shipments
  if (order.awbCode) {
    logger.warn(
      `autoCreateShipment: order ${order.orderNumber} already has AWB ${order.awbCode} — skipping`
    );
    return;
  }

  try {
    const {
      nimbuspostOrderId,
      nimbuspostShipmentId,
      awbCode,
      courierName,
    } = await createNimbusPostOrder(order, user);

    // Update order in-place (caller must save)
    order.shiprocketOrderId = nimbuspostOrderId;
    order.shiprocketShipmentId = nimbuspostShipmentId;
    order.awbCode = awbCode;
    order.courierName = courierName;
    order.trackingStatus = 'Booked';
    order.trackingUpdatedAt = new Date();
    order.shipmentAutoCreated = true;

    order.statusHistory.push({
      status: order.status,
      note: `Shipment auto-created via NimbusPost. AWB: ${awbCode}. Courier: ${courierName}.`,
    });

    logger.info(
      `[autoCreateShipment] AWB ${awbCode} assigned to order ${order.orderNumber}`
    );
  } catch (err) {
    // Log but don't re-throw — order is confirmed, shipment can be retried
    logger.error(
      `[autoCreateShipment] Failed for order ${order.orderNumber}: ${err.message}`
    );

    order.statusHistory.push({
      status: order.status,
      note: `⚠️ Auto-shipment creation failed: ${err.message}. Admin review required.`,
    });
  }
};

// ─── Track Shipment ───────────────────────────────────────────────────────────

const trackShipment = async (awbCode) => {
  // DEV MODE TRACKING
  if (process.env.DEV_MODE === 'true') {
    return {
      currentStatus: 'Shipped (Test)',
      deliveryDate: null,
      awbNumber: awbCode,
      shipmentTrackActivities: [
        {
          date: new Date(),
          activity: 'Shipment created (DEV MODE)',
          location: 'Test Warehouse',
        },
      ],
      shipmentTrack: [],
    };
  }

  const headers = await getNimbusPostHeaders();
  const url = `${BASE_URL}/shipmentcargo/track/${awbCode}`;

  const response = await fetch(url, { method: 'GET', headers });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(502, `NimbusPost tracking failed`);
  }

  if (!data.status) {
    throw new ApiError(502, data.message || 'NimbusPost tracking failed');
  }

  const shipment = data.data;

  return {
    currentStatus: shipment.status || 'Unknown',
    deliveryDate: shipment.edd || null,
    awbNumber: shipment.awb_number || awbCode,
    shipmentTrackActivities: shipment.history || [],
    shipmentTrack: shipment.history || [],
  };
};

// ─── Cancel NimbusPost Order ──────────────────────────────────────────────────

const cancelNimbusPostOrder = async (awbCode) => {
  return await npFetch('/shipmentcargo/Cancel', {
    method: 'POST',
    body: JSON.stringify({ awb: awbCode }),
  });
};

// ─── Generate Manifest ────────────────────────────────────────────────────────

const generateManifest = async (awbs) => {
  const data = await npFetch('/shipmentcargo/pickup', {
    method: 'POST',
    body: JSON.stringify({ awbs }),
  });
  return data.data;
};

// ─── Wallet Balance ───────────────────────────────────────────────────────────

const getWalletBalance = async () => {
  const headers = await getNimbusPostHeaders();
  const response = await fetch(`${BASE_URL}/shipmentcargo/wallet_balance`, {
    method: 'GET',
    headers,
  });

  const data = await response.json();
  if (!data.status) {
    throw new ApiError(502, data.message);
  }

  return data.data.available_limit;
};

// ─── Get Shipping Rates ───────────────────────────────────────────────────────

const getShippingRates = async ({ pickupPincode, deliveryPincode, weight, cod }) => {
  const data = await npFetch('/courier/b2b_serviceability', {
    method: 'POST',
    body: JSON.stringify({
      origin: String(pickupPincode),
      destination: String(deliveryPincode),
      payment_type: cod ? 'cod' : 'prepaid',
      details: [
        {
          qty: 1,
          weight: weight || 0.5,
          length: 30,
          breadth: 25,
          height: 5,
        },
      ],
      order_value: '1000',
    }),
  });

  return (data.data || []).map((c) => ({
    courierId: c.courier_id,
    courierName: c.name,
    rate: c.courier_charges,
  }));
};

module.exports = {
  createNimbusPostOrder,
  autoCreateShipment,         // ADDED
  mapNimbusStatusToInternal,  // ADDED
  trackShipment,
  cancelNimbusPostOrder,
  generateManifest,
  getWalletBalance,
  getShippingRates,
};
