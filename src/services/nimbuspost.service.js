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

// ─── Create NimbusPost B2B Shipment ──────────────────────────────────────────

const createNimbusPostOrder = async (order, user) => {
  try {
    // 🔥 DEV MODE (NO WALLET / NO KYC NEEDED)
    if (process.env.DEV_MODE === 'true') {
      logger.warn('⚠️ DEV MODE: Using fake NimbusPost shipment');

      return {
        nimbuspostOrderId: `DEV-${order.orderNumber}`,
        nimbuspostShipmentId: `DEV-SHIP-${Date.now()}`,
        awbCode: 'TEST123456',
        courierName: 'Delhivery (Test)',
        labelUrl: null,
        manifestUrl: null,
      };
    }

    const addr = order.shippingAddress;

    const totalWeightGrams = order.items.reduce(
      (sum, i) => sum + i.quantity * 500,
      0
    );

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

    const payload = {
      order_id: order.orderNumber,
      payment_method: 'prepaid',
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

    const data = await npFetch('/shipmentcargo/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const result = data.data;

    logger.info(
      `NimbusPost shipment created: order_id=${result.order_id} | awb=${result.awb_number}`
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

// ─── Track Shipment ───────────────────────────────────────────────────────────

const trackShipment = async (awbCode) => {
  // 🔥 DEV MODE TRACKING
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

// ─── Other APIs unchanged ─────────────────────────────────────────────────────

const cancelNimbusPostOrder = async (awbCode) => {
  return await npFetch('/shipmentcargo/Cancel', {
    method: 'POST',
    body: JSON.stringify({ awb: awbCode }),
  });
};

const generateManifest = async (awbs) => {
  const data = await npFetch('/shipmentcargo/pickup', {
    method: 'POST',
    body: JSON.stringify({ awbs }),
  });
  return data.data;
};

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
  trackShipment,
  cancelNimbusPostOrder,
  generateManifest,
  getWalletBalance,
  getShippingRates,
};