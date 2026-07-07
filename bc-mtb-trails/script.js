(function(){
  const map = L.map('map', { zoomControl:false }).setView([49.28, -123.14], 11); // North Shore, Vancouver default
  L.control.zoom({position:'bottomright'}).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const regions = [
    {name:"North Shore", lat:49.365, lon:-123.05, z:13},
    {name:"Squamish", lat:49.70, lon:-123.15, z:12},
    {name:"Whistler", lat:50.10, lon:-122.95, z:12},
    {name:"Kelowna", lat:49.89, lon:-119.50, z:12},
    {name:"Nelson", lat:49.49, lon:-117.29, z:12},
    {name:"Rossland", lat:49.08, lon:-117.80, z:13},
    {name:"Cumberland", lat:49.62, lon:-125.03, z:13},
    {name:"Fernie", lat:49.50, lon:-115.06, z:12},
  ];

  const quickJump = document.getElementById('quickJump');
  regions.forEach(r=>{
    const btn = document.createElement('button');
    btn.textContent = r.name;
    btn.onclick = ()=> map.setView([r.lat, r.lon], r.z);
    quickJump.appendChild(btn);
  });

  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('toggle-sidebar');
  let sidebarOpen = true;
  toggleBtn.addEventListener('click', ()=>{
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('collapsed', !sidebarOpen);
    toggleBtn.classList.toggle('shifted', sidebarOpen);
    setTimeout(()=>map.invalidateSize(), 260);
  });
  toggleBtn.classList.add('shifted');

  const statusLine = document.getElementById('statusLine');
  const searchBtn = document.getElementById('searchBtn');
  const statTrails = document.getElementById('statTrails');
  const statKm = document.getElementById('statKm');

  let trailLayer = L.layerGroup().addTo(map);
  let allFeatures = []; // polylines with a ._diffClass tag

  const diffColors = { easy:'#3F8F4F', inter:'#2F6FA8', diff:'#262626', extreme:'#8B1A1A', unknown:'#999999' };
  const diffLabels = { easy:'Easy', inter:'Intermediate', diff:'Difficult', extreme:'Extreme', unknown:'Unrated' };

  function classify(scale){
    if (scale === null || scale === undefined || isNaN(scale)) return 'unknown';
    if (scale <= 1) return 'easy';
    if (scale === 2) return 'inter';
    if (scale === 3 || scale === 4) return 'diff';
    return 'extreme'; // 5, 6
  }

  function haversine(a, b){
    const R = 6371;
    const toRad = d => d * Math.PI/180;
    const dLat = toRad(b[0]-a[0]);
    const dLon = toRad(b[1]-a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return R * 2 * Math.asin(Math.sqrt(h));
  }

  function lineLengthKm(coords){
    let total = 0;
    for (let i=1;i<coords.length;i++) total += haversine(coords[i-1], coords[i]);
    return total;
  }

  async function searchArea(){
    const b = map.getBounds();
    const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    const areaKm2 = (haversine([b.getSouth(),b.getWest()],[b.getSouth(),b.getEast()]) * haversine([b.getSouth(),b.getWest()],[b.getNorth(),b.getWest()]));
    if (areaKm2 > 4000) {
      statusLine.textContent = "Zoom in a bit further — area too large for one query.";
      return;
    }

    searchBtn.disabled = true;
    statusLine.textContent = "Querying OpenStreetMap (Overpass)...";
    trailLayer.clearLayers();
    allFeatures = [];

    const query = `
      [out:json][timeout:25];
      (
        way["mtb:scale"](${bbox});
        way["mtb:scale:uphill"](${bbox});
        way["route"="mtb"](${bbox});
        relation["route"="mtb"](${bbox});
      );
      out geom;
    `;

    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter'
    ];

    let lastErr = null;
    let data = null;

    for (const endpoint of endpoints) {
      try {
        statusLine.textContent = "Querying " + new URL(endpoint).hostname + "...";
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query)
        });
        const raw = await resp.text();
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + raw.slice(0, 200));
        try {
          data = JSON.parse(raw);
        } catch(parseErr) {
          throw new Error('Non-JSON response: ' + raw.slice(0, 200));
        }
        lastErr = null;
        break; // success
      } catch(err){
        lastErr = err;
        console.warn('Endpoint failed:', endpoint, err);
      }
    }

    if (lastErr) {
      statusLine.textContent = "All Overpass endpoints failed: " + lastErr.message + ". This is likely a network/firewall/ad-blocker block on your end — try a different network, disable ad blockers for this page, or open the file in an incognito window.";
      console.error(lastErr);
    } else {
      console.log('Overpass returned', (data.elements || []).length, 'elements');
      renderElements(data.elements || []);
    }
    searchBtn.disabled = false;
  }

  function renderElements(elements){
    let totalKm = 0;
    let count = 0;
    const seenWayIds = new Set();

    function addWay(el){
      if (!el.geometry || el.geometry.length < 2) return;
      if (seenWayIds.has(el.id)) return;
      seenWayIds.add(el.id);

      const coords = el.geometry.map(p => [p.lat, p.lon]);
      const tags = el.tags || {};
      const scaleRaw = tags['mtb:scale'];
      const scale = scaleRaw !== undefined ? parseInt(scaleRaw.toString().replace(/[^0-9]/g,''), 10) : NaN;
      const diffClass = classify(scale);
      const name = tags.name || 'Unnamed trail';
      const km = lineLengthKm(coords);
      totalKm += km;
      count++;

      const line = L.polyline(coords, {
        color: diffColors[diffClass],
        weight: 4,
        opacity: 0.9
      });

      const badgeColor = diffColors[diffClass];
      line.bindPopup(`
        <div class="popup-title">${escapeHtml(name)}</div>
        <div class="popup-row"><span class="diff-badge" style="background:${badgeColor}">${diffLabels[diffClass]}</span></div>
        <div class="popup-row"><b>Length:</b> ${km.toFixed(2)} km</div>
        ${tags.surface ? `<div class="popup-row"><b>Surface:</b> ${escapeHtml(tags.surface)}</div>` : ''}
        ${tags['mtb:scale'] ? `<div class="popup-row"><b>mtb:scale:</b> ${escapeHtml(tags['mtb:scale'])}</div>` : ''}
        <div class="popup-row"><b>OSM way:</b> <a href="https://www.openstreetmap.org/way/${el.id}" target="_blank" style="color:var(--moss)">#${el.id}</a></div>
      `);

      line._diffClass = diffClass;
      allFeatures.push(line);
    }

    elements.forEach(el=>{
      if (el.type === 'way') addWay(el);
      else if (el.type === 'relation' && el.members){
        el.members.forEach(m=>{ if (m.type==='way' && m.geometry) addWay({id:m.ref, geometry:m.geometry, tags: el.tags}); });
      }
    });

    applyFilters();
    statTrails.textContent = count;
    statKm.textContent = totalKm.toFixed(0);
    statusLine.textContent = count > 0
      ? `Loaded ${count} trail segment(s).`
      : "No tagged MTB trails found here. Try a known trail town or zoom out slightly.";
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  function applyFilters(){
    trailLayer.clearLayers();
    const active = new Set();
    document.querySelectorAll('.filter-row input').forEach(cb=>{ if (cb.checked) active.add(cb.dataset.diff); });
    allFeatures.forEach(line=>{
      if (active.has(line._diffClass)) trailLayer.addLayer(line);
    });
  }

  document.querySelectorAll('.filter-row input').forEach(cb=> cb.addEventListener('change', applyFilters));
  searchBtn.addEventListener('click', searchArea);
})();
