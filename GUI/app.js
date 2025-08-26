// app.js — Geofence UI (MVP + Custom Edit Mode)
// Leaflet + Leaflet.draw for drawing; custom handles for editing.

(() => {
  // ====== A) Config ======
  const APP_VERSION = "0.2.0";
  const API_URL = ""; // ← put your Python endpoint here, e.g. "https://example.com/geofences"
  const ENABLE_OFFLINE_QUEUE = true;

  const MAP_DEFAULT_CENTER = [38.8895, -77.0352]; // DC Mall fallback
  const MAP_DEFAULT_ZOOM = 13;
  const MAX_VERTICES = 200;

  // Handle sizes for custom edit mode
  const VERT_SIZE = 14;   // px
  const MID_SIZE = 10;    // px

  // ====== B) State & DOM cache ======
  const state = {
    leafletMap: null,
    drawnItems: null,
    drawnLayer: null,          // active polygon (Leaflet layer)
    mode: "idle",              // idle | drawing | editing | ready | sending | success | error
    currentPosition: null,     // {lat, lon, accuracy}
    fenceName: "",
    geojson: null,             // last-built payload object
    queue: [],                 // pending payloads when offline
    online: navigator.onLine,

    // Custom edit mode runtime:
    editLayerGroup: null,      // L.LayerGroup for handles
    vertexMarkers: [],         // array of L.Marker for vertices
    midMarkers: [],            // array of L.Marker for midpoints
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

    // OSM tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    map.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);

    // Feature group to hold the polygon
    const drawnItems = new L.FeatureGroup();
    state.drawnItems = drawnItems;
    map.addLayer(drawnItems);

    // Listen for draw/create/delete from Leaflet.draw
    map.on(L.Draw.Event.CREATED, (e) => {
      // If a polygon exists, clear it and any edit handles
      if (state.drawnLayer) {
        cleanupEditMode();
        state.drawnItems.removeLayer(state.drawnLayer);
        state.drawnLayer = null;
        state.geojson = null;
      }

      // Add the new polygon
      const layer = e.layer;
      state.drawnItems.addLayer(layer);
      state.drawnLayer = layer;

      // Update UI / payload
      state.mode = "ready";
      buildAndRenderPayload();
      renderButtons();
      renderSheet(true);
    });

    map.on(L.Draw.Event.DELETED, () => {
      clearPolygon();
    });
  }

  function startDrawing() {
    if (!state.leafletMap) return;
    // Leaving edit mode if active
    if (state.mode === "editing") exitCustomEditMode(true);

    // Create and enable a polygon draw tool
    const draw = new L.Draw.Polygon(state.leafletMap, {
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
    draw.enable();
    state.mode = "drawing";
    toast("Tap to add vertices. Double-tap to finish.", "success");
    renderButtons();
  }

  function clearPolygon() {
    cleanupEditMode();
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
        L.circle([latitude, longitude], {
          radius: Math.min(accuracy || 0, 60),
          weight: 1,
          opacity: 0.6,
          fillOpacity: 0.08,
        }).addTo(state.leafletMap);
      },
      (err) => {
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

  // ====== F) Custom Edit Mode ======
  function enterCustomEditMode() {
    if (!state.drawnLayer) return;
    if (state.mode === "editing") return;

    // Prepare edit layer group
    cleanupEditMode();
    state.editLayerGroup = L.layerGroup().addTo(state.leafletMap);
    state.vertexMarkers = [];
    state.midMarkers = [];

    // Create handles
    const ring = getRingLatLngs(state.drawnLayer); // open ring (no repeated last)
    ring.forEach((latlng, i) => addVertexMarker(latlng, i));
    addAllMidMarkers();

    state.mode = "editing";
    renderButtons();
    toast("Drag white squares to move vertices. Tap a white square to remove. Tap a small dot on an edge to insert a vertex.", "success", 4200);
  }

  function exitCustomEditMode(save = true) {
    if (save && state.drawnLayer) {
      // Rebuild payload from current geometry
      buildAndRenderPayload();
      state.mode = "ready";
    } else {
      state.mode = state.drawnLayer ? "ready" : "idle";
    }
    cleanupEditMode();
    renderButtons();
  }

  function cleanupEditMode() {
    // Remove all edit handles
    if (state.editLayerGroup) {
      state.editLayerGroup.remove();
      state.editLayerGroup = null;
    }
    state.vertexMarkers = [];
    state.midMarkers = [];
  }

  // --- Vertex + Midpoint handles ---
  function addVertexMarker(latlng, index) {
    const marker = L.marker(latlng, {
      draggable: true,
      icon: L.divIcon({
        className: "",
        iconSize: [VERT_SIZE, VERT_SIZE],
        html: `<div style="
          width:${VERT_SIZE}px;height:${VERT_SIZE}px;
          background:#fff;border:2px solid #60a5fa;border-radius:4px;
          box-shadow:0 1px 3px rgba(0,0,0,.25);
        "></div>`,
      }),
      zIndexOffset: 1000,
    });

    let dragged = false;

    marker.on("dragstart", () => {
      dragged = false;
    });

    marker.on("drag", (e) => {
      dragged = true;
      const newLatLng = e.target.getLatLng();
      const ring = getRingLatLngs(state.drawnLayer);
      ring[index] = newLatLng;
      setRingLatLngs(state.drawnLayer, ring);
      // Move this marker, and refresh only adjacent midpoints
      state.vertexMarkers[index].setLatLng(newLatLng);
      refreshAdjacentMidMarkers(index);
      liveUpdateStats();
    });

    marker.on("dragend", () => {
      // After drag, rebuild payload
      buildAndRenderPayload();
    });

    marker.on("click", () => {
      // Click (not a drag) removes the vertex, if safe
      if (dragged) return; // ignore clicks following a drag
      const ring = getRingLatLngs(state.drawnLayer);
      if (ring.length <= 3) {
        toast("Need at least 3 vertices.", "error");
        return;
      }
      // Remove this vertex
      ring.splice(index, 1);
      setRingLatLngs(state.drawnLayer, ring);
      // Rebuild all handles with new indexing
      rebuildAllHandles();
      buildAndRenderPayload();
    });

    marker.addTo(state.editLayerGroup);
    state.vertexMarkers[index] = marker;
  }

  function addMidMarkerBetween(i, j) {
    // i and j are consecutive vertex indices (wrap allowed)
    const ring = getRingLatLngs(state.drawnLayer);
    const a = ring[i], b = ring[j];
    const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    const m = L.marker(mid, {
      draggable: false,
      icon: L.divIcon({
        className: "",
        iconSize: [MID_SIZE, MID_SIZE],
        html: `<div style="
          width:${MID_SIZE}px;height:${MID_SIZE}px;
          background:#fff;border:2px solid #9ca3af;border-radius:999px;
          box-shadow:0 1px 2px rgba(0,0,0,.2);
        " title="Add vertex"></div>`,
      }),
      zIndexOffset: 900,
    });

    // Insert new vertex on click
    m.on("click", () => {
      const ring2 = getRingLatLngs(state.drawnLayer);
      // insert at j (between i and j)
      ring2.splice(j, 0, m.getLatLng());
      setRingLatLngs(state.drawnLayer, ring2);
      rebuildAllHandles();
      buildAndRenderPayload();
    });

    m.addTo(state.editLayerGroup);
    state.midMarkers.push({ marker: m, i, j });
  }

  function addAllMidMarkers() {
    const ring = getRingLatLngs(state.drawnLayer);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      addMidMarkerBetween(i, j);
    }
  }

  function refreshAdjacentMidMarkers(index) {
    // Remove and re-add mid markers adjacent to vertex index (index-1,index) and (index,index+1)
    if (!state.editLayerGroup) return;
    // Clear all mids and rebuild (cheap and simple for hackathon)
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.midMarkers = [];
    addAllMidMarkers();
  }

  function rebuildAllHandles() {
    // Remove all handles then recreate with correct indices
    if (!state.editLayerGroup) return;
    state.vertexMarkers.forEach((m) => m.remove());
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.vertexMarkers = [];
    state.midMarkers = [];

    const ring = getRingLatLngs(state.drawnLayer);
    ring.forEach((latlng, i) => addVertexMarker(latlng, i));
    addAllMidMarkers();
    liveUpdateStats();
  }

  function liveUpdateStats() {
    const ring = getRingLatLngs(state.drawnLayer);
    renderStats(ring);
    // Preview payload but keep same fence_id until send
    const previewPayload = buildPayload(ring, state.fenceName);
    dom.jsonPreview.value = JSON.stringify(previewPayload, null, 2);
  }

  // ====== G) Geometry, Validation, Stats ======
  function getRingLatLngs(layer) {
    // Returns OPEN ring (no duplicated last)
    if (!layer) return [];
    const rings = layer.getLatLngs();
    const firstRing = Array.isArray(rings[0]) ? rings[0] : rings;
    // Leaflet stores LatLng with {lat, lng}
    return firstRing.map((p) => L.latLng(p.lat, p.lng));
  }

  function setRingLatLngs(layer, ring) {
    // Set an OPEN ring; Leaflet draws it closed
    layer.setLatLngs([ring]);
    layer.redraw();
  }

  function validateCoords(coords) {
    if (!coords || coords.length < 3) return { ok: false, reason: "Need ≥ 3 vertices." };
    if (coords.length > MAX_VERTICES) {
      return { ok: false, reason: `Too many vertices (>${MAX_VERTICES}).` };
    }
    const uniq = new Set(coords.map((c) => `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`));
    if (uniq.size < 3) return { ok: false, reason: "Vertices too close/duplicate." };
    return { ok: true };
  }

  function toClosedRingLonLat(coords) {
    // Accepts array of L.LatLng; returns [[lon,lat], ... closed]
    const ring = coords.map((c) => [round6(c.lng), round6(c.lat)]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return ring;
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  function computeStats(coords) {
    if (!coords || coords.length < 3) {
      return { vertices: 0, perimeter_m: 0, area_m2: 0 };
    }
    const ring = toClosedRingLonLat(coords);
    let perimeter = 0;
    for (let i = 1; i < ring.length; i++) {
      perimeter += haversineMeters(ring[i - 1][1], ring[i - 1][0], ring[i][1], ring[i][0]); // lat,lon
    }
    const area = polygonAreaWebMercator(ring);
    return { vertices: ring.length - 1, perimeter_m: perimeter, area_m2: Math.abs(area) };
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function lonLatToWebMercator(lon, lat) {
    const R = 6378137.0;
    const x = (lon * Math.PI) / 180 * R;
    const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
    return [x, y];
  }

  function polygonAreaWebMercator(ringLonLat) {
    const pts = ringLonLat.map(([lon, lat]) => lonLatToWebMercator(lon, lat));
    let sum = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2; // m^2
  }

  // ====== H) Payload ======
  function buildPayload(coords, name) {
    const ring = toClosedRingLonLat(coords);
    return {
      spec_version: "1.0",
      fence_id: `ui-${uuidv4()}`,
      created_at: new Date().toISOString(),
      crs: "EPSG:4326",
      shape: { type: "Polygon", coordinates: [ring] },
      properties: { name: name || "", notes: "Drawn on tablet" },
    };
  }

  function buildAndRenderPayload() {
    if (!state.drawnLayer) {
      state.geojson = null;
      dom.btnSend.disabled = true;
      renderStats();
      renderJsonPreview();
      return;
    }
    const coords = getRingLatLngs(state.drawnLayer);
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

  // ====== I) Networking & Queue ======
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
        headers: { "Content-Type": "application/json" },
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
    try { localStorage.setItem("geofenceQueue", JSON.stringify(state.queue)); } catch (_) {}
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

  // ====== J) UI Wiring ======
  function bindUI() {
    dom.btnDraw.addEventListener("click", () => startDrawing());

    dom.btnEdit.addEventListener("click", () => {
      if (!state.drawnLayer) return;
      if (state.mode === "editing") exitCustomEditMode(true);
      else enterCustomEditMode();
    });

    dom.btnClear.addEventListener("click", () => {
      if (state.mode === "editing") exitCustomEditMode(true);
      clearPolygon();
    });

    dom.btnRecenter.addEventListener("click", recenter);

    dom.btnSend.addEventListener("click", sendGeofence);

    dom.btnRetryQueue.addEventListener("click", retryQueue);

    dom.fenceName.addEventListener("input", (e) => {
      state.fenceName = e.target.value || "";
      if (state.drawnLayer) buildAndRenderPayload();
    });

    dom.infoSheet.querySelector(".sheet__handle").addEventListener("click", () => {
      dom.infoSheet.classList.toggle("open");
    });
  }

  function renderButtons() {
    const hasPoly = !!state.drawnLayer;
    dom.btnEdit.disabled = !hasPoly;
    dom.btnClear.disabled = !hasPoly;

    if (state.mode === "editing") dom.btnEdit.textContent = "Done";
    else dom.btnEdit.textContent = "Edit";

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
    if (!coords && state.drawnLayer) coords = getRingLatLngs(state.drawnLayer);
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
    setTimeout(() => el.classList.remove("show"), ms);
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

  // ====== K) Utils ======
  function uuidv4() {
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
