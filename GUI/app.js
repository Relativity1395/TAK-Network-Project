// app.js — Geofence UI (Startup GPS + Auto GPS + Queue Manager)
// - Centers on current GPS at startup
// - "Update GPS" button re-acquires and recenters
// - "Auto GPS" toggle uses watchPosition (pauses during draw/edit)
// - Queue panel: list, Load for editing (handles), Save, Send, Remove

(() => {
  // ====== A) Config ======
  const APP_VERSION = "0.4.0";
  const API_URL = "http://54.152.250.137:5001/api/geofence"; // ← set your Python endpoint, e.g. "https://example.com/geofences"
  const ENABLE_OFFLINE_QUEUE = true;

  const MAP_DEFAULT_CENTER = [38.8895, -77.0352]; // only used if GPS fails
  const MAP_DEFAULT_ZOOM = 13;
  const MAX_VERTICES = 200;

  const VERT_SIZE = 14;   // px (square vertex)
  const MID_SIZE  = 10;   // px (round midpoint)

  // ====== B) State & DOM ======
  const state = {
    leafletMap: null,
    drawnItems: null,       // FeatureGroup for final polygon
    drawnLayer: null,       // Final polygon layer
    mode: "idle",           // idle | drawing | editing | ready | sending | success | error

    // Geolocation
    currentPosition: null,  // {lat, lon, accuracy}
    locCircle: null,        // accuracy circle
    gpsWatchId: null,       // watchPosition id
    userMovedMap: false,    // prevent unwanted auto recenters while user pans

    // Payload + queue
    fenceName: "",
    geojson: null,
    queue: [],
    loadedQueueId: null,    // id of queue item currently loaded for edit
    online: navigator.onLine,

    // Custom edit/draw UI
    editLayerGroup: null,
    vertexMarkers: [],
    midMarkers: [],

    // Custom draw mode
    drawRing: [],           // Array<LatLng> while drawing
    drawTempPolygon: null,
  };

  const dom = {
    appVersion:    document.getElementById("appVersion"),
    map:           document.getElementById("map"),

    btnDraw:       document.getElementById("btnDraw"),
    btnEdit:       document.getElementById("btnEdit"),
    btnClear:      document.getElementById("btnClear"),
    btnRecenter:   document.getElementById("btnRecenter"), // will be retitled to "Update GPS"
    btnSend:       document.getElementById("btnSend"),
    btnQueue:      document.getElementById("btnRetryQueue"), // repurposed as "Queue"
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
    if (dom.appVersion) dom.appVersion.textContent = `v${APP_VERSION}`;

    // Rename buttons for clarity
    dom.btnRecenter.textContent = "Update GPS";
    dom.btnQueue.textContent = "Queue";

    // Inject Auto GPS toggle into the toolbar
    injectAutoGpsToggle();

    bindUI();
    loadQueue();

    initMap();

    // Immediately try to geolocate and center on startup
    acquireAndCenterGPS(true);

    renderButtons();
    renderSheet(false);
    renderStats();
    renderJsonPreview();
    refreshQueueBadge();

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

    // If the user starts panning/zooming, don't auto-yank later
    map.on("movestart", () => { state.userMovedMap = true; });

    // Feature group for the final polygon
    state.drawnItems = new L.FeatureGroup();
    map.addLayer(state.drawnItems);
  }

  // ====== E) Geolocation ======
  function acquireAndCenterGPS(showToastOnFail = false) {
    if (!("geolocation" in navigator)) {
      if (showToastOnFail) toast("Geolocation unsupported; using default view.", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        state.currentPosition = { lat: latitude, lon: longitude, accuracy };
        centerMapOnCurrentPos(true);
      },
      (err) => {
        console.warn("Geolocation error:", err);
        if (showToastOnFail) toast("Couldn’t get GPS; using default view.", "error");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }

  function centerMapOnCurrentPos(force = false) {
    if (!state.currentPosition) return;
    // Do not recenter while drawing/editing unless forced (explicit Update GPS)
    if (!force && (state.mode === "drawing" || state.mode === "editing")) return;

    const { lat, lon, accuracy } = state.currentPosition;
    state.leafletMap.setView([lat, lon], Math.max(state.leafletMap.getZoom(), 16));

    // Draw/update accuracy circle
    if (!state.locCircle) {
      state.locCircle = L.circle([lat, lon], {
        radius: Math.min(accuracy || 0, 60),
        weight: 1, opacity: 0.6, fillOpacity: 0.08,
      }).addTo(state.leafletMap);
    } else {
      state.locCircle.setLatLng([lat, lon]);
      state.locCircle.setRadius(Math.min(accuracy || 0, 60));
    }
  }

  function updateGPS() {
    // Explicit re-acquire + recenter (even during draw/edit)
    acquireAndCenterGPS(true);
  }

  function startAutoGPS() {
    if (!("geolocation" in navigator)) {
      toast("Auto GPS not supported on this device.", "error");
      return;
    }
    if (state.gpsWatchId !== null) navigator.geolocation.clearWatch(state.gpsWatchId);

    state.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.currentPosition = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        // Auto center only if not drawing/editing and user hasn't panned
        if (!state.userMovedMap && state.mode !== "drawing" && state.mode !== "editing") {
          centerMapOnCurrentPos(false);
        } else {
          // Still update the accuracy circle silently
          centerMapOnCurrentPos(false);
        }
      },
      (err) => {
        console.warn("watchPosition error:", err);
        toast("Auto GPS error.", "error");
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
    toast("Auto GPS on.", "success");
  }

  function stopAutoGPS() {
    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
      state.gpsWatchId = null;
      toast("Auto GPS off.", "success");
    }
  }

  // ====== F) Custom DRAW MODE (shows handles while placing) ======
  function startCustomDraw() {
    state.userMovedMap = true; // don't auto yank while drawing

    if (state.drawnLayer) clearPolygon();

    cleanupEditLayer();
    state.editLayerGroup = L.layerGroup().addTo(state.leafletMap);
    state.vertexMarkers = [];
    state.midMarkers = [];
    state.drawRing = [];

    if (state.drawTempPolygon) {
      state.drawTempPolygon.remove(); state.drawTempPolygon = null;
    }
    state.drawTempPolygon = L.polygon([], {
      color: "#3b82f6", weight: 2, fillOpacity: 0.08,
    }).addTo(state.leafletMap);

    state.leafletMap.on("click", onMapClickAddVertex);
    state.leafletMap.on("dblclick", finishCustomDraw);
    state.leafletMap.doubleClickZoom.disable();

    state.mode = "drawing";
    renderButtons();
    renderSheet(true);
    toast("Tap to add vertices. Double-tap or press Finish.", "success", 3200);
  }

  function onMapClickAddVertex(e) {
    const latlng = e.latlng;
    state.drawRing.push(latlng);
    addVertexMarker(latlng, state.drawRing.length - 1, /*forDraw=*/true);
    refreshDrawPreviewAndMids();
    liveUpdateStatsFromRing(state.drawRing);
  }

  function refreshDrawPreviewAndMids() {
    state.drawTempPolygon.setLatLngs([state.drawRing]);
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.midMarkers = [];
    for (let i = 0; i < state.drawRing.length; i++) {
      const j = (i + 1) % state.drawRing.length;
      if (state.drawRing.length >= 2) addMidMarkerBetween(i, j, /*forDraw=*/true);
    }
  }

  function finishCustomDraw() {
    if (state.mode !== "drawing") return;
    if (state.drawRing.length < 3) return toast("Need at least 3 vertices.", "error");

    // Stop draw listeners
    state.leafletMap.off("click", onMapClickAddVertex);
    state.leafletMap.off("dblclick", finishCustomDraw);
    state.leafletMap.doubleClickZoom.enable();

    if (state.drawTempPolygon) { state.drawTempPolygon.remove(); state.drawTempPolygon = null; }

    const finalPoly = L.polygon(state.drawRing, { color: "#3b82f6", weight: 2, fillOpacity: 0.08 });
    state.drawnItems.addLayer(finalPoly);
    state.drawnLayer = finalPoly;

    enterCustomEditMode(/*fromDraw=*/true);
    buildAndRenderPayload();
  }

  function cancelCustomDraw() {
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

  // ====== G) Custom EDIT MODE ======
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
    if (!fromDraw) toast("Drag squares to move. Tap a square to remove. Tap a dot to insert.", "success", 3200);
  }

  function exitCustomEditMode(save = true) {
    if (save && state.drawnLayer) {
      buildAndRenderPayload();
      // If we’re editing a loaded queue item, keep UI hint visible in queue panel
    }
    state.mode = state.drawnLayer ? "ready" : "idle";
    cleanupEditLayer();
    renderButtons();
  }

  function cleanupEditLayer() {
    if (state.editLayerGroup) { state.editLayerGroup.remove(); state.editLayerGroup = null; }
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
      if (dragged) return;
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
        " title="Add vertex"></div>`,
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

  function refreshAdjacentMidMarkers() {
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.midMarkers = [];
    addAllMidMarkers(/*forDraw=*/false);
  }

  function rebuildHandlesForCurrentMode() {
    if (!state.editLayerGroup) return;
    state.vertexMarkers.forEach((m) => m.remove());
    state.midMarkers.forEach(({ marker }) => marker.remove());
    state.vertexMarkers = [];
    state.midMarkers = [];

    if (state.mode === "drawing") {
      state.drawRing.forEach((ll, i) => addVertexMarker(ll, i, /*forDraw=*/true));
      addAllMidMarkers(/*forDraw=*/true);
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
    return firstRing.map((p) => L.latLng(p.lat, p.lng));
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

  function buildPayloadFromLL(ringLL, name, baseFenceId = null) {
    const ring = toClosedRingLonLat(ringLL);
    return {
      spec_version: "1.0",
      fence_id: baseFenceId || `ui-${uuidv4()}`,
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
    // If editing a queue item, preserve its fence_id
    const baseId = getLoadedQueueFenceId();
    state.geojson = buildPayloadFromLL(ringLL, state.fenceName, baseId);
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

      // If this was a loaded queue item, remove it from queue
      if (state.loadedQueueId) {
        removeQueuedItemById(state.loadedQueueId);
        state.loadedQueueId = null;
      }

      state.mode = "success";
      renderButtons();
      refreshQueueBadge();
    } catch (err) {
      console.error(err);
      if (ENABLE_OFFLINE_QUEUE) {
        enqueue(state.geojson, String(err.message || err));
        toast("Send failed. Saved to queue.", "error");
        refreshQueueBadge();
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

  async function sendOneQueueItem(id) {
    const idx = state.queue.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const item = state.queue[idx];
    if (!API_URL) return toast("Set API_URL first.", "error");

    try {
      const r = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.payload),
      });
      if (!r.ok) throw new Error(`Server ${r.status}`);
      // success -> remove
      state.queue.splice(idx, 1);
      saveQueue();
      toast("Queued item sent.", "success");
      refreshQueuePanel(); refreshQueueBadge();
    } catch (e) {
      item.attempts += 1;
      item.last_error = String(e.message || e);
      saveQueue();
      toast("Send failed for that item.", "error");
      refreshQueuePanel(); refreshQueueBadge();
    }
  }

  function removeQueuedItemById(id) {
    const i = state.queue.findIndex((x) => x.id === id);
    if (i >= 0) {
      state.queue.splice(i, 1);
      saveQueue();
      refreshQueuePanel(); refreshQueueBadge();
    }
  }

  function saveQueue() {
    try { localStorage.setItem("geofenceQueue", JSON.stringify(state.queue)); } catch (_) {}
  }
  function loadQueue() {
    try {
      const raw = localStorage.getItem("geofenceQueue");
      if (raw) state.queue = JSON.parse(raw) || [];
    } catch (_) { state.queue = []; }
  }

  // ====== J) Queue Panel (view/edit/remove/load) ======
  function openQueuePanel() {
    ensureQueuePanel();
    dom.queuePanel.classList.remove("is-hidden");
    refreshQueuePanel();
    // Open the sheet if closed
    dom.infoSheet.classList.add("open");
  }

  function closeQueuePanel() {
    if (dom.queuePanel) dom.queuePanel.classList.add("is-hidden");
  }

  function refreshQueuePanel() {
    ensureQueuePanel();
    const list = dom.queueList;
    list.innerHTML = "";

    if (!state.queue.length) {
      list.innerHTML = `<div style="padding:8px;color:var(--muted);">Queue is empty.</div>`;
      return;
    }

    for (const item of state.queue) {
      const li = document.createElement("div");
      li.style.border = "1px solid var(--border)";
      li.style.borderRadius = "6px";
      li.style.padding = "8px";
      li.style.marginBottom = "8px";
      li.style.background = "var(--panel-2)";

      const name = item.payload?.properties?.name || "(unnamed)";
      const idShort = item.id.slice(0, 8);
      const pts = (item.payload?.shape?.coordinates?.[0]?.length || 1) - 1;

      li.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="display:grid;gap:2px;">
            <strong style="font-size:14px;">${escapeHTML(name)}</strong>
            <span style="font-size:12px;color:var(--muted);">ID ${idShort} • ${pts} pts • ${new Date(item.enqueued_at).toLocaleString()}</span>
            ${item.last_error ? `<span style="font-size:12px;color:var(--error);">Last error: ${escapeHTML(item.last_error)}</span>` : ""}
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost" data-act="load" data-id="${item.id}">Load</button>
            <button class="btn btn-ghost" data-act="send" data-id="${item.id}">Send</button>
            <button class="btn" style="border-color:var(--error);color:var(--error);" data-act="remove" data-id="${item.id}">X</button>
          </div>
        </div>
      `;
      list.appendChild(li);
    }
  }

  function ensureQueuePanel() {
    if (dom.queuePanel) return;

    const content = dom.infoSheet.querySelector(".sheet__content");
    const panel = document.createElement("div");
    panel.id = "queuePanel";
    panel.className = "sheet__row is-hidden";
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <h3 style="margin:0;font-size:16px;">Queue</h3>
        <div style="display:flex;gap:6px;">
          <button id="btnQueueRetryAll" class="btn btn-ghost" type="button">Retry all</button>
          <button id="btnQueueClose" class="btn" type="button">Close</button>
        </div>
      </div>
      <div id="queueList" style="margin-top:8px;"></div>
      <div id="queueSaveBar" class="is-hidden" style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;border-top:1px dashed var(--border);padding-top:8px;">
        <button id="btnQueueSaveChanges" class="btn btn-primary" type="button">Save changes to item</button>
      </div>
    `;
    content.appendChild(panel);

    dom.queuePanel = panel;
    dom.queueList = panel.querySelector("#queueList");
    dom.queueSaveBar = panel.querySelector("#queueSaveBar");
    dom.btnQueueRetryAll = panel.querySelector("#btnQueueRetryAll");
    dom.btnQueueClose = panel.querySelector("#btnQueueClose");
    dom.btnQueueSaveChanges = panel.querySelector("#btnQueueSaveChanges");

    // Delegated click handlers for list items
    dom.queueList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      if (act === "load") loadQueueItemToMap(id);
      else if (act === "send") sendOneQueueItem(id);
      else if (act === "remove") removeQueuedItemById(id);
    });

    dom.btnQueueRetryAll.addEventListener("click", retryAllQueued);
    dom.btnQueueClose.addEventListener("click", closeQueuePanel);
    dom.btnQueueSaveChanges.addEventListener("click", saveEditsBackToQueue);
  }

  function retryAllQueued() {
    if (!API_URL) return toast("Set API_URL first.", "error");
    if (!state.queue.length) return toast("Queue is empty.", "success");
    (async () => {
      for (const item of [...state.queue]) {
        await sendOneQueueItem(item.id);
      }
    })();
  }

  function loadQueueItemToMap(id) {
    const item = state.queue.find((x) => x.id === id);
    if (!item) return;

    // Build layer from payload and enter edit mode
    const ring = payloadToLatLngRing(item.payload);
    if (!ring.length) return toast("Invalid geometry in item.", "error");

    // Clear current polygon / draw state
    if (state.mode === "drawing") cancelCustomDraw();
    cleanupEditLayer();
    if (state.drawnLayer) {
      state.drawnItems.removeLayer(state.drawnLayer);
      state.drawnLayer = null;
    }

    const poly = L.polygon(ring, { color: "#3b82f6", weight: 2, fillOpacity: 0.08 });
    state.drawnItems.addLayer(poly);
    state.drawnLayer = poly;

    // Set name field
    state.fenceName.value = item.payload?.properties?.name || "";
    state.fenceName.dispatchEvent(new Event("input"));

    // Track which queue item is loaded
    state.loadedQueueId = id;

    enterCustomEditMode(false);
    buildAndRenderPayload();

    // Show Save bar in panel
    dom.queueSaveBar.classList.remove("is-hidden");
    dom.infoSheet.classList.add("open");
    toast("Loaded from queue. Edit via handles, then Save changes.", "success", 3200);
  }

  function saveEditsBackToQueue() {
    if (!state.loadedQueueId || !state.drawnLayer) {
      return toast("No loaded queue item.", "error");
    }
    const idx = state.queue.findIndex((x) => x.id === state.loadedQueueId);
    if (idx === -1) return toast("Queue item missing.", "error");

    const ringLL = getRingLatLngs(state.drawnLayer);
    const baseId = getLoadedQueueFenceId();
    const updated = buildPayloadFromLL(ringLL, state.fenceName.value || "", baseId);
    state.queue[idx].payload = updated;
    saveQueue();
    refreshQueuePanel();
    toast("Changes saved to queue item.", "success");
  }

  function payloadToLatLngRing(payload) {
    try {
      const ring = payload?.shape?.coordinates?.[0] || [];
      // Exclude closing duplicate if present
      const open = [];
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        if (i < ring.length - 1 || (lon !== ring[0][0] || lat !== ring[0][1])) {
          open.push(L.latLng(lat, lon));
        }
      }
      return open;
    } catch {
      return [];
    }
  }

  function getLoadedQueueFenceId() {
    if (!state.loadedQueueId) return null;
    const item = state.queue.find((x) => x.id === state.loadedQueueId);
    return item?.payload?.fence_id || null;
  }

  function refreshQueueBadge() {
    // Show/hide "Queue" button and maybe annotate count
    const n = state.queue.length;
    dom.btnQueue.hidden = false;
    dom.btnQueue.textContent = n ? `Queue (${n})` : "Queue";
  }

  // ====== K) UI Wiring ======
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
      state.loadedQueueId = null;
      if (dom.queueSaveBar) dom.queueSaveBar.classList.add("is-hidden");
    });

    dom.btnRecenter.addEventListener("click", updateGPS);
    dom.btnSend.addEventListener("click", sendGeofence);

    // Repurpose as Queue open button
    dom.btnQueue.hidden = false;
    dom.btnQueue.addEventListener("click", openQueuePanel);

    dom.fenceName.addEventListener("input", (e) => {
      state.fenceName = e.target.value || "";
      if (state.drawnLayer) buildAndRenderPayload();
      else if (state.mode === "drawing") liveUpdateStatsFromRing(state.drawRing);
    });

    dom.infoSheet.querySelector(".sheet__handle").addEventListener("click", () => {
      dom.infoSheet.classList.toggle("open");
    });
  }

  function injectAutoGpsToggle() {
    const toolbar = document.querySelector(".toolbar");
    if (!toolbar) return;
    const wrap = document.createElement("label");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "6px";
    wrap.style.marginLeft = "6px";
    wrap.innerHTML = `
      <input id="toggleAutoGPS" type="checkbox" style="width:18px;height:18px;">
      <span style="font-size:13px;color:var(--muted);">Auto&nbsp;GPS</span>
    `;
    toolbar.appendChild(wrap);

    const chk = wrap.querySelector("#toggleAutoGPS");
    chk.addEventListener("change", (e) => {
      if (e.target.checked) startAutoGPS();
      else stopAutoGPS();
    });
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
      renderStats();
      dom.jsonPreview.value = "// Add at least 3 vertices to preview payload…";
      return;
    }
    renderStats(ringLL);
    const baseId = getLoadedQueueFenceId();
    const preview = buildPayloadFromLL(ringLL, state.fenceName, baseId);
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
  }
  function onOffline() {
    state.online = false;
    toast("Offline. Sends will be queued.", "error");
  }

  // ====== L) Utils ======
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
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }
})();
