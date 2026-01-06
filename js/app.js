/**********************
   * CONFIG
   **********************/
  const DEFAULT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT-nZvG7m9sUkOu0spxVTVGcM311qlgGSjnFgRDQr-l6nfs1cPFNrGBXO0ZDzMIQg/pub?gid=1171293634&single=true&output=csv";

function getParam(name) {
  try {
    return new URL(window.location.href).searchParams.get(name);
  } catch {
    return null;
  }
}

// Allow ?csv= (URL-encoded is fine) to override the data source
const CSV_URL = getParam("csv") || DEFAULT_CSV_URL;

// Show debug box only when ?debug=1 (or true/yes)
const DEBUG_MODE = (() => {
  const v = (getParam("debug") || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y";
})();

  const DEFAULT_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 5 };
  const MAX_ZOOM_BASELINE = 13;

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
  const normKey = (k="") =>
    String(k).trim().toLowerCase()
      .replace(/\uFEFF/g,"")
      .replace(/[\s\-\/]+/g, "_")
      .replace(/[()]/g, "")
      .replace(/[^a-z0-9_]/g, "");

  const pickFirst = (obj, keys, fallback="") => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
    }
    return fallback;
  };

  const toNum = (v) => {
    const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g,""));
    return Number.isFinite(n) ? n : null;
  };

  function isTruthyYes(v){
    const s = String(v||"").trim().toLowerCase();
    return s === "yes" || s === "y" || s === "true" || s === "1";
  }

  function makeId(course){
    const a = course.course_name || "";
    const b = course.city || "";
    const c = course.state || "";
    const d = (course.latitude ?? "") + "," + (course.longitude ?? "");
    return (a+"|"+b+"|"+c+"|"+d).toLowerCase();
  }

  function setDebug(html){
  const box = document.getElementById("debugBox");
  if (!box) return;

  if (!DEBUG_MODE) {
    box.style.display = "none";
    return;
  }

  box.style.display = "";
  box.innerHTML = html;
}


  /**********************
   * MAP INIT (baseline-ish)
   **********************/
  function initMap(){
    map = L.map("map", { zoomControl:true, scrollWheelZoom:true }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: MAX_ZOOM_BASELINE
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
          iconSize: L.point(38, 38)
        });
      }
    });

    clusterLayer.on("clusterclick", (e) => {
      const cluster = e.layer;
      const bounds = cluster.getBounds();
      map.fitBounds(bounds, { padding:[50,50] });
      setTimeout(() => {
        if (map.getZoom() >= 14) cluster.spiderfy();
      }, 220);
    });

    clusterLayer.on("clustermouseover", (e) => {
      const cluster = e.layer;
      const children = cluster.getAllChildMarkers();
      const names = children.map(m => m?.options?.__courseName || "").filter(Boolean);

      const unique = Array.from(new Set(names)).slice(0, 6);
      const extra = Math.max(0, names.length - unique.length);

      const html = `
        <div class="ga-tooltip">
          <div><b>${cluster.getChildCount()}</b> courses here</div>
          ${unique.length ? `<div class="muted" style="margin-top:6px;">Sample:</div>
          <ul>${unique.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
          ${extra ? `<div class="muted" style="margin-top:6px;">+${extra} more…</div>` : ""}
        </div>
      `;
      cluster.bindTooltip(html, { sticky:true, direction:"top", opacity:1, className:"" });
      cluster.openTooltip();
    });

    map.addLayer(clusterLayer);
  }

  /**********************
   * CSV LOAD + NORMALIZE
   **********************/
  async function loadCourses(){
    setDebug("Fetching <b>Google Sheets CSV</b>…");
    const res = await fetch(CSV_URL, { cache:"no-store" });
    if (!res.ok) throw new Error(`Could not fetch CSV (${res.status})`);
    const text = await res.text();

    setDebug("Parsing CSV…");
    const parsed = Papa.parse(text, { header:true, skipEmptyLines:true });
    const rows = parsed.data || [];

    allCourses = rows.map((row) => {
      const normalized = {};
      for (const [k,v] of Object.entries(row)) normalized[normKey(k)] = v;

      const latitude  = toNum(pickFirst(normalized, ["latitude","lat","course_latitude"], null));
      const longitude = toNum(pickFirst(normalized, ["longitude","lng","lon","long","course_longitude"], null));

      const course = {
        course_name: pickFirst(normalized, ["course_name","course","name","golf_course","coursefullname"], ""),
        course_resort: pickFirst(normalized, ["course_resort","resort","resort_name","property","destination"], ""),
        city: pickFirst(normalized, ["city","town"], ""),
        state: pickFirst(normalized, ["state","st","province"], ""),
        region: pickFirst(normalized, ["region"], ""),
        latitude,
        longitude,
        par: pickFirst(normalized, ["par"], ""),
        yardage_black_tees: pickFirst(normalized, ["yardageblack_tees","yardage_black_tees","yardage_black","yardage"], ""),
        top_100_ranking: pickFirst(normalized, ["top_100_ranking","top100_ranking","top_100","top100"], ""),
        avg_rating: pickFirst(normalized, ["player_reviews_avg_rating","player_reviews_avg","avg_rating","rating"], ""),
        buddies_trip_hotspot: pickFirst(normalized, ["buddies_trip_hotspot_yes_no","buddies_trip_hotspot","buddy_trip_hotspot"], ""),
        lodging_on_site: pickFirst(normalized, ["lodging_on_siteyes_no","lodging_on_site","lodging"], ""),
        best_time: pickFirst(normalized, ["peak_seasonbest_time_to_visit","best_time_to_visit","peak_season"], ""),
        cost_range: pickFirst(normalized, ["cost_per_coursegreen_fee_range","green_fee_range","cost_range","price_range"], ""),
        architect: pickFirst(normalized, ["architect","designer"], ""),
        phone: pickFirst(normalized, ["phone","phone_number","contact_phone"], ""),
        website_url: pickFirst(normalized, ["website_url","website","url","course_website"], ""),
        thumbnail_url: pickFirst(normalized, ["thumbnail_url","thumbnail","image","image_url","photo_url"], ""),

        logo_url: pickFirst(normalized, [
          "logo_urllinked",
          "logo_url",
          "course_logo_url",
          "course_logo",
          "logo",
          "logo_link",
          "course_logo_link"
        ], ""),

        __raw: normalized
      };

      course.__id = makeId(course);
      course.__isTop100 = String(course.top_100_ranking||"").trim() !== "";
      course.__isBuddyHotspot = isTruthyYes(course.buddies_trip_hotspot);

      return course;
    })
    .filter(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && c.course_name);

    filteredCourses = [...allCourses];

    const top100Count = allCourses.filter(c => c.__isTop100).length;
    setDebug(`Loaded <b>${allCourses.length}</b> courses • Top-100: <b>${top100Count}</b>`);

    if (!allCourses.length){
      setDebug(`Loaded <b>0</b> courses.<br/>Likely a lat/lng header mismatch in the sheet.`);
    }
  }

  /**********************
   * MARKERS + POPUPS
   **********************/
  function pinIcon(isTop100){
    return L.divIcon({
      className: "ga-pin-wrap",
      html: `<div class="pin ${isTop100 ? "top100" : ""}"></div>`,
      iconSize: [14,14],
      iconAnchor: [7,7]
    });
  }

  function pill(val, lab){
    return `
      <div class="popup-pill">
        <div class="pill-val">${escapeHtml(String(val))}</div>
        <div class="pill-lab">${escapeHtml(String(lab))}</div>
      </div>
    `;
  }

  function createPopupContent(c){
    const loc = [c.city, c.state].filter(Boolean).join(", ");
    const badge = c.__isTop100 ? `<span class="ga-badge">Top-100</span>` : `<span style="opacity:.6;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:rgba(5,45,31,.6)">Golf Atlas</span>`;

    const pills = [];
    if (c.par) pills.push(pill(c.par, "Par"));
    if (c.yardage_black_tees) pills.push(pill(c.yardage_black_tees, "Yards"));
    if (c.__isTop100) pills.push(pill("#"+String(c.top_100_ranking).trim(), "Top 100"));
    if (c.avg_rating) pills.push(pill(c.avg_rating, "Rating"));

    const lines = [];
    if (c.course_resort) lines.push(`🏨 ${escapeHtml(c.course_resort)}`);
    if (c.architect) lines.push(`🏗️ ${escapeHtml(c.architect)}`);
    if (c.cost_range) lines.push(`💰 ${escapeHtml(c.cost_range)}`);
    if (c.best_time) lines.push(`🗓️ Best: ${escapeHtml(c.best_time)}`);

    const btnWebsite = c.website_url ? `<button class="popup-btn primary" onclick="openLink('${escapeAttr(c.website_url)}')">Website</button>` : "";
    const btnCall = c.phone ? `<button class="popup-btn ghost" onclick="openLink('tel:${escapeAttr(c.phone)}')">Call</button>` : "";

    const brandText = escapeHtml(c.course_resort || c.course_name || "GOLF ATLAS");
    const hasLogo = !!(c.logo_url && String(c.logo_url).trim());

    return `
      <div>
        <div class="popup-head">
          <div class="popup-brand">
            ${hasLogo ? `<img class="popup-course-logo" src="${escapeAttr(c.logo_url)}" alt="Logo"
              onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />` : ``}
            <div class="popup-logo" style="${hasLogo ? "display:none;" : ""}">${brandText}</div>
          </div>
          ${badge}
        </div>

        <div class="popup-body">
          <div class="popup-title">${escapeHtml(c.course_name || "Course")}</div>
          <div class="popup-sub">${escapeHtml(loc || c.region || "")}</div>

          ${pills.length ? `<div class="popup-grid">${pills.slice(0,4).join("")}</div>` : ""}

          ${lines.length ? `<div class="popup-lines">${lines.map(l => `<div>${l}</div>`).join("")}</div>` : ""}

          ${(btnWebsite || btnCall) ? `<div class="popup-actions">${btnWebsite}${btnCall}</div>` : ""}
        </div>
      </div>
    `;
  }

  function renderMarkers(){
    clusterLayer.clearLayers();
    markersById.clear();

    filteredCourses.forEach((c) => {
      const m = L.marker([c.latitude, c.longitude], { icon: pinIcon(c.__isTop100) });
      m.options.__courseId = c.__id;
      m.options.__courseName = c.course_name;

      m.bindPopup(createPopupContent(c), { maxWidth: 320, closeButton:true });

      m.on("mouseover", () => {
        const el = m.getElement()?.querySelector(".pin");
        if (el) el.classList.add("hovered");
        m.bindTooltip(
          `<div class="ga-tooltip"><b>${escapeHtml(c.course_name)}</b><div class="muted">${escapeHtml([c.city,c.state].filter(Boolean).join(", "))}</div></div>`,
          { direction:"top", opacity:1, sticky:true, className:"" }
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
  }

  /**********************
   * RESORT CARDS
   **********************/
  function renderResortCards(){
    const grid = document.getElementById("resortGrid");

    const featured = [...filteredCourses]
      .sort((a,b) => {
        const aScore = (a.__isBuddyHotspot ? 2 : 0) + (a.__isTop100 ? 1 : 0);
        const bScore = (b.__isBuddyHotspot ? 2 : 0) + (b.__isTop100 ? 1 : 0);
        if (a.__isTop100 && b.__isTop100) {
          const ar = toNum(a.top_100_ranking) ?? 9999;
          const br = toNum(b.top_100_ranking) ?? 9999;
          if (ar !== br) return ar - br;
        }
        return bScore - aScore;
      })
      .slice(0, 8);

    const fallbackImg = "https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=1200&q=80&auto=format&fit=crop";

    grid.innerHTML = featured.map(c => {
      const img = c.thumbnail_url || fallbackImg;
      const name = (c.course_resort || c.course_name || "").trim();
      const sub = c.course_resort ? c.course_name : ([c.city,c.state].filter(Boolean).join(", ") || "");
      const meta = [];
      if (isTruthyYes(c.lodging_on_site)) meta.push("On-site lodging");
      if (c.best_time) meta.push("Best: " + c.best_time);
      if (c.cost_range) meta.push(c.cost_range);
      if (c.__isTop100) meta.unshift(`Top-100 (#${String(c.top_100_ranking).trim()})`);

      return `
        <div class="resort-card" onclick="focusCourse('${escapeAttr(c.__id)}')">
          <img class="resort-image" src="${escapeAttr(img)}" alt="${escapeAttr(c.course_name)}"
               onerror="this.src='${escapeAttr(fallbackImg)}'"/>
          <div class="resort-info">
            <div class="resort-name">${escapeHtml(name)}</div>
            <div class="resort-courses">${escapeHtml(sub)}</div>
            <div class="resort-meta">
              ${meta.slice(0,3).map(t => `<div class="resort-meta-item"><span class="meta-dot"></span>${escapeHtml(t)}</div>`).join("")}
            </div>

            <button class="learn-more-btn" onclick="event.stopPropagation(); focusCourse('${escapeAttr(c.__id)}')">More Info</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function focusCourse(courseId){
    const marker = markersById.get(courseId);
    if (!marker) return;
    const ll = marker.getLatLng();
    map.setView(ll, Math.min(13, MAX_ZOOM_BASELINE));
    setTimeout(() => marker.openPopup(), 180);
    document.getElementById("map").scrollIntoView({ behavior:"smooth", block:"start" });
  }

  /**********************
   * FILTERING + SEARCH
   **********************/
  function applyFilters(){
    const term = lastSearchTerm.trim().toLowerCase();
    const top100Only = lastTop100Only;

    filteredCourses = allCourses.filter(c => {
      if (top100Only && !c.__isTop100) return false;
      if (!term) return true;

      const hay = [c.course_name, c.course_resort, c.city, c.state, c.region]
        .filter(Boolean).join(" ").toLowerCase();

      return hay.includes(term);
    });

    renderMarkers();
    renderResortCards();

    setDebug(`Loaded <b>${allCourses.length}</b> • Showing <b>${filteredCourses.length}</b>${lastTop100Only ? " • Top-100 only" : ""}`);
  }

  function setSearchTerm(term){
    lastSearchTerm = term || "";
    document.getElementById("searchInput").value = lastSearchTerm;
    document.getElementById("mapSearch").value = lastSearchTerm;
    applyFilters();
    renderTypeahead();
  }

  function renderTypeahead(){
    const ta = document.getElementById("typeahead");
    const q = (document.getElementById("searchInput").value || "").trim().toLowerCase();
    if (!q || q.length < 2){
      ta.style.display = "none";
      ta.innerHTML = "";
      return;
    }

    const suggestions = [];
    for (const c of allCourses){
      const cn = (c.course_name||"");
      const rn = (c.course_resort||"");
      const cs = [c.city,c.state].filter(Boolean).join(", ");
      if (cn.toLowerCase().includes(q)) suggestions.push(cn);
      if (rn && rn.toLowerCase().includes(q)) suggestions.push(rn);
      if (cs && cs.toLowerCase().includes(q)) suggestions.push(cs);
      if (suggestions.length > 14) break;
    }

    const uniq = Array.from(new Set(suggestions)).slice(0, 10);
    if (!uniq.length){
      ta.style.display = "none";
      ta.innerHTML = "";
      return;
    }

    ta.style.display = "block";
    ta.innerHTML = uniq.map(s => `
      <div style="padding:10px 12px; cursor:pointer; font-size:13px; color:var(--ga-forest); border-bottom:1px solid rgba(0,0,0,.06)"
           onmouseover="this.style.background='rgba(0,0,0,.04)'" onmouseout="this.style.background='transparent'"
           onclick="window.__pickSuggestion('${escapeAttr(s)}')">
        ${escapeHtml(s)}
      </div>
    `).join("") + `<div style="padding:9px 12px; font-size:12px; color:#6b8f7f">Press Enter to search</div>`;
  }

  window.__pickSuggestion = (s) => {
    setSearchTerm(s);
    hideTypeahead();
  };

  function hideTypeahead(){
    const ta = document.getElementById("typeahead");
    ta.style.display = "none";
    ta.innerHTML = "";
  }

  function fitToCourses(list){
    if (!list.length) return;
    const latlngs = list.map(c => [c.latitude, c.longitude]);
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding:[60,60] });
  }

  /**********************
   * Escaping + Links
   **********************/
  function escapeHtml(str){
    return String(str ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }
  function escapeAttr(str){ return escapeHtml(str).replaceAll("`","&#096;"); }

  function openLink(url){
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch(e){}
  }

  /**********************
   * UI WIRING
   **********************/
  function wireUI(){
    const searchInput = document.getElementById("searchInput");
    const mapSearch = document.getElementById("mapSearch");
    const top100Check = document.getElementById("top100Check");

    searchInput.addEventListener("input", () => { renderTypeahead(); });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") setSearchTerm(searchInput.value);
      if (e.key === "Escape") { setSearchTerm(""); hideTypeahead(); }
    });

    mapSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") setSearchTerm(mapSearch.value);
      if (e.key === "Escape") setSearchTerm("");
    });

    document.getElementById("goSearch").addEventListener("click", () => setSearchTerm(searchInput.value));
    document.getElementById("clearSearch").addEventListener("click", () => setSearchTerm(""));
    document.getElementById("mapClear").addEventListener("click", () => setSearchTerm(""));

    mapSearch.addEventListener("input", () => { searchInput.value = mapSearch.value; });
    searchInput.addEventListener("input", () => { mapSearch.value = searchInput.value; });

    top100Check.addEventListener("change", () => {
      lastTop100Only = top100Check.checked;
      document.getElementById("top100Chip").classList.toggle("active", lastTop100Only);
      applyFilters();
    });

    const panel = document.getElementById("filtersPanel");
    document.getElementById("filterToggle").addEventListener("click", () => {
      panel.classList.toggle("show");
    });

    document.getElementById("fitUSA").addEventListener("click", () => {
      map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);
    });
    document.getElementById("fitResults").addEventListener("click", () => {
      fitToCourses(filteredCourses);
    });

    document.addEventListener("click", (e) => {
      const ta = document.getElementById("typeahead");
      if (!ta) return;
      if (!ta.contains(e.target) && e.target !== searchInput) hideTypeahead();
    });
  }

  /**********************
   * BOOT
   **********************/
  (async function boot(){
    initMap();
    wireUI();
    setDebug("");


    try{
      await loadCourses();
      applyFilters();
      renderResortCards();
    }catch(err){
      console.error(err);
      setDebug(`Error: <b>${escapeHtml(err.message || String(err))}</b><br/>Open console for details.`);
      alert("Could not load Google Sheets CSV. Open console for details.");
    }
  })();
