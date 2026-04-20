/**
 * Shiprocket Service — Production-Grade AWB Fix
 *
 * ROOT CAUSES FOUND IN LOGS:
 *
 * BUG 1 — Wrong AWB endpoint (404 Not Found)
 *   Log: [Shiprocket ERROR /courier/assign/robo] 404 Not Found
 *   Log: [Shiprocket ERROR /courier/assign/awd]  404 Not Found
 *   Cause: Endpoint is NOT /courier/assign/robo or /courier/assign/awd
 *   Fix:   Correct endpoint is POST /courier/assign/awb
 *          (the code has it right in latest version but logs prove it was
 *           previously broken — likely from a typo during iteration)
 *
 * BUG 2 — AWB response parsed incorrectly → always null even when assigned
 *   Log: "[Shiprocket] AWB assigned: null via Shiprocket Courier"
 *        (courier_name is present, meaning Shiprocket DID assign something
 *         but awb_code extraction failed)
 *   Cause: Shiprocket /courier/assign/awb returns:
 *          { response: { data: { awb_code: "...", courier_name: "..." } } }
 *          BUT the code reads: assignRes?.response?.[shipmentId]
 *          shipmentId is a NUMBER, object keys are STRINGS.
 *          assignRes.response["1292526269"] !== assignRes.response[1292526269]
 *   Fix:   Always coerce: String(shipmentId)
 *
 * BUG 3 — Pickup called even when AWB is null (in some code versions)
 *   Log: [Shiprocket] API error [/courier/generate/pickup]: Awb not Assigned
 *        immediately after "AWB assigned: null"
 *   Cause: The awbCode null-check guard existed but pickup was still called
 *          because the awbCode was mistakenly set to the string "null"
 *          in one version, or the guard was bypassed by incorrect scoping
 *   Fix:   Explicit guard: if (!awbCode || awbCode === 'null') skip pickup
 *
 * BUG 4 — No serviceability check before AWB assign
 *   Cause: If destination pincode has no serviceable courier, Shiprocket
 *          returns awb_code: null with no error — silent failure
 *   Fix:   Check serviceability FIRST, select a specific courier_id,
 *          then assign with that courier_id
 *
 * BUG 5 — pickup_location name has trailing space in .env
 *   .env: SHIPROCKET_PICKUP_LOCATION_NAME=Primary   # must match...
 *   The comment is inline — value becomes "Primary   # must match..."
 *   Fix:   Always .trim() the env value
 *
 * BUG 6 — weight=0 when order has 0 quantity items (edge case)
 *   weight = items.reduce((sum, i) => sum + i.quantity, 0) * 0.5
 *   If all quantities are 0 somehow → weight=0 → Shiprocket rejects
 *   Fix:   Math.max(0.1, weight) — minimum 100g
 */

const {
  getShiprocketHeaders,
  invalidateToken,
  BASE_URL,
} = require("../config/shiprocket");
const logger = require("../utils/logger");
const ApiError = require("../utils/ApiError");
const Order = require("../models/Order.model");

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
    throw new ApiError(502, `Shiprocket non-JSON response: ${response.statusText}`);
  }

  if (!response.ok) {
    // Log the FULL response — this is what was missing before
    logger.error(`[Shiprocket ERROR ${endpoint}]`, {
      status_code: response.status,
      message: data.message || data.error || "Unknown error",
      full_response: JSON.stringify(data),
    });
    throw new ApiError(502, data.message || `Shiprocket API failed: ${endpoint}`);
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
  return SHIPROCKET_STATUS_MAP[status.toLowerCase().trim()] || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// BUILD ORDER PAYLOAD
// ─────────────────────────────────────────────────────────────────────────────

const buildOrderPayload = (order, user) => {
  const addr = order.shippingAddress;

  // BUG 6 FIX: minimum weight 0.1 kg to avoid Shiprocket rejection
  const weight = Math.max(
    0.1,
    order.items.reduce((sum, i) => sum + i.quantity, 0) * 0.5
  );

  // BUG 5 FIX: trim the pickup location name — .env inline comments pollute the value
  const pickupLocation = (
    process.env.SHIPROCKET_PICKUP_LOCATION_NAME || "Primary"
  ).trim();

  return {
    order_id: order.orderNumber,
    order_date: new Date(order.createdAt).toISOString().split("T")[0],
    pickup_location: pickupLocation,

    billing_customer_name: addr.fullName || "Customer",
    billing_last_name: ".", // Required by Shiprocket — cannot be empty

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

    payment_method: order.paymentMethod === "cod" ? "COD" : "Prepaid",
    ...(order.paymentMethod === "cod" && { cod_amount: order.total }),

    sub_total: order.subtotal,

    length: 30,
    breadth: 25,
    height: 5,
    weight: parseFloat(weight.toFixed(2)),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Check serviceability and get available couriers
// ─────────────────────────────────────────────────────────────────────────────

const getAvailableCouriers = async ({
  deliveryPincode,
  weight,
  isCod,
}) => {
  const pickupPincode = (process.env.SHIPROCKET_PICKUP_PINCODE || "522502").trim();

  logger.info("[Shiprocket] Checking serviceability", {
    pickup_pincode: pickupPincode,
    delivery_pincode: deliveryPincode,
    weight,
    cod: isCod ? 1 : 0,
  });

  const data = await srFetch(
    `/courier/serviceability/?pickup_postcode=${pickupPincode}&delivery_postcode=${deliveryPincode}&weight=${weight}&cod=${isCod ? 1 : 0}`,
    { method: "GET" }
  );

  const couriers = data.data?.available_courier_companies || [];

  logger.info("[Shiprocket] Serviceability result", {
    delivery_pincode: deliveryPincode,
    total_couriers: couriers.length,
    couriers: couriers.map((c) => ({
      id: c.courier_company_id,
      name: c.courier_name,
      rate: c.rate,
      etd: c.etd,
      cod: c.cod,
    })),
  });

  if (couriers.length === 0) {
    logger.error("[Shiprocket] NO couriers serviceable", {
      delivery_pincode: deliveryPincode,
      pickup_pincode: pickupPincode,
      cod: isCod,
    });
  }

  return couriers;
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Select best courier (cheapest + COD-compatible)
// ─────────────────────────────────────────────────────────────────────────────

const selectBestCourier = (couriers, isCod) => {
  if (!couriers || couriers.length === 0) return null;

  // Filter: must support COD if order is COD
  const eligible = isCod
    ? couriers.filter((c) => c.cod === 1)
    : couriers;

  if (eligible.length === 0) {
    logger.error("[Shiprocket] No couriers support COD for this pincode", {
      total_available: couriers.length,
      cod_required: isCod,
    });
    return null;
  }

  // Sort by rate ascending, pick cheapest
  const sorted = [...eligible].sort((a, b) => a.rate - b.rate);
  const selected = sorted[0];

  logger.info("[Shiprocket] Selected courier", {
    courier_id: selected.courier_company_id,
    courier_name: selected.courier_name,
    rate: selected.rate,
    etd: selected.etd,
    cod_supported: selected.cod === 1,
  });

  return selected;
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Assign AWB with retry (with and without courier_id)
//
// BUG 2 FIX: response key must be String(shipmentId), not numeric shipmentId
// BUG 1 FIX: correct endpoint is /courier/assign/awb
// ─────────────────────────────────────────────────────────────────────────────

const assignAwbWithRetry = async (shipmentId, courierId = null) => {
  const sid = String(shipmentId); // critical: Shiprocket response key is always a string

  const attempts = [
    // Attempt 1: with specific courier_id (higher success rate)
    async () => {
      if (!courierId) throw new Error("No courier_id — skipping targeted attempt");
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
    // Attempt 2: without courier_id (let Shiprocket auto-assign)
    async () => {
      logger.info("[Shiprocket] AWB assign attempt 2 — auto courier (no courier_id)", {
        shipment_id: sid,
      });
      return await srFetch("/courier/assign/awb", {
        method: "POST",
        body: JSON.stringify({
          shipment_id: [Number(sid)],
        }),
      });
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await attempts[i]();

      // BUG 2 FIX: use String(shipmentId) as key — Shiprocket response always has string keys
      const result =
        res?.response?.[sid] ||           // primary path
        res?.response?.data ||            // some API versions nest under .data
        res?.data;                        // fallback

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
      // Continue to next attempt
    }
  }

  logger.error("[Shiprocket] AWB assignment failed after all attempts", {
    shipment_id: sid,
    courier_id: courierId,
  });

  return { awbCode: null, courierName: null };
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Generate pickup — ONLY if AWB is confirmed non-null
//
// BUG 3 FIX: strict guard against null/string-"null"/empty awbCode
// ─────────────────────────────────────────────────────────────────────────────

const generatePickupSafely = async (shipmentId, awbCode) => {
  // HARD GUARD: never call pickup without a valid AWB
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
    // Pickup failure is non-fatal — AWB is still valid, shipment can be picked up manually
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
    payment_method: order.paymentMethod,
    weight: payload.weight,
    pickup_location: payload.pickup_location,
  });

  // STEP 0: Create order on Shiprocket
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

  logger.info(`[Shiprocket] Order created: order_id=${orderId} | shipment_id=${shipmentId}`);

  // STEP 1: Check serviceability — detect no-courier scenario BEFORE assigning AWB
  const isCod = order.paymentMethod === "cod";
  const weight = payload.weight;
  const deliveryPincode = order.shippingAddress.pincode;

  let selectedCourierId = null;

  try {
    const couriers = await getAvailableCouriers({
      deliveryPincode,
      weight,
      isCod,
    });

    const best = selectBestCourier(couriers, isCod);
    selectedCourierId = best?.courier_company_id || null;
  } catch (err) {
    logger.warn("[Shiprocket] Serviceability check failed — proceeding without courier_id", {
      error: err.message,
    });
    // Non-fatal: AWB attempt 2 (auto-assign) will still run
  }

  // STEP 2: Assign AWB with retry
  const { awbCode, courierName } = await assignAwbWithRetry(shipmentId, selectedCourierId);

  // STEP 3: Generate pickup ONLY if AWB is confirmed
  await generatePickupSafely(shipmentId, awbCode);

  return {
    shiprocketOrderId: String(orderId),
    shiprocketShipmentId: String(shipmentId),
    awbCode,
    courierName: courierName || (awbCode ? "Shiprocket" : "Pending"),
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
    order.courierName = res.courierName;
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
      sr_order_id: res.shiprocketOrderId,
      sr_shipment_id: res.shiprocketShipmentId,
    });
  } catch (err) {
    logger.error("[autoCreateShipment] Failed", {
      order_number: order.orderNumber,
      error: err.message,
      stack: err.stack,
    });
    // Non-throwing: order confirmed even if Shiprocket fails
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RETRY: Retry AWB for all stuck AWB_PENDING orders
// Called by cron job every 15 minutes (SHIPMENT_RETRY_CRON in .env)
// ─────────────────────────────────────────────────────────────────────────────

const retryPendingAwbOrders = async () => {
  // Find orders stuck in AWB_PENDING for up to 24 hours, max 5 retry attempts
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const stuckOrders = await Order.find({
    trackingStatus: "AWB_PENDING",
    shiprocketShipmentId: { $ne: null },
    createdAt: { $gte: cutoff },
    awbRetryCount: { $lt: 5 }, // add this field to Order schema
  }).limit(50);

  logger.info("[AWB Retry Cron] Processing stuck orders", {
    count: stuckOrders.length,
  });

  for (const order of stuckOrders) {
    try {
      logger.info("[AWB Retry Cron] Retrying AWB for order", {
        order_number: order.orderNumber,
        shipment_id: order.shiprocketShipmentId,
        retry_count: order.awbRetryCount,
      });

      const isCod = order.paymentMethod === "cod";
      const weight = Math.max(
        0.1,
        order.items.reduce((sum, i) => sum + i.quantity, 0) * 0.5
      );

      // Re-check serviceability in case courier availability changed
      let courierId = null;
      try {
        const couriers = await getAvailableCouriers({
          deliveryPincode: order.shippingAddress.pincode,
          weight,
          isCod,
        });
        const best = selectBestCourier(couriers, isCod);
        courierId = best?.courier_company_id || null;
      } catch (e) {
        logger.warn("[AWB Retry Cron] Serviceability check failed", { error: e.message });
      }

      const { awbCode, courierName } = await assignAwbWithRetry(
        order.shiprocketShipmentId,
        courierId
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

        logger.info("[AWB Retry Cron] AWB assigned successfully", {
          order_number: order.orderNumber,
          awb_code: awbCode,
        });
      } else {
        logger.warn("[AWB Retry Cron] AWB still null after retry", {
          order_number: order.orderNumber,
          retry_count: order.awbRetryCount,
        });

        if (order.awbRetryCount >= 5) {
          order.trackingStatus = "AWB_FAILED";
          order.statusHistory.push({
            status: order.status,
            note: "AWB assignment failed after 5 retries — manual intervention required",
          });
          logger.error("[AWB Retry Cron] Order needs manual intervention", {
            order_number: order.orderNumber,
            sr_order_id: order.shiprocketOrderId,
            sr_shipment_id: order.shiprocketShipmentId,
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

  const data = await srFetch(`/courier/track/awb/${awbCode}`, { method: "GET" });

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
// Get Shipping Rates (for frontend display)
// ─────────────────────────────────────────────────────────────────────────────

const getShippingRates = async ({ pickupPincode, deliveryPincode, weight, cod }) => {
  const pickup = (pickupPincode || process.env.SHIPROCKET_PICKUP_PINCODE || "522502").trim();

  const data = await srFetch(
    `/courier/serviceability/?pickup_postcode=${pickup}&delivery_postcode=${deliveryPincode}&weight=${weight || 0.5}&cod=${cod ? 1 : 0}`,
    { method: "GET" }
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

// ─────────────────────────────────────────────────────────────────────────────
// Generate Label
// ─────────────────────────────────────────────────────────────────────────────

const generateLabel = async (shiprocketShipmentId) => {
  const data = await srFetch("/courier/generate/label", {
    method: "POST",
    body: JSON.stringify({ shipment_id: [Number(shiprocketShipmentId)] }),
  });
  return data.label_url || null;
};

module.exports = {
  createShiprocketOrder,
  autoCreateShipment,
  retryPendingAwbOrders,
  mapShiprocketStatusToInternal,
  trackShipment,
  cancelShiprocketOrder,
  generateLabel,
  getShippingRates,
  // exported for testing
  getAvailableCouriers,
  selectBestCourier,
  assignAwbWithRetry,
  generatePickupSafely,
};
