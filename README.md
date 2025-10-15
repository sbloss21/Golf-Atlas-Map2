<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Golf Atlas Map</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <!-- Leaflet CSS/JS (CDN) -->
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>

  <!-- Papa Parse for CSV -->
  <script src="https://unpkg.com/papaparse@5.4.1/papaparse.min.js"></script>

  <style>
    /* CRITICAL: give the map a height or it won’t render */
    html, body {
      height: 100%;
      margin: 0;
    }
    #map {
      height: 100vh; /* or 92vh if you want some header space */
      width: 100%;
    }
    .titlebar {
      padding: 10px 12px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }
  </style>
</head>
<body>
  <div class="titlebar">
    <h1 style="margin:0;">Golf Atlas – Courses</h1>
    <small>Data source: <code>?csv=...</code> URL parameter</small>
  </div>
  <div id="map"></div>

  <script>
    // Helper: get URL param
    function getParam(name) {
      const url = new URL(window.location.href);
      return url.searchParams.get(name);
    }

    // Initialize Leaflet map (lower 48 + AK/HI padding later)
    const map = L.map('map', { scrollWheelZoom: true });

    // Basemap
    const tiles = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: '&copy; OpenStreetMap contributors' }
    ).addTo(map);

    // Default view (USA-ish) so the map always shows even if CSV fails
    map.setView([39.5, -98.5], 4);

    const csvUrl = getParam('csv');
    if (!csvUrl) {
      console.warn('No ?csv= URL provided. Add ?csv=<encoded csv url> to your page URL.');
    } else {
      // Fetch CSV with Papa Parse
      Papa.parse(csvUrl, {
        download: true,
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rows = results.data;
          console.log(`Loaded ${rows.length} rows from CSV.`);
          const markers = [];
          const bounds = L.latLngBounds();

          rows.forEach((r) => {
            // Be flexible with column names
            const lat = r.Latitude ?? r.latitude ?? r.lat;
            const lon = r.Longitude ?? r.longitude ?? r.lng ?? r.lon;
            if (typeof lat === 'number' && typeof lon === 'number' && !isNaN(lat) && !isNaN(lon)) {
              const name = r['Course Name'] || r.name || 'Unknown';
              const resort = r['Course Resort'] || '';
              const city = r.City || '';
              const state = r['State/Province'] || '';
              const fee = r['Cost per Course (Green Fee Range)'] || '';
              const lodging = r['Lodging On-Site (Yes/No)'] || '';
              const url = r['Website URL'] || '';
              const phone = r['Phone'] || '';

              const html = `
                <div style="min-width:220px">
                  <strong>${name}</strong>${resort ? ` <br/><em>${resort}</em>` : ''}
                  <div>${city}${city && state ? ', ' : ''}${state}</div>
                  ${fee ? `<div><b>Fees:</b> ${fee}</div>` : ''}
                  ${lodging ? `<div><b>Lodging:</b> ${lodging}</div>` : ''}
                  ${phone ? `<div><b>Phone:</b> ${phone}</div>` : ''}
                  ${url ? `<div><a href="${url}" target="_blank" rel="noopener">Website</a></div>` : ''}
                </div>
              `;

              const m = L.marker([lat, lon]).bindPopup(html);
              m.addTo(map);
              markers.push(m);
              bounds.extend([lat, lon]);
            }
          });

          if (markers.length > 0) {
            map.fitBounds(bounds.pad(0.15));
          } else {
            console.warn('CSV loaded but no valid Latitude/Longitude found.');
          }
        },
        error: (err) => {
          console.error('Failed to parse CSV:', err);
          alert('Could not load the CSV. Open DevTools → Console for details.');
        }
      });
    }

    // Debug helper: add ?debug=1 to URL to print extra info
    if (getParam('debug') === '1') {
      console.log('Debug mode ON. URL:', window.location.href);
    }
  </script>
</body>
</html>
