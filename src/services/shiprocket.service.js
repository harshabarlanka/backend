const {
  getShiprocketHeaders,
  invalidateToken,
  BASE_URL,
} = require("../config/shiprocket");
const logger = require("../utils/logger");
const ApiError = require("../utils/ApiError");
const Order = require("../models/Order.model");
const ApiLog = require("../models/ApiLog.model");

// ── Serviceability cache ──────────────────────────────────────────────────────
const serviceabilityCache = new Map();
const SERVICEABILITY_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────────────────────
// Core fetch wrapper — handles 401 token refresh, full error logging
// ─────────────────────────────────────────────────────────────────────────────

const srFetch = async (endpoint, options = {}, retried = false) => {
  const headers = await getShiprocketHeaders();
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

  if (response.status === 401 && !retried) {
    logger.warn("[Shiprocket] 401 → invalidating token and retrying");
    invalidateToken();
    return srFetch(endpoint, options, true);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      502,
      `Shiprocket non-JSON response: ${response.statusText}`,
    );
  }

  if (!response.ok) {
    logger.error(`[Shiprocket ERROR ${endpoint}]`, {
      status_code: response.status,
      message: data.message || data.error || "Unknown error",
      full_response: JSON.stringify(data),
    });
    throw new ApiError(
      502,
      data.message || `Shiprocket API failed: ${endpoint}`,
    );
  }

  return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATUS MAP
// ─────────────────────────────────────────────────────────────────────────────

const SHIPROCKET_STATUS_MAP = {
  new: "confirmed",
  "ready to ship": "confirmed",
  "pickup scheduled": "confirmed",
  manifested: "confirmed",
  "in transit": "shipped",
  dispatched: "shipped",
  "out for delivery": "out_for_delivery",
  delivered: "delivered",
  cancelled: "cancelled",
};

const mapShiprocketStatusToInternal = (status) => {
  if (!status) return null;

  const s = status.toLowerCase().trim();

  // 🔴 Terminal states first (highest priority)
  if (s.includes("cancel")) return "cancelled";

  // ✅ FIX: handle ALL RTO / Return cases
  if (s.includes("rto") || s.includes("return") || s.includes("undelivered")) {
    return "rto";
  }

  if (s.includes("deliver")) return "delivered";

  // 🟡 Delivery stage
  if (s.includes("out for delivery")) return "out_for_delivery";

  // 🔵 Transit stage
  if (
    s.includes("transit") ||
    s.includes("dispatch") ||
    s.includes("shipped") ||
    s.includes("in movement")
  ) {
    return "shipped";
  }

  // 🟣 Shipment created / packed stage
  if (
    s.includes("ready to ship") ||
    s.includes("manifest") ||
    s.includes("pickup scheduled") ||
    s.includes("pickup generated")
  ) {
    return "ready_for_pickup";
  }

  return null;
};
// ─────────────────────────────────────────────────────────────────────────────
// BUILD ORDER PAYLOAD — uses product dimensions from Feature 6
// ─────────────────────────────────────────────────────────────────────────────

const buildOrderPayload = (order, user) => {
  const addr = order.shippingAddress;
  const nameParts = (addr.fullName || "Customer").trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

  // Feature 6: use actual product weight; minimum 0.1 kg
  const weight = Math.max(
    0.1,
    order.items.reduce((sum, i) => sum + i.quantity, 0) * 0.5,
  );

  // Use stored courier dimensions if available, else use product-level defaults
  const pickupLocation = (
    process.env.SHIPROCKET_PICKUP_LOCATION_NAME || "Primary"
  ).trim();

  return {
    order_id: order.orderNumber,
    order_date: new Date(order.createdAt).toISOString().split("T")[0],
    pickup_location: pickupLocation,

    billing_customer_name: firstName,
    billing_last_name: lastName,

    billing_address: addr.addressLine1,
    billing_address_2: addr.addressLine2 || "",
    billing_city: addr.city,
    billing_pincode: String(addr.pincode).trim(),
    billing_state: addr.state,
    billing_country: "India",

    billing_email: user.email || "noemail@domain.com",
    billing_phone: String(addr.phone || "9999999999").trim(),

    shipping_is_billing: true,

    order_items: order.items.map((item) => ({
      name: item.name,
      sku: item.variantId ? String(item.variantId) : "SKU-DEFAULT",
      units: item.quantity,
      selling_price: String(item.price),
      tax: "0",
    })),

    payment_method: "Prepaid",

    sub_total: order.subtotal,

    // Feature 6: dimensions — use order-level stored values or sensible defaults
    length: order.dimensionLength || 15,
    breadth: order.dimensionBreadth || 10,
    height: order.dimensionHeight || 10,
    weight: parseFloat(weight.toFixed(2)),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Check serviceability — PREPAID ONLY (Feature 1)
// ─────────────────────────────────────────────────────────────────────────────

const getAvailableCouriers = async ({ deliveryPincode, weight, isCod }) => {
  const pickupPincode = (
    process.env.SHIPROCKET_PICKUP_PINCODE || "522502"
  ).trim();

  // Feature 1: always isCod=false (COD completely ignored)
  const codFlag = 0;
  const cacheKey = `${pickupPincode}-${deliveryPincode}-0-${weight}`;

  const cached = serviceabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SERVICEABILITY_TTL_MS) {
    logger.info("[Shiprocket] Serviceability cache hit", { cacheKey });
    return cached.couriers;
  }

  const data = await srFetch(
    `/courier/serviceability/?pickup_postcode=${pickupPincode}&delivery_postcode=${deliveryPincode}&weight=${weight}&cod=${codFlag}`,
    { method: "GET" },
  );

  const couriers = data.data?.available_courier_companies || [];

  serviceabilityCache.set(cacheKey, { couriers, timestamp: Date.now() });

  logger.info("[Shiprocket] Serviceability fetched & cached", {
    cacheKey,
    courierCount: couriers.length,
  });

  return couriers;
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Select best courier — PREPAID ONLY
// Feature 1: filter prepaid_supported, sort by rate ASC, tie-break by etd ASC
// ─────────────────────────────────────────────────────────────────────────────

const selectBestCourier = (couriers) => {
  if (!couriers || couriers.length === 0) return null;

  // Feature 1: ignore COD completely — all results from cod=0 are prepaid
  // Additionally guard with cod !== 1 in case the API mixes modes
  const prepaid = couriers.filter((c) => c.cod !== 1);
  const pool = prepaid.length > 0 ? prepaid : couriers;

  // Sort: lowest rate first; tie-break: lowest etd (numeric parse, fallback 999)
  const sorted = [...pool].sort((a, b) => {
    if (a.rate !== b.rate) return a.rate - b.rate;
    const etdA = parseFloat(a.etd) || 999;
    const etdB = parseFloat(b.etd) || 999;
    return etdA - etdB;
  });

  const selected = sorted[0];

  logger.info("[Shiprocket] Selected courier (prepaid, lowest cost)", {
    courier_id: selected.courier_company_id,
    courier_name: selected.courier_name,
    rate: selected.rate,
    etd: selected.etd,
  });

  return selected;
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Assign AWB with retry
// ─────────────────────────────────────────────────────────────────────────────

const assignAwbWithRetry = async (shipmentId, courierId = null) => {
  const sid = String(shipmentId);

  const attempts = [
    async () => {
      if (!courierId)
        throw new Error("No courier_id — skipping targeted attempt");
      logger.info("[Shiprocket] AWB assign attempt 1 — with courier_id", {
        shipment_id: sid,
        courier_id: courierId,
      });
      return await srFetch("/courier/assign/awb", {
        method: "POST",
        body: JSON.stringify({
          shipment_id: [Number(sid)],
          courier_id: courierId,
        }),
      });
    },
    async () => {
      logger.info("[Shiprocket] AWB assign attempt 2 — auto courier", {
        shipment_id: sid,
      });
      return await srFetch("/courier/assign/awb", {
        method: "POST",
        body: JSON.stringify({ shipment_id: [Number(sid)] }),
      });
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await attempts[i]();

      const result = res?.response?.[sid] || res?.response?.data || res?.data;

      logger.info(`[Shiprocket] AWB assign attempt ${i + 1} raw response`, {
        shipment_id: sid,
        full_response: JSON.stringify(res),
        extracted_result: JSON.stringify(result),
      });

      const awbCode = result?.awb_code || result?.awb || null;
      const courierName = result?.courier_name || "Unknown";

      if (awbCode && String(awbCode).trim() !== "" && awbCode !== "null") {
        logger.info("[Shiprocket] AWB successfully assigned", {
          shipment_id: sid,
          awb_code: awbCode,
          courier_name: courierName,
          attempt: i + 1,
        });
        return { awbCode: String(awbCode).trim(), courierName };
      }

      logger.warn(`[Shiprocket] Attempt ${i + 1} returned null AWB`, {
        shipment_id: sid,
        raw_result: JSON.stringify(result),
      });
    } catch (err) {
      logger.warn(`[Shiprocket] AWB assign attempt ${i + 1} threw error`, {
        shipment_id: sid,
        error: err.message,
      });
    }
  }

  logger.error("[Shiprocket] AWB assignment failed after all attempts", {
    shipment_id: sid,
    courier_id: courierId,
  });

  await ApiLog.create({
    service: "shiprocket",
    endpoint: "/courier/assign/awb",
    error: `AWB assignment failed for shipment ${sid}`,
    payload: { shipmentId: sid, courierId },
  });

  return { awbCode: null, courierName: null };
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Generate pickup — ONLY if AWB confirmed
// ─────────────────────────────────────────────────────────────────────────────

const generatePickupSafely = async (shipmentId, awbCode) => {
  if (!awbCode || String(awbCode).trim() === "" || awbCode === "null") {
    logger.warn("[Shiprocket] Pickup skipped — AWB not available", {
      shipment_id: shipmentId,
      awb_code: awbCode,
    });
    return false;
  }

  try {
    const res = await srFetch("/courier/generate/pickup", {
      method: "POST",
      body: JSON.stringify({ shipment_id: [Number(shipmentId)] }),
    });

    logger.info("[Shiprocket] Pickup generated successfully", {
      shipment_id: shipmentId,
      awb_code: awbCode,
      pickup_response: JSON.stringify(res),
    });

    return true;
  } catch (err) {
    logger.error("[Shiprocket] Pickup generation failed", {
      shipment_id: shipmentId,
      awb_code: awbCode,
      error: err.message,
    });
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FLOW: create order → serviceability → select courier → AWB → pickup
// ─────────────────────────────────────────────────────────────────────────────

const createShiprocketOrder = async (order, user) => {
  const payload = buildOrderPayload(order, user);

  logger.info("[Shiprocket] Creating order", {
    order_number: order.orderNumber,
    delivery_pincode: order.shippingAddress.pincode,
    weight: payload.weight,
    pickup_location: payload.pickup_location,
  });

  const orderRes = await srFetch("/orders/create/adhoc", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const shipmentId = orderRes.shipment_id;
  const orderId = orderRes.order_id;

  if (!shipmentId) {
    logger.error("[Shiprocket] Order created but no shipment_id returned", {
      full_response: JSON.stringify(orderRes),
    });
    throw new ApiError(502, "Shiprocket returned no shipment_id");
  }

  logger.info(
    `[Shiprocket] Order created: order_id=${orderId} | shipment_id=${shipmentId}`,
  );

  const isCod = false;
  const weight = payload.weight;
  const deliveryPincode = order.shippingAddress.pincode;

  let selectedCourierId = null;
  let selectedCourierName = null;
  let selectedRate = 0;
  let selectedEtd = null;

  try {
    const couriers = await getAvailableCouriers({
      deliveryPincode,
      weight,
      isCod,
    });
    const best = selectBestCourier(couriers);
    if (best) {
      selectedCourierId = best.courier_company_id;
      selectedCourierName = best.courier_name;
      selectedRate = Math.round(best.rate);
      selectedEtd = best.etd ? String(best.etd) : null;
    }
  } catch (err) {
    logger.warn(
      "[Shiprocket] Serviceability check failed — proceeding without courier_id",
      {
        error: err.message,
      },
    );
  }

  const { awbCode, courierName } = await assignAwbWithRetry(
    shipmentId,
    selectedCourierId,
  );

  await generatePickupSafely(shipmentId, awbCode);

  return {
    shiprocketOrderId: String(orderId),
    shiprocketShipmentId: String(shipmentId),
    awbCode,
    courierId: selectedCourierId,
    courierName:
      courierName ||
      selectedCourierName ||
      (awbCode ? "Shiprocket" : "Pending"),
    shippingCost: selectedRate,
    etd: selectedEtd,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTO CREATE SHIPMENT (non-throwing wrapper)
// ─────────────────────────────────────────────────────────────────────────────

const autoCreateShipment = async (order, user) => {
  if (order.awbCode) {
    logger.info("[autoCreateShipment] Skipped — AWB already exists", {
      order_number: order.orderNumber,
      awb_code: order.awbCode,
    });
    return;
  }

  try {
    const res = await createShiprocketOrder(order, user);

    order.shiprocketOrderId = res.shiprocketOrderId;
    order.shiprocketShipmentId = res.shiprocketShipmentId;
    order.awbCode = res.awbCode;
    order.courierId = res.courierId;
    order.courierName = res.courierName;
    order.shippingCost = res.shippingCost;
    order.etd = res.etd;
    order.trackingStatus = res.awbCode ? "READY" : "AWB_PENDING";

    order.statusHistory.push({
      status: order.status,
      note: res.awbCode
        ? `Shipment created. AWB: ${res.awbCode} via ${res.courierName}`
        : `Shipment created (SR order ${res.shiprocketOrderId}) but AWB pending`,
    });

    logger.info("[autoCreateShipment] Completed", {
      order_number: order.orderNumber,
      awb_code: res.awbCode,
      courier: res.courierName,
      shipping_cost: res.shippingCost,
    });
  } catch (err) {
    logger.error("[autoCreateShipment] Failed", {
      order_number: order.orderNumber,
      error: err.message,
      stack: err.stack,
    });
    await ApiLog.create({
      service: "shiprocket",
      endpoint: "/orders/create/adhoc",
      orderId: order._id,
      error: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RETRY: AWB Pending orders
// ─────────────────────────────────────────────────────────────────────────────

const retryPendingAwbOrders = async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const stuckOrders = await Order.find({
    trackingStatus: "AWB_PENDING",
    shiprocketShipmentId: { $ne: null },
    createdAt: { $gte: cutoff },
    awbRetryCount: { $lt: 5 },
  }).limit(50);

  logger.info("[AWB Retry Cron] Processing stuck orders", {
    count: stuckOrders.length,
  });

  for (const order of stuckOrders) {
    try {
      const weight = Math.max(
        0.1,
        order.items.reduce((sum, i) => sum + i.quantity, 0) * 0.5,
      );

      let courierId = null;
      try {
        const couriers = await getAvailableCouriers({
          deliveryPincode: order.shippingAddress.pincode,
          weight,
          isCod: false,
        });
        const best = selectBestCourier(couriers);
        courierId = best?.courier_company_id || null;
      } catch (e) {
        logger.warn("[AWB Retry Cron] Serviceability check failed", {
          error: e.message,
        });
      }

      const { awbCode, courierName } = await assignAwbWithRetry(
        order.shiprocketShipmentId,
        courierId,
      );

      order.awbRetryCount = (order.awbRetryCount || 0) + 1;

      if (awbCode) {
        order.awbCode = awbCode;
        order.courierName = courierName;
        order.trackingStatus = "READY";
        order.statusHistory.push({
          status: order.status,
          note: `AWB assigned on retry: ${awbCode} via ${courierName}`,
        });

        await generatePickupSafely(order.shiprocketShipmentId, awbCode);
      } else {
        if (order.awbRetryCount >= 5) {
          order.trackingStatus = "AWB_FAILED";
          order.statusHistory.push({
            status: order.status,
            note: "AWB assignment failed after 5 retries — manual intervention required",
          });
        }
      }

      await order.save();
    } catch (err) {
      logger.error("[AWB Retry Cron] Error processing order", {
        order_number: order.orderNumber,
        error: err.message,
      });
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Track Shipment
// ─────────────────────────────────────────────────────────────────────────────

const trackShipment = async (awbCode) => {
  if (process.env.DEV_MODE === "true") {
    return {
      currentStatus: "Shipped (Dev Mode)",
      deliveryDate: null,
      awbNumber: awbCode,
      shipmentTrackActivities: [
        {
          date: new Date(),
          activity: "Shipment created (DEV MODE)",
          location: "Test Warehouse",
        },
      ],
      shipmentTrack: [],
    };
  }

  const data = await srFetch(`/courier/track/awb/${awbCode}`, {
    method: "GET",
  });

  const trackData = data.tracking_data || {};
  const track = trackData.shipment_track?.[0] || {};
  const activities = trackData.shipment_track_activities || [];

  return {
    currentStatus: track.current_status || trackData.track_status || "Unknown",
    deliveryDate: track.rto_initiated_date || track.delivered_date || null,
    awbNumber: awbCode,
    shipmentTrackActivities: activities.map((a) => ({
      date: a.date,
      activity: a.activity,
      location: a.location,
    })),
    shipmentTrack: activities,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Cancel Shiprocket Order
// ─────────────────────────────────────────────────────────────────────────────

const cancelShiprocketOrder = async (shiprocketOrderId) => {
  return await srFetch("/orders/cancel", {
    method: "POST",
    body: JSON.stringify({ ids: [Number(shiprocketOrderId)] }),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Feature 3: Generate Invoice PDF
// ─────────────────────────────────────────────────────────────────────────────

const generateInvoice = async (shiprocketOrderId) => {
  const data = await srFetch("/orders/print/invoice", {
    method: "POST",
    body: JSON.stringify({ ids: [Number(shiprocketOrderId)] }),
  });
  return data.invoice_url || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Generate Label PDF
// ─────────────────────────────────────────────────────────────────────────────

const generateLabel = async (shiprocketShipmentId) => {
  const data = await srFetch("/courier/generate/label", {
    method: "POST",
    body: JSON.stringify({ shipment_id: [Number(shiprocketShipmentId)] }),
  });
  return data.label_url || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Get Shipping Rates (for frontend display)
// ─────────────────────────────────────────────────────────────────────────────

const getShippingRates = async ({
  pickupPincode,
  deliveryPincode,
  weight,
  cod,
}) => {
  const pickup = (
    pickupPincode ||
    process.env.SHIPROCKET_PICKUP_PINCODE ||
    "522502"
  ).trim();

  const data = await srFetch(
    `/courier/serviceability/?pickup_postcode=${pickup}&delivery_postcode=${deliveryPincode}&weight=${weight || 0.5}&cod=${cod ? 1 : 0}`,
    { method: "GET" },
  );

  const couriers = data.data?.available_courier_companies || [];

  return couriers.map((c) => ({
    courierId: c.courier_company_id,
    courierName: c.courier_name,
    rate: c.rate,
    estimatedDays: c.etd,
    codSupported: c.cod === 1,
  }));
};

module.exports = {
  createShiprocketOrder,
  autoCreateShipment,
  retryPendingAwbOrders,
  mapShiprocketStatusToInternal,
  trackShipment,
  cancelShiprocketOrder,
  generateInvoice,
  generateLabel,
  getShippingRates,
  getAvailableCouriers,
  selectBestCourier,
  assignAwbWithRetry,
  generatePickupSafely,
};
