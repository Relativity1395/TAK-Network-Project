// app.js — Geofence UI (MVP)
// Uses Leaflet + Leaflet.draw (loaded via CDN in index.html)

(() => {
  // ====== A) Config ======
  const APP_VERSION = "0.1.0";
  const API_URL = ""; // ← put your Python endpoint here, e.g. "https://example.com/geofences"
  const ENABLE_OFFLINE_QUEUE = true;

  const MAP_DEFAULT_CENTER = [38.8895, -77.0352]; // DC Mall fallback
  const MAP_DEFAULT_ZOOM = 13;
  const MAX_VERTICES = 200;

  // ====== B) State & DOM cache ======
  const state = {
    leafletMap: null,
    drawnItems: null,
    drawnLayer: null,     // the single active polygon (Leaflet layer)
    drawHandler: null,    // L.Draw.Polygon instance while drawing
    editHandler: null,    // L.EditToolbar.Edit instance while editing
    mode: "idle",         // idle | drawing | editing | ready | sending | success | error
    currentPosition: null, // {lat, lon, accuracy}
    fenceName: "",
    geojson: null,        // last-built payload object
    queue: [],            // pending payloads when offline
    online: navigator.onLine,
  };

  const dom = {
    appVersion: document.getElementById("appVersion"),
    map: document.getElementById("map"),

    btnDraw: document.getElementById("btnDraw"),
    btnEdit: document.getElementById("btnEdit"),
    btnClear: document.getElementById("btnClear"),
    btnRecenter: document.getElementById("btnRecenter"),
    btnSend: document.getElementById("btnSend"),
    btnRetryQueue: document.getElementById("btnRetryQueue"),

    fenceName: document.getElementById("fenceName"),
    infoSheet: document.getElementById("infoSheet"),
    jsonPreview: document.getElementById("jsonPreview"),
    statusToast: document.getElementById("statusToast"),

    statVertices: document.getElementById("statVertices"),
    statPerimeter: document.getElementById("statPerimeter"),
    statArea: document.getElementById("statArea"),
  };

  // ====== C) Boot ======
  window.addEventListener("DOMContentLoaded", init);

  function init() {
    dom.appVersion && (dom.appVersion.textContent = `v${APP_VERSION}`);

    bindUI();
    loadQueue();

    initMap();
    tryGeolocate();

    // Initial render
    renderButtons();
    renderSheet(false);
    renderStats();
    renderJsonPreview();

    // Network listeners
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (!state.online) onOffline();
  }

  // ====== D) Map & Draw setup ======
  function initMap() {
    const map = L.map(dom.map, { zoomControl: true });
    state.leafletMap = map;

    // Tile layer (OpenStreetMap via tile.openstreetmap.org)
    const tile = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
      maxZoom: 19,
    });
    tile.addTo(map);

    map.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);

    // Feature group to hold the polygon
    const drawnItems = new L.FeatureGroup();
    state.drawnItems = drawnItems;
    map.addLayer(drawnItems);

    // Listen for draw/edit/delete events
    map.on(L.Draw.Event.CREATED, (e) => {
      // Only allow a single polygon at a time
      if (state.drawnLayer) {
        state.drawnItems.removeLayer(state.drawnLayer);
        state.drawnLayer = null;
      }
      const layer = e.layer;
      state.drawnItems.addLayer(layer);
      state.drawnLayer = layer;
      state.mode = "ready";
      buildAndRenderPayload();
      renderButtons();
      renderSheet(true);
    });

    map.on(L.Draw.Event.EDITED, () => {
      // user saved edits
      if (!state.drawnLayer) return;
      buildAndRenderPayload();
      state.mode = "ready";
      renderButtons();
    });

    map.on(L.Draw.Event.DELETED, () => {
      clearPolygon();
    });
  }

  function startDrawing() {
    if (!state.leafletMap) return;
    // Disable edit mode if active
    stopEditing(true);

    // Configure polygon drawing
    if (state.drawHandler) state.drawHandler.disable();
    state.drawHandler = new L.Draw.Polygon(state.leafletMap, {
      showArea: false,
      allowIntersection: false,
      shapeOptions: {
        color: "#60a5fa",
        weight: 2,
        fillOpacity: 0.1,
      },
      guidelineDistance: 10,
      metric: true,
      feet: false,
    });
    state.drawHandler.enable();
    state.mode = "drawing";
    toast("Tap to add vertices. Double-tap to finish.", "success");
    renderButtons();
  }

  function startEditing() {
    if (!state.leafletMap || !state.drawnItems || !state.drawnLayer) return;
    // Programmatically enable edit mode for existing polygon
    if (state.editHandler) state.editHandler.disable();
    state.editHandler = new L.EditToolbar.Edit(state.leafletMap, {
      featureGroup: state.drawnItems,
      selectedPathOptions: L.EditToolbar.Edit.prototype.options.selectedPathOptions,
    });
    state.editHandler.enable();
    state.mode = "editing";
    renderButtons();
    toast("Drag vertices to adjust. Click Edit again to save.", "success");
  }

  function stopEditing(save = true) {
    if (!state.editHandler) return;
    try {
      if (save) state.editHandler.save();
      state.editHandler.disable();
    } catch (_) {
      // ignore
    }
    state.editHandler = null;
    state.mode = "ready";
    buildAndRenderPayload();
    renderButtons();
  }

  function clearPolygon() {
    if (state.drawnLayer) {
      state.drawnItems.removeLayer(state.drawnLayer);
      state.drawnLayer = null;
    }
    state.geojson = null;
    state.mode = "idle";
    renderButtons();
    renderStats();
    renderJsonPreview();
    renderSheet(false);
  }

  // ====== E) Geolocation ======
  function tryGeolocate() {
    if (!("geolocation" in navigator)) {
      toast("Geolocation not supported; using default view.", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        state.currentPosition = { lat: latitude, lon: longitude, accuracy };
        state.leafletMap.setView([latitude, longitude], 16);
        // draw an accuracy circle (light)
        L.circle([latitude, longitude], {
          radius: Math.min(accuracy || 0, 60),
          weight: 1,
          opacity: 0.6,
          fillOpacity: 0.08,
        }).addTo(state.leafletMap);
      },
      (err) => {
        // Most common cause: not HTTPS or permission denied
        console.warn("Geolocation error:", err);
        toast("Couldn’t get location; using default view.", "error");
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 20000 }
    );
  }

  function recenter() {
    if (state.currentPosition) {
      state.leafletMap.setView([state.currentPosition.lat, state.currentPosition.lon], 16);
    } else {
      tryGeolocate();
    }
  }

  // ====== F) Geometry, Validation, Stats ======
  function getPolygonLatLngs(layer) {
    // Leaflet polygon latlngs structure: [ [LatLng, LatLng, ...] ] for simple polygons
    if (!layer) return [];
    const rings = layer.getLatLngs();
    if (!rings || !rings.length) return [];
    const firstRing = Array.isArray(rings[0]) ? rings[0] : rings;
    return firstRing.map((p) => ({ lat: p.lat, lon: p.lng }));
  }

  function validateCoords(coords) {
    if (!coords || coords.length < 3) return { ok: false, reason: "Need ≥ 3 vertices." };
    if (coords.length > MAX_VERTICES) {
      return { ok: false, reason: `Too many vertices (>${MAX_VERTICES}).` };
    }
    // Basic uniqueness check (avoid duplicates causing zero-length edges)
    const uniq = new Set(coords.map((c) => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`));
    if (uniq.size < 3) return { ok: false, reason: "Vertices too close/duplicate." };
    // Self-intersection check is omitted in MVP (add Turf later)
    return { ok: true };
  }

  function toClosedRingLonLat(coords) {
    // GeoJSON order: [lon, lat]
    const ring = coords.map((c) => [round6(c.lon), round6(c.lat)]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return ring;
  }

  function round6(n) {
    return Math.round(n * 1e6) / 1e6; // ~0.11m at equator
  }

  // Stats: perimeter (Haversine), area (planar approx via Web Mercator + shoelace)
  function computeStats(coords) {
    if (!coords || coords.length < 3) {
      return { vertices: 0, perimeter_m: 0, area_m2: 0 };
    }
    const ring = toClosedRingLonLat(coords);
    let perimeter = 0;
    for (let i = 1; i < ring.length; i++) {
      perimeter += haversineMeters(ring[i - 1][1], ring[i - 1][0], ring[i][1], ring[i][0]); // lat,lon inputs
    }
    const area = polygonAreaWebMercator(ring);
    return { vertices: ring.length - 1, perimeter_m: perimeter, area_m2: Math.abs(area) };
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function lonLatToWebMercator(lon, lat) {
    // EPSG:3857
    const R = 6378137.0;
    const x = (lon * Math.PI) / 180 * R;
    const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
    return [x, y];
  }

  function polygonAreaWebMercator(ringLonLat) {
    // ringLonLat: [[lon,lat], ... closed]
    const pts = ringLonLat.map(([lon, lat]) => lonLatToWebMercator(lon, lat));
    let sum = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2; // m^2
  }

  // ====== G) Payload ======
  function buildPayload(coords, name) {
    const ring = toClosedRingLonLat(coords);
    return {
      spec_version: "1.0",
      fence_id: `ui-${uuidv4()}`,
      created_at: new Date().toISOString(),
      crs: "EPSG:4326",
      shape: {
        type: "Polygon",
        coordinates: [ring],
      },
      properties: {
        name: name || "",
        notes: "Drawn on tablet",
      },
    };
  }

  function buildAndRenderPayload() {
    if (!state.drawnLayer) return;
    const coords = getPolygonLatLngs(state.drawnLayer);
    const val = validateCoords(coords);
    if (!val.ok) {
      state.geojson = null;
      dom.btnSend.disabled = true;
      renderStats();
      renderJsonPreview(val.reason);
      return;
    }
    const payload = buildPayload(coords, state.fenceName);
    state.geojson = payload;
    dom.btnSend.disabled = false;
    renderStats(coords);
    renderJsonPreview();
  }

  // ====== H) Networking & Queue ======
  async function sendGeofence() {
    if (!state.geojson) return;
    if (!API_URL) {
      toast("Set API_URL in app.js to enable sending.", "error");
      return;
    }
    setBusy(true);
    state.mode = "sending";
    renderButtons();

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // "Authorization": "Bearer <API_KEY>", // optional
        },
        body: JSON.stringify(state.geojson),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Server ${res.status}: ${txt || res.statusText}`);
      }
      toast("Geofence sent successfully.", "success");
      state.mode = "success";
      renderButtons();
    } catch (err) {
      console.error(err);
      if (ENABLE_OFFLINE_QUEUE) {
        enqueue(state.geojson, String(err.message || err));
        toast("Send failed. Saved to queue.", "error");
        dom.btnRetryQueue.hidden = false;
      } else {
        toast("Send failed.", "error");
        state.mode = "error";
      }
      renderButtons();
    } finally {
      setBusy(false);
    }
  }

  function enqueue(payload, last_error = "") {
    const item = {
      id: `q-${uuidv4()}`,
      payload,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
      last_error,
    };
    state.queue.push(item);
    saveQueue();
  }

  async function retryQueue() {
    if (!state.queue.length) {
      toast("No queued items.", "success");
      dom.btnRetryQueue.hidden = true;
      return;
    }
    if (!API_URL) {
      toast("Set API_URL first.", "error");
      return;
    }
    setBusy(true);
    const stillPending = [];
    for (const item of state.queue) {
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload),
        });
        if (!res.ok) throw new Error(`Server ${res.status}`);
      } catch (e) {
        item.attempts += 1;
        item.last_error = String(e.message || e);
        stillPending.push(item);
      }
    }
    state.queue = stillPending;
    saveQueue();
    setBusy(false);

    if (stillPending.length) {
      toast(`Some items still queued (${stillPending.length}).`, "error");
      dom.btnRetryQueue.hidden = false;
    } else {
      toast("All queued items sent.", "success");
      dom.btnRetryQueue.hidden = true;
    }
  }

  function saveQueue() {
    try {
      localStorage.setItem("geofenceQueue", JSON.stringify(state.queue));
    } catch (_) {}
  }
  function loadQueue() {
    try {
      const raw = localStorage.getItem("geofenceQueue");
      if (raw) state.queue = JSON.parse(raw) || [];
      dom.btnRetryQueue.hidden = !state.queue.length;
    } catch (_) {
      state.queue = [];
    }
  }

  // ====== I) UI Wiring ======
  function bindUI() {
    dom.btnDraw.addEventListener("click", () => {
      if (state.mode === "editing") {
        stopEditing(true);
      }
      startDrawing();
    });

    dom.btnEdit.addEventListener("click", () => {
      if (state.mode === "editing") {
        stopEditing(true); // save & leave edit mode
      } else if (state.drawnLayer) {
        startEditing();
      }
    });

    dom.btnClear.addEventListener("click", () => {
      if (state.mode === "editing") stopEditing(false);
      clearPolygon();
    });

    dom.btnRecenter.addEventListener("click", recenter);

    dom.btnSend.addEventListener("click", sendGeofence);

    dom.btnRetryQueue.addEventListener("click", retryQueue);

    dom.fenceName.addEventListener("input", (e) => {
      state.fenceName = e.target.value || "";
      if (state.drawnLayer) buildAndRenderPayload();
    });

    // Expand/collapse bottom sheet when handle area is tapped (simple UX)
    dom.infoSheet.querySelector(".sheet__handle").addEventListener("click", () => {
      dom.infoSheet.classList.toggle("open");
    });
  }

  function renderButtons() {
    const hasPoly = !!state.drawnLayer;
    dom.btnEdit.disabled = !hasPoly;
    dom.btnClear.disabled = !hasPoly;

    if (state.mode === "editing") {
      dom.btnEdit.textContent = "Done";
    } else {
      dom.btnEdit.textContent = "Edit";
    }

    dom.btnSend.disabled = !state.geojson || state.mode === "sending";
  }

  function renderSheet(open) {
    if (open) dom.infoSheet.classList.add("open");
    else dom.infoSheet.classList.remove("open");
  }

  function renderJsonPreview(errorMsg) {
    if (errorMsg) {
      dom.jsonPreview.value = `// ${errorMsg}`;
      return;
    }
    dom.jsonPreview.value = state.geojson
      ? JSON.stringify(state.geojson, null, 2)
      : "// Draw a polygon to see the payload…";
  }

  function renderStats(coords) {
    if (!coords && state.drawnLayer) coords = getPolygonLatLngs(state.drawnLayer);
    if (!coords || coords.length < 3) {
      dom.statVertices.textContent = "0";
      dom.statPerimeter.textContent = "—";
      dom.statArea.textContent = "—";
      return;
    }
    const { vertices, perimeter_m, area_m2 } = computeStats(coords);
    dom.statVertices.textContent = String(vertices);
    dom.statPerimeter.textContent = formatMeters(perimeter_m);
    dom.statArea.textContent = formatSquareMeters(area_m2);
  }

  function setBusy(isBusy) {
    document.body.classList.toggle("is-disabled", isBusy);
  }

  function toast(msg, type = "success", ms = 2200) {
    const el = dom.statusToast;
    el.textContent = msg;
    el.className = `toast show ${type === "error" ? "error" : "success"}`;
    setTimeout(() => {
      el.classList.remove("show");
    }, ms);
  }

  function onOnline() {
    state.online = true;
    toast("Back online.", "success");
    if (state.queue.length) dom.btnRetryQueue.hidden = false;
  }
  function onOffline() {
    state.online = false;
    toast("Offline. Sends will be queued.", "error");
  }

  // ====== J) Utils ======
  function uuidv4() {
    // RFC4122 v4
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = [...buf].map((b) => b.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }

  function formatMeters(m) {
    if (!isFinite(m) || m <= 0) return "—";
    if (m < 1000) return `${m.toFixed(0)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  function formatSquareMeters(m2) {
    if (!isFinite(m2) || m2 <= 0) return "—";
    if (m2 < 1e6) return `${m2.toFixed(0)} m²`;
    return `${(m2 / 1e6).toFixed(2)} km²`;
  }
})();
