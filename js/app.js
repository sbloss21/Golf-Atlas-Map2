/**********************
 * CONFIG
 **********************/
const DEFAULT_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1KKJMiDhjfJ9B5VZqv3bzfcGjOy7e2c-F/export?format=csv&gid=142030251";

const DEFAULT_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 5 };
const MAX_ZOOM_BASELINE = 13;

/**********************
 * URL PARAM HELPERS
 **********************/
function getParam(name) {
  try {
    return new URL(window.location.href).searchParams.get(name);
  } catch {
    return null;
  }
}

function setParam(name, value) {
  const url = new URL(window.location.href);
  if (value === null || value === undefined || value === "") {
    url.searchParams.delete(name);
  } else {
    url.searchParams.set(name, value);
  }
  window.history.replaceState({}, "", url.toString());
}

function getBoolParam(name) {
  const v = (getParam(name) || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

// Allow ?csv= to override the data source
const CSV_URL = getParam("csv") || DEFAULT_CSV_URL;

// Show debug box only when ?debug=1 (or true/yes)
const DEBUG_MODE = getBoolParam("debug");

/**********************
 * STATE
 **********************/
let map, clusterLayer;
let allCourses = [];
let filteredCourses = [];
let markersById = new Map();
let lastSearchTerm = "";
let lastTop100Only = false;

/**********************
 * UTILITIES
 **********************/
const normKey = (k = "") =>
  String(k)
    .trim()
    .toLowerCase()
    .replace(/\uFEFF/g, "")
    .replace(/[\s\-\/]+/g, "_")
    .replace(/[()]/g, "")
    .replace(/[^a-z0-9_]/g, "");

const pickFirst = (obj, keys, fallback = "") => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "")
      return obj[k];
  }
  return fallback;
};

const toNum = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

function isTruthyYes(v) {
  // supports "yes", "true", "1", 1, etc.
  const s = String(v || "").trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1";
}

function isTop100Row(course) {
  // New schema uses top100 (0/1). Also allow top100_rank as a fallback.
  const t = Number(course?.top100 ?? 0);
  if (Number.isFinite(t) && t === 1) return true;

  const r = Number(course?.top100_rank ?? NaN);
  return Number.isFinite(r) && r > 0 && r <= 100;
}

function makeFallbackId(course) {
  // Only used when sheet doesn't provide "id"
  const a = course.name || course.course_name || "";
  const b = course.city || "";
  const c = course.state || "";
  const d = (course.latitude ?? "") + "," + (course.longitude ?? "");
  return (a + "|" + b + "|" + c + "|" + d).toLowerCase();
}

function setDebug(html) {
  const box = document.getElementById("debugBox");
  if (!box) return;

  if (!DEBUG_MODE) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  box.innerHTML = html;
}

/**
 * IMPORTANT:
 * Leaflet positions marker icons using CSS transform translate3d(...).
 * If we set transform on the Leaflet wrapper (.ga-pin-wrap), markers "fly away".
 * So we ONLY scale the inner element (.ga-pin-wrap .pin).
 */
function updateMarkerScale() {
  if (!map) return;

  const zoom = map.getZoom();

  // gentle growth as you zoom in
  const scale =
    zoom <= 6 ? 0.95 :
    zoom <= 8 ? 1.05 :
    zoom <= 10 ? 1.18 :
    zoom <= 12 ? 1.32 :
    1.45;

  document.querySelectorAll(".ga-pin-wrap .pin").forEach((el) => {
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = "bottom center";
  });
}

/**********************
 * MAP INIT
 **********************/
function initMap() {
 const isMobile = window.matchMedia("(max-width: 768px)").matches;

map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: !isMobile,
  tap: true,
  inertia: true,
  inertiaDeceleration: 3000,
  worldCopyJump: true,
  doubleClickZoom: !isMobile,
  tapTolerance: 20,
}).setView(

    [DEFAULT_VIEW.lat, DEFAULT_VIEW.lng],
    DEFAULT_VIEW.zoom
  );

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: MAX_ZOOM_BASELINE,
  }).addTo(map);

  clusterLayer = L.markerClusterGroup({
    maxZoom: MAX_ZOOM_BASELINE,
    disableClusteringAtZoom: 14,
    spiderfyOnMaxZoom: true,
    spiderfyDistanceMultiplier: 2.1,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,
    iconCreateFunction: (cluster) => {
      const count = cluster.getChildCount();
      return L.divIcon({
        html: `<div class="ga-cluster"><span>${count}</span></div>`,
        className: "ga-cluster-wrap",
        iconSize: L.point(38, 38),
      });
    },
  });

  // 2-click drill → spiderfy
  let __lastClusterKey = null;
  let __lastClusterClickAt = 0;

  function clusterKey(cluster) {
    try {
      const ll = cluster.getLatLng();
      const c = cluster.getChildCount();
      return `${c}|${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}`;
    } catch {
      return String(Date.now());
    }
  }

  clusterLayer.on("clusterclick", (e) => {
    const cluster = e.layer;

    const key = clusterKey(cluster);
    const now = Date.now();
    const isSecondClick = __lastClusterKey === key && now - __lastClusterClickAt < 2500;

    __lastClusterKey = key;
    __lastClusterClickAt = now;

    const TARGET_DRILL_ZOOM = 13;

    // Second click: spiderfy immediately
    if (isSecondClick) {
      cluster.spiderfy();
      return;
    }

    const bounds = cluster.getBounds();
    const currentZoom = map.getZoom();

    // If already zoomed enough: spiderfy on first click
    if (currentZoom >= TARGET_DRILL_ZOOM) {
      cluster.spiderfy();
      return;
    }

    // First click: drill in once
    map.fitBounds(bounds, {
      padding: [60, 60],
      maxZoom: TARGET_DRILL_ZOOM,
      animate: true,
    });

    // Auto-spiderfy if we reach target zoom
    setTimeout(() => {
      if (map.getZoom() >= TARGET_DRILL_ZOOM) cluster.spiderfy();
    }, 350);
  });

  clusterLayer.on("clustermouseover", (e) => {
    const cluster = e.layer;
    const children = cluster.getAllChildMarkers();
    const names = children.map((m) => m?.options?.__courseName || "").filter(Boolean);

    const unique = Array.from(new Set(names)).slice(0, 6);
    const extra = Math.max(0, names.length - unique.length);

    const html = `
      <div class="ga-tooltip">
        <div><b>${cluster.getChildCount()}</b> courses here</div>
        ${
          unique.length
            ? `<div class="muted" style="margin-top:6px;">Sample:</div>
               <ul>${unique.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
            : ""
        }
        ${extra ? `<div class="muted" style="margin-top:6px;">+${extra} more…</div>` : ""}
      </div>
    `;
    cluster.bindTooltip(html, { sticky: true, direction: "top", opacity: 1, className: "" });
    cluster.openTooltip();
  });

  map.addLayer(clusterLayer);

  // scale markers on zoom (safe: scales inner pin)
  map.on("zoomend", updateMarkerScale);
}

/**********************
 * CSV LOAD + NORMALIZE
 **********************/
async function loadCourses() {
  setDebug("Fetching <b>Google Sheets CSV</b>…");

  // Optional cache-buster param ?v=
  const v = getParam("v");
  const csvFetchUrl = v
    ? `${CSV_URL}${CSV_URL.includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`
    : CSV_URL;

  const res = await fetch(csvFetchUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not fetch CSV (${res.status})`);
  const text = await res.text();

  setDebug("Parsing CSV…");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  const rows = parsed.data || [];

  allCourses = rows
    .map((row) => {
      const normalized = {};
      for (const [k, v2] of Object.entries(row)) normalized[normKey(k)] = v2;

      const latitude = toNum(pickFirst(normalized, ["latitude", "lat", "course_latitude"], null));
      const longitude = toNum(
        pickFirst(normalized, ["longitude", "lng", "lon", "long", "course_longitude"], null)
      );

      // NEW schema prefers: id, name, resort_name, top100, top100_rank, etc.
      // Keep backward compatibility with old headers via pickFirst fallbacks.
      const course = {
        id: String(
          pickFirst(normalized, ["id", "course_id", "ga_id"], "")
        ).trim(),

        name: pickFirst(
          normalized,
          ["name", "course_name", "course", "golf_course", "coursefullname"],
          ""
        ),

        type: pickFirst(normalized, ["type"], "course"),

        parent_resort_id: String(
          pickFirst(normalized, ["parent_resort_id", "resort_id", "parent_id"], "")
        ).trim(),

        resort_name: pickFirst(
          normalized,
          ["resort_name", "course_resort", "resort", "property", "destination"],
          ""
        ),

        city: pickFirst(normalized, ["city", "town"], ""),
        state: pickFirst(normalized, ["state", "st", "province"], ""),
        region: pickFirst(normalized, ["region"], ""),

        latitude,
        longitude,

        website_url: pickFirst(normalized, ["website_url", "website", "url", "course_website"], ""),

        // Top 100 (new)
        top100: pickFirst(normalized, ["top100", "top_100", "top100_only"], "0"),
        top100_rank: pickFirst(normalized, ["top100_rank", "top_100_ranking", "top100_ranking"], ""),

        // Flags (new)
        buddy_trip_hotspot: pickFirst(
          normalized,
          ["buddy_trip_hotspot", "buddies_trip_hotspot", "buddies_trip_hotspot_yes_no"],
          "0"
        ),

        lodging_on_site: pickFirst(
          normalized,
          ["lodging_on_site", "lodging_on_siteyes_no", "lodging"],
          "0"
        ),

        stay_and_play: pickFirst(
          normalized,
          ["stay_and_play", "stay_and_playyes_no"],
          "0"
        ),

        // Pricing (new)
        green_fee_low: pickFirst(normalized, ["green_fee_low"], ""),
        green_fee_high: pickFirst(normalized, ["green_fee_high"], ""),
        green_fee_notes: pickFirst(normalized, ["green_fee_notes"], ""),

        // Property stats (new)
        course_count: pickFirst(normalized, ["course_count", "courses_on_property", "number_of_courses"], ""),

        // Legacy / optional extras (if still present)
        par: pickFirst(normalized, ["par"], ""),
        yardage_black_tees: pickFirst(
          normalized,
          ["yardage_black_tees", "yardage_black", "yardageblack_tees", "yardage"],
          ""
        ),
        architect: pickFirst(normalized, ["architect", "designer"], ""),
        phone: pickFirst(normalized, ["phone", "phone_number", "contact_phone"], ""),
        best_time: pickFirst(
          normalized,
          ["peak_seasonbest_time_to_visit", "best_time_to_visit", "peak_season"],
          ""
        ),
        thumbnail_url: pickFirst(
          normalized,
          ["thumbnail_url", "thumbnail", "image", "image_url", "photo_url"],
          ""
        ),
        logo_url: pickFirst(
          normalized,
          ["logo_urllinked", "logo_url", "logo", "logo_link", "course_logo_link"],
          ""
        ),

        __raw: normalized,
      };

      // Internal ID used for marker lookups
      const stableId = course.id || "";
      course.__id = stableId || makeFallbackId({ ...course, course_name: course.name });

      // Backward-compatible alias (so existing code logic can be minimally changed)
      course.course_name = course.name; // preserve old property name usage if any remains
      course.course_resort = course.resort_name;

      // Normalize top100 flags
      course.__isTop100 = isTop100Row(course);

      // Buddy hotspot: handle 0/1 or yes/no
      course.__isBuddyHotspot = isTruthyYes(course.buddy_trip_hotspot);

      // normalize top100_rank to number when possible
      const tr = toNum(course.top100_rank);
      course.top100_rank = tr !== null ? tr : "";

      // Normalize green fee values (numbers if possible)
      const gfl = toNum(course.green_fee_low);
      const gfh = toNum(course.green_fee_high);
      course.green_fee_low = gfl !== null ? gfl : "";
      course.green_fee_high = gfh !== null ? gfh : "";

      return course;
    })
    .filter(
      (c) =>
        Number.isFinite(c.latitude) &&
        Number.isFinite(c.longitude) &&
        String(c.name || "").trim() !== ""
    );

  filteredCourses = [...allCourses];

  const top100Count = allCourses.filter((c) => c.__isTop100).length;
  setDebug(`Loaded <b>${allCourses.length}</b> courses • Top-100: <b>${top100Count}</b>`);

  if (!allCourses.length) {
    setDebug(`Loaded <b>0</b> courses.<br/>Likely a lat/lng header mismatch in the sheet.`);
  }
}

/**********************
 * MARKERS + POPUPS
 **********************/
function pinIcon(isTop100) {
  // NOTE: We keep Leaflet's wrapper (ga-pin-wrap) untouched (Leaflet uses transform to position).
  // The inner ".pin" is what we style/scale in CSS + updateMarkerScale().
  return L.divIcon({
    className: "ga-pin-wrap",
    html: `<div class="pin ${isTop100 ? "top100" : ""}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 14], // slightly more "bottom-anchored" for a flag
  });
}

function pill(val, lab) {
  return `
    <div class="popup-pill">
      <div class="pill-val">${escapeHtml(String(val))}</div>
      <div class="pill-lab">${escapeHtml(String(lab))}</div>
    </div>
  `;
}

function formatCost(c) {
  // Prefer new schema
  const low = c.green_fee_low;
  const high = c.green_fee_high;
  const notes = String(c.green_fee_notes || "").trim();

  if (low !== "" && high !== "") {
    if (Number(low) === Number(high)) return `$${low}`;
    return `$${low}-${high}`;
  }
  if (low !== "" && high === "") return `$${low}`;
  if (notes) return notes;

  // Legacy fallback
  const legacy = String(c.cost_range || "").trim();
  return legacy || "";
}

function createPopupContent(c) {
  const loc = [c.city, c.state].filter(Boolean).join(", ");
  const badge = c.__isTop100
    ? `<span class="ga-badge">Top-100</span>`
    : `<span style="opacity:.6;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:rgba(5,45,31,.6)">Golf Atlas</span>`;

  const pills = [];
  if (c.par) pills.push(pill(c.par, "Par"));
  if (c.yardage_black_tees) pills.push(pill(c.yardage_black_tees, "Yards"));
  if (c.__isTop100 && c.top100_rank) pills.push(pill("#" + String(c.top100_rank).trim(), "Top 100"));

  const lines = [];
  if (c.resort_name) lines.push(`🏨 ${escapeHtml(c.resort_name)}`);
  if (c.architect) lines.push(`🏗️ ${escapeHtml(c.architect)}`);

  const cost = formatCost(c);
  if (cost) lines.push(`💰 ${escapeHtml(cost)}`);

  if (c.best_time) lines.push(`🗓️ Best: ${escapeHtml(c.best_time)}`);

  const btnWebsite = c.website_url
    ? `<button class="popup-btn primary" onclick="openLink('${escapeAttr(c.website_url)}')">Website</button>`
    : "";
  const btnCall = c.phone
    ? `<button class="popup-btn ghost" onclick="openLink('tel:${escapeAttr(c.phone)}')">Call</button>`
    : "";

  const brandText = escapeHtml(c.resort_name || c.name || "GOLF ATLAS");
  const hasLogo = !!(c.logo_url && String(c.logo_url).trim());

  return `
    <div>
      <div class="popup-head">
        <div class="popup-brand">
          ${
            hasLogo
              ? `<img class="popup-course-logo" src="${escapeAttr(c.logo_url)}" alt="Logo"
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />`
              : ``
          }
          <div class="popup-logo" style="${hasLogo ? "display:none;" : ""}">${brandText}</div>
        </div>
        ${badge}
      </div>

      <div class="popup-body">
        <div class="popup-title">${escapeHtml(c.name || "Course")}</div>
        <div class="popup-sub">${escapeHtml(loc || c.region || "")}</div>

        ${pills.length ? `<div class="popup-grid">${pills.slice(0, 4).join("")}</div>` : ""}

        ${lines.length ? `<div class="popup-lines">${lines.map((l) => `<div>${l}</div>`).join("")}</div>` : ""}

        ${(btnWebsite || btnCall) ? `<div class="popup-actions">${btnWebsite}${btnCall}</div>` : ""}
      </div>
    </div>
  `;
}

function renderMarkers() {
  clusterLayer.clearLayers();
  markersById.clear();

  filteredCourses.forEach((c) => {
    const m = L.marker([c.latitude, c.longitude], { icon: pinIcon(c.__isTop100) });
    m.options.__courseId = c.__id;
    m.options.__courseName = c.name;

    m.bindPopup(createPopupContent(c), {
  maxWidth: 320,
  closeButton: true,
  autoPan: true,
  autoPanPadding: [16, 16],
});


    m.on("mouseover", () => {
      const el = m.getElement()?.querySelector(".pin");
      if (el) el.classList.add("hovered");
      m.bindTooltip(
        `<div class="ga-tooltip"><b>${escapeHtml(c.name)}</b><div class="muted">${escapeHtml(
          [c.city, c.state].filter(Boolean).join(", ")
        )}</div></div>`,
        { direction: "top", opacity: 1, sticky: true, className: "" }
      );
      m.openTooltip();
    });

    m.on("mouseout", () => {
      const el = m.getElement()?.querySelector(".pin");
      if (el) el.classList.remove("hovered");
      m.closeTooltip();
    });

    clusterLayer.addLayer(m);
    markersById.set(c.__id, m);
  });

  // Wait a tick so Leaflet has inserted marker DOM nodes, then scale safely
  setTimeout(updateMarkerScale, 0);
}

/**********************
 * RESORT CARDS
 * (Kept harmless: if resortGrid isn't present, it returns immediately)
 **********************/
function renderResortCards() {
  const grid = document.getElementById("resortGrid");
  if (!grid) return;

  const featured = [...filteredCourses]
    .sort((a, b) => {
      const aScore = (a.__isBuddyHotspot ? 2 : 0) + (a.__isTop100 ? 1 : 0);
      const bScore = (b.__isBuddyHotspot ? 2 : 0) + (b.__isTop100 ? 1 : 0);
      if (a.__isTop100 && b.__isTop100) {
        const ar = toNum(a.top100_rank) ?? 9999;
        const br = toNum(b.top100_rank) ?? 9999;
        if (ar !== br) return ar - br;
      }
      return bScore - aScore;
    })
    .slice(0, 8);

  const fallbackImg =
    "https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=1200&q=80&auto=format&fit=crop";

  grid.innerHTML = featured
    .map((c) => {
      const img = c.thumbnail_url || fallbackImg;
      const name = (c.resort_name || c.name || "").trim();
      const sub = c.resort_name ? c.name : [c.city, c.state].filter(Boolean).join(", ") || "";
      const meta = [];
      if (isTruthyYes(c.lodging_on_site)) meta.push("On-site lodging");
      if (c.best_time) meta.push("Best: " + c.best_time);
      const cost = formatCost(c);
      if (cost) meta.push(cost);
      if (c.__isTop100 && c.top100_rank) meta.unshift(`Top-100 (#${String(c.top100_rank).trim()})`);

      return `
        <div class="resort-card" onclick="focusCourse('${escapeAttr(c.__id)}')">
          <img class="resort-image" src="${escapeAttr(img)}" alt="${escapeAttr(c.name)}"
               onerror="this.src='${escapeAttr(fallbackImg)}'"/>
          <div class="resort-info">
            <div class="resort-name">${escapeHtml(name)}</div>
            <div class="resort-courses">${escapeHtml(sub)}</div>
            <div class="resort-meta">
              ${meta
                .slice(0, 3)
                .map((t) => `<div class="resort-meta-item"><span class="meta-dot"></span>${escapeHtml(t)}</div>`)
                .join("")}
            </div>

            <button class="learn-more-btn" onclick="event.stopPropagation(); focusCourse('${escapeAttr(c.__id)}')">More Info</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function focusCourse(courseId) {
  const marker = markersById.get(courseId);
  if (!marker) return;

  const ll = marker.getLatLng();
  map.setView(ll, Math.min(13, MAX_ZOOM_BASELINE));
  setTimeout(() => marker.openPopup(), 180);
  document.getElementById("map")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**********************
 * FILTERING + SEARCH
 **********************/
function applyFilters() {
  const term = lastSearchTerm.trim().toLowerCase();
  const top100Only = lastTop100Only;

  filteredCourses = allCourses.filter((c) => {
    if (top100Only && !c.__isTop100) return false;
    if (!term) return true;

    const hay = [c.name, c.resort_name, c.city, c.state, c.region]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return hay.includes(term);
  });

  renderMarkers();
  renderResortCards();

  setDebug(
    `Loaded <b>${allCourses.length}</b> • Showing <b>${filteredCourses.length}</b>${
      lastTop100Only ? " • Top-100 only" : ""
    }`
  );
}

function findBestCourseMatch(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return null;

  let exact = allCourses.find((c) => (c.name || "").trim().toLowerCase() === q);
  if (exact) return exact;

  exact = allCourses.find((c) => (c.resort_name || "").trim().toLowerCase() === q);
  if (exact) return exact;

  const contains = allCourses.find((c) => (c.name || "").toLowerCase().includes(q));
  if (contains) return contains;

  const broader = allCourses.find((c) => {
    const hay = [c.name, c.resort_name, c.city, c.state, c.region]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  return broader || null;
}

function focusBestMatch(query) {
  const match = findBestCourseMatch(query);
  if (!match) return false;

  if (lastTop100Only && !match.__isTop100) {
    lastTop100Only = false;
    const chk = document.getElementById("top100Check");
    if (chk) chk.checked = false;
    document.getElementById("top100Chip")?.classList.remove("active");
    setParam("top100", null);
    applyFilters();
  }

  setTimeout(() => focusCourse(match.__id), 0);
  return true;
}

function setSearchTerm(term) {
  lastSearchTerm = (term || "").trim();
  const searchInput = document.getElementById("searchInput");
  const mapSearch = document.getElementById("mapSearch");

  if (searchInput) searchInput.value = lastSearchTerm;
  if (mapSearch) mapSearch.value = lastSearchTerm;

  setParam("q", lastSearchTerm || null);

  applyFilters();
  renderTypeahead();
}

function renderTypeahead() {
  const ta = document.getElementById("typeahead");
  const searchInput = document.getElementById("searchInput");
  if (!ta || !searchInput) return;

  const q = (searchInput.value || "").trim().toLowerCase();
  if (!q || q.length < 2) {
    ta.style.display = "none";
    ta.innerHTML = "";
    return;
  }

  const suggestions = [];
  for (const c of allCourses) {
    const cn = c.name || "";
    const rn = c.resort_name || "";
    const cs = [c.city, c.state].filter(Boolean).join(", ");

    if (cn.toLowerCase().includes(q)) suggestions.push(cn);
    if (rn && rn.toLowerCase().includes(q)) suggestions.push(rn);
    if (cs && cs.toLowerCase().includes(q)) suggestions.push(cs);
    if (suggestions.length > 14) break;
  }

  const uniq = Array.from(new Set(suggestions)).slice(0, 10);
  if (!uniq.length) {
    ta.style.display = "none";
    ta.innerHTML = "";
    return;
  }

  ta.style.display = "block";
  ta.innerHTML =
    uniq
      .map(
        (s) => `
      <div style="padding:10px 12px; cursor:pointer; font-size:13px; color:var(--ga-forest); border-bottom:1px solid rgba(0,0,0,.06)"
           onmouseover="this.style.background='rgba(0,0,0,.04)'" onmouseout="this.style.background='transparent'"
           onclick="window.__pickSuggestion('${escapeAttr(s)}')">
        ${escapeHtml(s)}
      </div>
    `
      )
      .join("") + `<div style="padding:9px 12px; font-size:12px; color:#6b8f7f">Press Enter to search</div>`;
}

function hideTypeahead() {
  const ta = document.getElementById("typeahead");
  if (!ta) return;
  ta.style.display = "none";
  ta.innerHTML = "";
}

window.__pickSuggestion = (s) => {
  setSearchTerm(s);
  hideTypeahead();
  focusBestMatch(s);
};

function fitToCourses(list) {
  if (!list.length) return;
  const latlngs = list.map((c) => [c.latitude, c.longitude]);
  const bounds = L.latLngBounds(latlngs);
  map.fitBounds(bounds, { padding: [60, 60] });
}

/**********************
 * Escaping + Links
 **********************/
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(str) {
  return escapeHtml(str).replaceAll("`", "&#096;");
}

function openLink(url) {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {}
}


function resetMapExperience() {
  // Clear search (also updates URL q and rerenders)
  setSearchTerm("");
  hideTypeahead();

  // Clear all filters (current + future)
  lastTop100Only = false;

  // Top-100 UI + URL
  const chk = document.getElementById("top100Check");
  if (chk) chk.checked = false;
  document.getElementById("top100Chip")?.classList.remove("active");
  setParam("top100", null);

  // Close any open popup
  try { map.closePopup(); } catch {}

  // Recenter
  map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);
}


/**********************
 * UI WIRING
 **********************/
function wireUI() {
  const searchInput = document.getElementById("searchInput");
  const mapSearch = document.getElementById("mapSearch"); // may exist, but we’ll keep it synced
  const top100Check = document.getElementById("top100Check");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderTypeahead();
      if (mapSearch) mapSearch.value = searchInput.value;
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = searchInput.value;
        setSearchTerm(q);
        hideTypeahead();
        focusBestMatch(q);
      }
      if (e.key === "Escape") {
        setSearchTerm("");
        hideTypeahead();
      }
    });
  }

  if (mapSearch) {
    mapSearch.addEventListener("input", () => {
      if (searchInput) searchInput.value = mapSearch.value;
    });

    mapSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = mapSearch.value;
        setSearchTerm(q);
        hideTypeahead();
        focusBestMatch(q);
      }
      if (e.key === "Escape") {
        setSearchTerm("");
      }
    });
  }

  const goBtn = document.getElementById("goSearch");
  if (goBtn && searchInput) {
    goBtn.addEventListener("click", () => {
      const q = searchInput.value;
      setSearchTerm(q);
      focusBestMatch(q);
    });
  }

  const clearBtn = document.getElementById("clearSearch");
  if (clearBtn) clearBtn.addEventListener("click", () => setSearchTerm(""));

  const mapClearBtn = document.getElementById("mapClear");
  if (mapClearBtn) mapClearBtn.addEventListener("click", () => setSearchTerm(""));

  if (top100Check) {
    top100Check.addEventListener("change", () => {
      lastTop100Only = top100Check.checked;
      document.getElementById("top100Chip")?.classList.toggle("active", lastTop100Only);
      setParam("top100", lastTop100Only ? "1" : null);
      applyFilters();
    });
  }

  const panel = document.getElementById("filtersPanel");
  const toggle = document.getElementById("filterToggle");
  if (toggle && panel) {
    toggle.addEventListener("click", () => panel.classList.toggle("show"));
  }

 const resetBtn = document.getElementById("resetMap");
if (resetBtn) {
  resetBtn.addEventListener("click", () => resetMapExperience());
}

const fitResults = document.getElementById("fitResults");
if (fitResults) {
  fitResults.addEventListener("click", () => resetMapExperience());
}


  document.addEventListener("click", (e) => {
    const ta = document.getElementById("typeahead");
    if (!ta || !searchInput) return;
    if (!ta.contains(e.target) && e.target !== searchInput) hideTypeahead();
  });
}

/**********************
 * BOOT
 **********************/
(async function boot() {
  initMap();
  wireUI();

  // Initialize state from URL
  lastSearchTerm = (getParam("q") || "").trim();
  lastTop100Only = getBoolParam("top100");

  // Reflect URL state into UI controls
  const searchInput = document.getElementById("searchInput");
  const mapSearch = document.getElementById("mapSearch");
  if (searchInput) searchInput.value = lastSearchTerm;
  if (mapSearch) mapSearch.value = lastSearchTerm;

  const top100Check = document.getElementById("top100Check");
  if (top100Check) top100Check.checked = lastTop100Only;
  document.getElementById("top100Chip")?.classList.toggle("active", lastTop100Only);

  setDebug("");

  try {
    await loadCourses();
    applyFilters();
    renderResortCards();

    // Ensure initial scale is applied once markers render
    setTimeout(updateMarkerScale, 0);

    // If q is set, focus it once markers exist
    if (lastSearchTerm) {
      setTimeout(() => focusBestMatch(lastSearchTerm), 80);
    }
  } catch (err) {
    console.error(err);
    setDebug(`Error: <b>${escapeHtml(err.message || String(err))}</b><br/>Open console for details.`);
    alert("Could not load Google Sheets CSV. Open console for details.");
  }
})();
