// app.js — Geofence UI (Custom Draw + Stable Geolocate)
// - Custom "draw mode" with square vertex handles & midpoint insert during initial draw
// - Auto-center only once on first GPS fix (no recenter during drawing)
// - Live stats + JSON preview while drawing, and after finishing
// - Same send/queue logic as before

(() => {
  // ====== A) Config ======
  const APP_VERSION = "0.3.0";
  const API_URL = "http://172.31.23.188:5001/api/geofence"; // ← set your Python endpoint, e.g. "https://example.com/geofences"
  const ENABLE_OFFLINE_QUEUE = true;

  const MAP_DEFAULT_CENTER = [38.8895, -77.0352]; // DC Mall fallback
  const MAP_DEFAULT_ZOOM = 13;
  const MAX_VERTICES = 200;

  // Handle sizes for custom modes
  const VERT_SIZE = 14;   // px (square vertex)
  const MID_SIZE  = 10;   // px (round midpoint)

  // ====== B) State & DOM ======
  const state = {
    leafletMap: null,
    drawnItems: null,       // FeatureGroup for final polygon
    drawnLayer: null,       // Final polygon layer (once "finished")
    mode: "idle",           // idle | drawing | editing | ready | sending | success | error

    // Geolocation behavior
    currentPosition: null,  // {lat, lon, accuracy}
    didInitialCenter: false,
    userMovedMap: false,

    // Payload + queue
    fenceName: "",
    geojson: null,
    queue: [],
    online: navigator.onLine,

    // Custom edit/draw UI
    editLayerGroup: null,   // LayerGroup to hold vertex/midpoint markers
    vertexMarkers: [],
    midMarkers: [],

    // Custom draw mode
    drawRing: [],           // Array<LatLng> while drawing
    drawTempPolygon: null,  // L.Polygon preview while drawing
  };

  const dom = {
    appVersion:    document.getElementById("appVersion"),
    map:           document.getElementById("map"),
    btnDraw:       document.getElementById("btnDraw"),
    btnEdit:       document.getElementById("btnEdit"),
    btnClear:      document.getElementById("btnClear"),
    btnRecenter:   document.getElementById("btnRecenter"),
    btnSend:       document.getElementById("btnSend"),
    btnRetryQueue: document.getElementById("btnRetryQueue"),
    fenceName:     document.getElementById("fenceName"),
    infoSheet:     document.getElementById("infoSheet"),
    jsonPreview:   document.getElementById("jsonPreview"),
    statusToast:   document.getElementById("statusToast"),
    statVertices:  document.getElementById("statVertices"),
    statPerimeter: document.getElementById("statPerimeter"),
    statArea:      document.getElementById("statArea"),
  };

  // ====== C) Boot ======
  window.addEventListener("DOMContentLoaded", init);

  function init() {
    dom.appVersion && (dom.appVersion.textContent = `v${APP_VERSION}`);
    bindUI();
    loadQueue();
    initMap();
    tryGeolocate(); // will auto-center only once if user hasn't moved the map

    renderButtons();
    renderSheet(false);
    renderStats();
    renderJsonPreview();

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (!state.online) onOffline();
  }

  // ====== D) Map ======
  function initMap() {
    const map = L.map(dom.map, { zoomControl: true });
    state.leafletMap = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 19,
    }).addTo(map);

    map.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);

    // Track user interaction so auto-center won't kick in later
    map.on("movestart", () => { state.userMovedMap = true; });

    // Feature group for the final polygon
    const drawnItems = new L.FeatureGroup();
    state.drawnItems = drawnItems;
    map.addLayer(drawnItems);
  }

  // ====== E) Geolocation (stable behavior) ======
  function tryGeolocate() {
    if (!("geolocation" in navigator)) {
      toast("Geolocation unsupported; using default view.", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        state.currentPosition = { lat: latitude, lon: longitude, accuracy };

        // Auto-center ONLY ONCE and ONLY if user hasn't moved the map yet
        if (!state.didInitialCenter && !state.userMovedMap) {
          state.leafletMap.setView([latitude, longitude], 16);
          L.circle([latitude, longitude], {
            radius: Math.min(accuracy || 0, 60),
            weight: 1, opacity: 0.6, fillOpacity: 0.08,
          }).addTo(state.leafletMap);
          state.didInitialCenter = true;
        }
      },
      (err) => {
        console.warn("Geolocation error:", err);
        toast("Couldn’t get GPS; using default view.", "error");
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

  // ====== F) Custom DRAW MODE (shows boxes while placing points) ======
  function startCustomDraw() {
    // Prevent later auto-center from yanking the view mid-draw
    state.userMovedMap = true;

    // If a polygon exists, clear it for a fresh draw
    if (state.drawnLayer) clearPolygon();

    // Build layers for handles + preview polygon
    cleanupEditLayer();
    state.editLayerGroup = L.layerGroup().addTo(state.leafletMap);
    state.vertexMarkers = [];
    state.midMarkers = [];
    state.drawRing = [];

    if (state.drawTempPolygon) {
      state.drawTempPolygon.remove();
      state.drawTempPolygon = null;
    }
    state.drawTempPolygon = L.polygon([], {
      color: "#3b82f6", weight: 2, fillOpacity: 0.08,
    }).addTo(state.leafletMap);

    // Map interactions for drawing
    state.leafletMap.on("click", onMapClickAddVertex);
    state.leafletMap.on("dblclick", finishCustomDraw); // quick finish via double click/tap
    // Avoid Leaflet's default zoom on double click while drawing
    state.leafletMap.doubleClickZoom.disable();

    state.mode = "drawing";
    renderButtons();
    renderSheet(true);
    toast("Tap to add vertices. Double-tap or press Finish to complete.", "success", 3500);
  }

  function onMapClickAddVertex(e) {
    const latlng = e.latlng;
    state.drawRing.push(latlng);
    addVertexMarker(latlng, state.drawRing.length - 1, /*forDraw=*/true);
    refreshDrawPreviewAndMids();
    liveUpdateStatsFromRing(state.drawRing);
  }

  function refreshDrawPreviewAndMids() {
    // Update preview polygon
    state.drawTempPolygon.setLatLngs([state.drawRing]);

    // Rebuild midpoints between each consecutive pair
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.midMarkers = [];
    for (let i = 0; i < state.drawRing.length; i++) {
      const j = (i + 1) % state.drawRing.length;
      if (state.drawRing.length >= 2) addMidMarkerBetween(i, j, /*forDraw=*/true);
    }
  }

  function finishCustomDraw() {
    if (state.mode !== "drawing") return;
    if (state.drawRing.length < 3) {
      toast("Need at least 3 vertices to finish.", "error");
      return;
    }

    // Detach drawing events
    state.leafletMap.off("click", onMapClickAddVertex);
    state.leafletMap.off("dblclick", finishCustomDraw);
    state.leafletMap.doubleClickZoom.enable();

    // Remove temp preview polygon; create final polygon layer
    if (state.drawTempPolygon) {
      state.drawTempPolygon.remove();
      state.drawTempPolygon = null;
    }

    const finalPoly = L.polygon(state.drawRing, {
      color: "#3b82f6", weight: 2, fillOpacity: 0.08,
    });
    state.drawnItems.addLayer(finalPoly);
    state.drawnLayer = finalPoly;

    // Switch into our custom EDIT mode so handles stay visible & usable
    enterCustomEditMode(/*fromDraw=*/true);
    buildAndRenderPayload();
  }

  // ====== G) Custom EDIT MODE (same feel for draw & edit) ======
  function enterCustomEditMode(fromDraw = false) {
    if (!state.drawnLayer) return;

    cleanupEditLayer();
    state.editLayerGroup = L.layerGroup().addTo(state.leafletMap);
    state.vertexMarkers = [];
    state.midMarkers = [];

    const ring = getRingLatLngs(state.drawnLayer);
    ring.forEach((latlng, i) => addVertexMarker(latlng, i, /*forDraw=*/false));
    addAllMidMarkers(/*forDraw=*/false);

    state.mode = "editing";
    renderButtons();
    if (!fromDraw) {
      toast("Drag squares to move. Tap a square to remove. Tap a dot to insert.", "success", 3400);
    }
  }

  function exitCustomEditMode(save = true) {
    if (save && state.drawnLayer) {
      buildAndRenderPayload();
      state.mode = "ready";
    } else {
      state.mode = state.drawnLayer ? "ready" : "idle";
    }
    cleanupEditLayer();
    renderButtons();
  }

  function cleanupEditLayer() {
    if (state.editLayerGroup) {
      state.editLayerGroup.remove();
      state.editLayerGroup = null;
    }
    state.vertexMarkers = [];
    state.midMarkers = [];
  }

  // --- Handles (shared by draw & edit) ---
  function addVertexMarker(latlng, index, forDraw) {
    const marker = L.marker(latlng, {
      draggable: true,
      icon: L.divIcon({
        className: "",
        iconSize: [VERT_SIZE, VERT_SIZE],
        html: `<div style="
          width:${VERT_SIZE}px;height:${VERT_SIZE}px;
          background:#fff;border:2px solid #3b82f6;border-radius:4px;
          box-shadow:0 1px 3px rgba(0,0,0,.25);
        "></div>`,
      }),
      zIndexOffset: 1000,
    });

    let dragged = false;

    marker.on("dragstart", () => { dragged = false; });

    marker.on("drag", (e) => {
      dragged = true;
      const newLL = e.target.getLatLng();

      if (state.mode === "drawing" && forDraw) {
        state.drawRing[index] = newLL;
        refreshDrawPreviewAndMids();
        liveUpdateStatsFromRing(state.drawRing);
      } else if (state.drawnLayer) {
        const ring = getRingLatLngs(state.drawnLayer);
        ring[index] = newLL;
        setRingLatLngs(state.drawnLayer, ring);
        refreshAdjacentMidMarkers(index);
        liveUpdateStatsFromRing(ring);
      }
      state.vertexMarkers[index].setLatLng(newLL);
    });

    marker.on("dragend", () => {
      if (state.mode !== "drawing") buildAndRenderPayload();
    });

    marker.on("click", () => {
      if (dragged) return; // ignore click after drag
      // Remove vertex (guard ≥3)
      if (state.mode === "drawing" && forDraw) {
        if (state.drawRing.length <= 3) return toast("Need ≥ 3 vertices.", "error");
        state.drawRing.splice(index, 1);
        rebuildHandlesForCurrentMode();
      } else if (state.drawnLayer) {
        const ring = getRingLatLngs(state.drawnLayer);
        if (ring.length <= 3) return toast("Need ≥ 3 vertices.", "error");
        ring.splice(index, 1);
        setRingLatLngs(state.drawnLayer, ring);
        rebuildHandlesForCurrentMode();
        buildAndRenderPayload();
      }
    });

    marker.addTo(state.editLayerGroup);
    state.vertexMarkers[index] = marker;
  }

  function addMidMarkerBetween(i, j, forDraw) {
    const ring = (state.mode === "drawing" && forDraw) ? state.drawRing : getRingLatLngs(state.drawnLayer);
    const a = ring[i], b = ring[j];
    const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    const m = L.marker(mid, {
      draggable: false,
      icon: L.divIcon({
        className: "",
        iconSize: [MID_SIZE, MID_SIZE],
        html: `<div style="
          width:${MID_SIZE}px;height:${MID_SIZE}px;
          background:#fff;border:2px solid #9aa3af;border-radius:999px;
          box-shadow:0 1px 2px rgba(0,0,0,.2);
        " title="Add vertex here"></div>`,
      }),
      zIndexOffset: 900,
    });

    m.on("click", () => {
      if (state.mode === "drawing" && forDraw) {
        state.drawRing.splice(j, 0, m.getLatLng());
        rebuildHandlesForCurrentMode();
        liveUpdateStatsFromRing(state.drawRing);
      } else if (state.drawnLayer) {
        const ring2 = getRingLatLngs(state.drawnLayer);
        ring2.splice(j, 0, m.getLatLng());
        setRingLatLngs(state.drawnLayer, ring2);
        rebuildHandlesForCurrentMode();
        buildAndRenderPayload();
      }
    });

    m.addTo(state.editLayerGroup);
    state.midMarkers.push({ marker: m, i, j });
  }

  function addAllMidMarkers(forDraw) {
    const ring = (state.mode === "drawing" && forDraw) ? state.drawRing : getRingLatLngs(state.drawnLayer);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      addMidMarkerBetween(i, j, forDraw);
    }
  }

  function refreshAdjacentMidMarkers(index) {
    // Simpler + safe: rebuild all mid markers
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.midMarkers = [];
    addAllMidMarkers(/*forDraw=*/false);
  }

  function rebuildHandlesForCurrentMode() {
    if (!state.editLayerGroup) return;

    // Clear all handle markers
    state.vertexMarkers.forEach((m) => m.remove());
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.vertexMarkers = [];
    state.midMarkers = [];

    if (state.mode === "drawing") {
      state.drawRing.forEach((ll, i) => addVertexMarker(ll, i, /*forDraw=*/true));
      addAllMidMarkers(/*forDraw=*/true);
      // Update preview polygon geometry too
      if (state.drawTempPolygon) state.drawTempPolygon.setLatLngs([state.drawRing]);
    } else if (state.drawnLayer) {
      const ring = getRingLatLngs(state.drawnLayer);
      ring.forEach((ll, i) => addVertexMarker(ll, i, /*forDraw=*/false));
      addAllMidMarkers(/*forDraw=*/false);
    }
  }

  // ====== H) Geometry, Stats, Payload ======
  function getRingLatLngs(layer) {
    if (!layer) return [];
    const rings = layer.getLatLngs();
    const firstRing = Array.isArray(rings[0]) ? rings[0] : rings;
    return firstRing.map((p) => L.latLng(p.lat, p.lng)); // OPEN ring (Leaflet closes visually)
  }

  function setRingLatLngs(layer, ring) {
    layer.setLatLngs([ring]); layer.redraw();
  }

  function validateCoordsLL(ringLL) {
    if (!ringLL || ringLL.length < 3) return { ok: false, reason: "Need ≥ 3 vertices." };
    if (ringLL.length > MAX_VERTICES) return { ok: false, reason: `Too many vertices (>${MAX_VERTICES}).` };
    const uniq = new Set(ringLL.map((c) => `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`));
    if (uniq.size < 3) return { ok: false, reason: "Vertices too close/duplicate." };
    return { ok: true };
  }

  function toClosedRingLonLat(ringLL) {
    const ring = ringLL.map((c) => [round6(c.lng), round6(c.lat)]);
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
    return ring;
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  function computeStatsLL(ringLL) {
    if (!ringLL || ringLL.length < 3) return { vertices: 0, perimeter_m: 0, area_m2: 0 };
    const ring = toClosedRingLonLat(ringLL);
    let per = 0;
    for (let i = 1; i < ring.length; i++) {
      per += haversineMeters(ring[i - 1][1], ring[i - 1][0], ring[i][1], ring[i][0]);
    }
    const area = polygonAreaWebMercator(ring);
    return { vertices: ring.length - 1, perimeter_m: per, area_m2: Math.abs(area) };
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371008.8, toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function lonLatToWebMercator(lon, lat) {
    const R = 6378137.0;
    return [(lon * Math.PI) / 180 * R, Math.log(Math.tan(Math.PI/4 + (lat * Math.PI)/360)) * R];
  }

  function polygonAreaWebMercator(ringLonLat) {
    const pts = ringLonLat.map(([lon, lat]) => lonLatToWebMercator(lon, lat));
    let sum = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  }

  function buildPayloadFromLL(ringLL, name) {
    const ring = toClosedRingLonLat(ringLL);
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
    const ringLL = getRingLatLngs(state.drawnLayer);
    const val = validateCoordsLL(ringLL);
    if (!val.ok) {
      state.geojson = null;
      dom.btnSend.disabled = true;
      renderStats();
      renderJsonPreview(val.reason);
      return;
    }
    state.geojson = buildPayloadFromLL(ringLL, state.fenceName);
    dom.btnSend.disabled = false;
    renderStats(ringLL);
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
    } finally { setBusy(false); }
  }

  function enqueue(payload, last_error = "") {
    state.queue.push({
      id: `q-${uuidv4()}`,
      payload,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
      last_error,
    });
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
    const pending = [];
    for (const item of state.queue) {
      try {
        const r = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload),
        });
        if (!r.ok) throw new Error(`Server ${r.status}`);
      } catch (e) {
        item.attempts += 1;
        item.last_error = String(e.message || e);
        pending.push(item);
      }
    }
    state.queue = pending;
    saveQueue();
    setBusy(false);

    if (pending.length) {
      toast(`Some items still queued (${pending.length}).`, "error");
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
    } catch (_) { state.queue = []; }
  }

  // ====== J) UI Wiring ======
  function bindUI() {
    dom.btnDraw.addEventListener("click", () => {
      if (state.mode === "drawing") finishCustomDraw();
      else startCustomDraw();
    });

    dom.btnEdit.addEventListener("click", () => {
      if (!state.drawnLayer) return;
      if (state.mode === "editing") exitCustomEditMode(true);
      else enterCustomEditMode();
    });

    dom.btnClear.addEventListener("click", () => {
      if (state.mode === "editing") exitCustomEditMode(true);
      if (state.mode === "drawing") cancelCustomDraw();
      clearPolygon();
    });

    dom.btnRecenter.addEventListener("click", recenter);
    dom.btnSend.addEventListener("click", sendGeofence);
    dom.btnRetryQueue.addEventListener("click", retryQueue);

    dom.fenceName.addEventListener("input", (e) => {
      state.fenceName = e.target.value || "";
      if (state.drawnLayer) buildAndRenderPayload();
      else if (state.mode === "drawing") liveUpdateStatsFromRing(state.drawRing);
    });

    dom.infoSheet.querySelector(".sheet__handle").addEventListener("click", () => {
      dom.infoSheet.classList.toggle("open");
    });
  }

  function cancelCustomDraw() {
    // Leave draw mode without finalizing
    state.leafletMap.off("click", onMapClickAddVertex);
    state.leafletMap.off("dblclick", finishCustomDraw);
    state.leafletMap.doubleClickZoom.enable();
    if (state.drawTempPolygon) { state.drawTempPolygon.remove(); state.drawTempPolygon = null; }
    state.drawRing = [];
    cleanupEditLayer();
    state.mode = "idle";
    renderButtons();
    renderStats();
    renderJsonPreview();
  }

  function clearPolygon() {
    cleanupEditLayer();
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

  function renderButtons() {
    const hasPoly = !!state.drawnLayer;

    // Draw button toggles between Draw/Finish in draw mode
    dom.btnDraw.textContent = (state.mode === "drawing") ? "Finish" : "Draw";

    dom.btnEdit.disabled  = !hasPoly || state.mode === "drawing";
    dom.btnClear.disabled = !hasPoly && state.mode !== "drawing";

    dom.btnEdit.textContent = (state.mode === "editing") ? "Done" : "Edit";
    dom.btnSend.disabled = !state.geojson || state.mode === "sending";
  }

  function renderSheet(open) {
    if (open) dom.infoSheet.classList.add("open");
    else      dom.infoSheet.classList.remove("open");
  }

  function renderJsonPreview(errorMsg) {
    if (errorMsg) { dom.jsonPreview.value = `// ${errorMsg}`; return; }
    dom.jsonPreview.value = state.geojson
      ? JSON.stringify(state.geojson, null, 2)
      : "// Draw a polygon to see the payload…";
  }

  function renderStats(ringLL) {
    if (!ringLL || ringLL.length < 3) {
      dom.statVertices.textContent  = "0";
      dom.statPerimeter.textContent = "—";
      dom.statArea.textContent      = "—";
      return;
    }
    const { vertices, perimeter_m, area_m2 } = computeStatsLL(ringLL);
    dom.statVertices.textContent  = String(vertices);
    dom.statPerimeter.textContent = formatMeters(perimeter_m);
    dom.statArea.textContent      = formatSquareMeters(area_m2);
  }

  function liveUpdateStatsFromRing(ringLL) {
    if (!ringLL || ringLL.length < 3) {
      renderStats(); // clears
      // Live JSON preview even in draw mode (preview-only; not saved to state.geojson)
      const msg = "// Add at least 3 vertices to preview payload…";
      dom.jsonPreview.value = msg;
      return;
    }
    renderStats(ringLL);
    const preview = buildPayloadFromLL(ringLL, state.fenceName);
    dom.jsonPreview.value = JSON.stringify(preview, null, 2);
  }

  function setBusy(isBusy) { document.body.classList.toggle("is-disabled", isBusy); }

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
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
    return [h.slice(0,4).join(""),h.slice(4,6).join(""),h.slice(6,8).join(""),h.slice(8,10).join(""),h.slice(10,16).join("")].join("-");
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
