/* app.js -- city loading, maps, and view rendering.
   Every rendered figure reads from a city bundle (data/bundles/*.json for the
   two committed cities, or a bundle CADEngine built live from an upload), so
   all three views and the race dock always describe the same city. */
(function (global) {
  'use strict';

  var state = { bundles: {}, current: null, maps: {}, layers: {}, sim: null };

  function $(id) { return document.getElementById(id); }
  function fmt(n, d) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d });
  }

  /** static value -> dynamic value, the app's most repeated figure. */
  function delta(from, to) {
    return '<span class="delta"><span class="from">' + from + '</span>' +
      Icons.svg('arrowRight', 11) + '<span class="to">' + to + '</span></span>';
  }

  /* ---------------------------------------------------------------- maps */

  /* Read a CSS custom property so JS-drawn things (map tiles, SVG charts,
     Leaflet markers) follow the same tokens as the stylesheet. */
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function isLight() { return document.documentElement.getAttribute('data-theme') === 'light'; }

  function tiles() {
    var style = isLight() ? 'light_all' : 'dark_all';
    return L.tileLayer('https://{s}.basemaps.cartocdn.com/' + style + '/{z}/{x}/{y}{r}.png',
      { attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19 });
  }

  function ensureMap(id, center) {
    if (!state.maps[id]) {
      state.maps[id] = L.map(id, { zoomControl: id === 'mapOverview', attributionControl: id === 'mapOverview' })
        .setView(center, 12);
      tiles().addTo(state.maps[id]);
      state.layers[id] = L.layerGroup().addTo(state.maps[id]);
    } else {
      state.layers[id].clearLayers();
      state.maps[id].setView(center, 12);
    }
    setTimeout(function () { state.maps[id].invalidateSize(); }, 60);
    return { map: state.maps[id], layer: state.layers[id] };
  }

  // Sequential demand ramp in the accent hue: cool slate -> amber -> hot red.
  // Two value sets so the ramp keeps contrast against either basemap.
  var RAMP_DARK = [[96, 110, 133], [245, 165, 36], [240, 68, 56]];
  var RAMP_LIGHT = [[130, 146, 166], [217, 119, 6], [185, 28, 28]];

  function demandColor(w, maxW) {
    var t = Math.min(1, w / maxW);
    var stops = isLight() ? RAMP_LIGHT : RAMP_DARK;
    var seg = t < 0.5 ? 0 : 1, lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    var c = stops[seg].map(function (v, i) { return Math.round(v + (stops[seg + 1][i] - v) * lt); });
    return 'rgb(' + c.join(',') + ')';
  }

  function paintLegend() {
    var stops = isLight() ? RAMP_LIGHT : RAMP_DARK;
    [['lgLow', 0], ['lgMid', 1], ['lgHigh', 2]].forEach(function (p) {
      var node = $(p[0]);
      if (node) node.style.background = 'rgb(' + stops[p[1]].join(',') + ')';
    });
  }

  function drawDemand(layer, zones, scale, opacity) {
    var maxW = Math.max.apply(null, zones.map(function (z) { return z.weight; }));
    zones.forEach(function (z, i) {
      var color = demandColor(z.weight, maxW);
      L.circle([z.lat, z.lng], {
        radius: 380 + z.weight * scale, color: color, fillColor: color,
        fillOpacity: opacity, weight: 1
      }).addTo(layer).bindTooltip('Zone ' + i + ' &middot; ' + fmt(z.calls) + ' real calls');
    });
  }

  function postMarker(rank, opts) {
    var small = opts && opts.small;
    var size = small ? 13 : 25;
    var html = small
      ? '<div class="post-pin small"></div>'
      : '<div class="post-pin num">' + rank + '</div>';
    return L.divIcon({ className: '', html: html, iconSize: [size, size] });
  }

  /* ------------------------------------------------------------ overview */

  var selectedRank = 0;

  function renderOverview(b) {
    var s = b.summary;
    var m = ensureMap('mapOverview', b.center);

    countUp($('heroPct'), s.pct_improvement, 1);
    $('heroSub').innerHTML = 'faster average response in <b>' + b.name + '</b>, simulated over ' +
      fmt(s.n_calls) + ' real 911 calls (' + s.sim_days + ' days). Same fleet, same calls — only the staging policy changes.';

    var maxAvg = Math.max(s.avg_response_min_static, s.avg_response_min_dynamic);
    $('vsFillS').style.width = (s.avg_response_min_static / maxAvg * 100) + '%';
    $('vsFillD').style.width = (s.avg_response_min_dynamic / maxAvg * 100) + '%';
    $('vsValS').textContent = s.avg_response_min_static.toFixed(2) + ' min';
    $('vsValD').textContent = s.avg_response_min_dynamic.toFixed(2) + ' min';

    $('kMinutes').textContent = fmt(s.minutes_saved_total, 0);
    $('kHours').textContent = fmt(s.minutes_saved_total / 60, 0) + ' ambulance-hours returned over ' + s.sim_days + ' days';
    $('kWithin').innerHTML = delta(s.pct_within_standard_static.toFixed(1), s.pct_within_standard_dynamic.toFixed(1) + '%');
    $('kP90').innerHTML = delta(s.p90_response_min_static.toFixed(1), s.p90_response_min_dynamic.toFixed(1));
    $('kMedian').innerHTML = delta(s.median_response_min_static.toFixed(2), s.median_response_min_dynamic.toFixed(2));
    $('kSig').textContent = s.wilcoxon_p_value < 1e-12
      ? 'p < 10^' + Math.ceil(Math.log10(s.wilcoxon_p_value))
      : 'p = ' + s.wilcoxon_p_value.toExponential(1);
    $('kSigNote').textContent = 'Wilcoxon signed-rank on paired per-call response times' +
      (b.uploaded ? ' (normal approximation, n=' + fmt(s.n_calls) + ')' : '');
    $('kFleet').textContent = fmt(s.n_ambulances) + ' units · ' + s.k_zones + ' posts';
    $('kWindow').innerHTML = '<span class="delta"><span class="from">' + String(s.window_start).slice(0, 10) +
      '</span>' + Icons.svg('arrowRight', 11) + '<span>' + String(s.window_end).slice(0, 10) + '</span></span>';

    $('srcLine').innerHTML = b.source_url
      ? b.blurb + ' · <a href="' + b.source_url + '" target="_blank" rel="noopener" >open data source</a>'
      : b.blurb;

    drawDemand(m.layer, b.zones, 7200, 0.22);

    var seenZone = {};
    var list = $('postList');
    list.innerHTML = '';
    b.home_bases.forEach(function (p, i) {
      var dup = seenZone[p.zone_id];
      seenZone[p.zone_id] = true;
      var label = p.street || ('Post at zone ' + p.zone_id);
      var marker = L.marker([p.lat, p.lng], { icon: postMarker(i + 1) }).addTo(m.layer);
      marker.on('click', function () { selectPost(i, true); });

      var card = document.createElement('div');
      card.className = 'post-card';
      card.dataset.rank = i;
      card.innerHTML = '<div class="rank-badge num">' + (i + 1) + '</div><div class="post-info">' +
        '<div class="street">' + label + '</div><div class="hood">' +
        (p.neighborhood ? p.neighborhood + ' · ' : '') +
        (dup ? 'second unit at this post' : 'staged post') + '</div></div>';
      card.addEventListener('click', function () { selectPost(i, true); });
      list.appendChild(card);
    });

    function selectPost(rank, userInitiated) {
      selectedRank = rank;
      document.querySelectorAll('#postList .post-card').forEach(function (c) { c.classList.remove('selected'); });
      var card = document.querySelector('#postList .post-card[data-rank="' + rank + '"]');
      if (card) {
        card.classList.add('selected');
        // Only chase the selection on a real click -- scrolling on the initial
        // auto-select would push the headline number out of view on load.
        if (userInitiated) card.scrollIntoView({ block: 'nearest' });
      }
      var p = b.home_bases[rank];
      // Only fly on a click: on first render the container has no size yet and
      // Leaflet's flyTo projects to NaN and throws, which used to abort the rest
      // of setCity (race dock included). It also keeps the opening shot city-wide.
      if (userInitiated) m.map.flyTo([p.lat, p.lng], 14, { duration: 0.6 });
      var box = $('postDetail');
      box.style.display = 'block';
      box.innerHTML =
        '<div style="display:flex;align-items:center;gap:9px"><div class="rank-badge num" style="background:var(--primary);color:var(--primary-fg);border-color:var(--primary)">' + (rank + 1) + '</div>' +
        '<h3>' + (p.street || 'Staging post') + '</h3></div>' +
        '<div class="addr">' + (p.display_name || (p.lat.toFixed(5) + ', ' + p.lng.toFixed(5))) + '</div>' +
        '<div class="mini-row">' +
        '<div class="mini"><div class="l">Compliance rank</div><div class="v num">#' + (rank + 1) + ' of ' + b.home_bases.length + '</div></div>' +
        '<div class="mini"><div class="l">Zone demand</div><div class="v num">' + fmt(b.zones[p.zone_id].calls) + ' calls</div></div>' +
        '<div class="mini"><div class="l">City-wide gain</div><div class="v num" style="color:var(--dynamic)">' + s.pct_improvement + '%</div></div>' +
        '</div>';
    }

    selectPost(0);
  }

  function countUp(node, target, decimals) {
    var start = performance.now(), dur = 700;
    // setInterval, not rAF -- see race.js: rAF stalls on a backgrounded tab and
    // would leave the headline number stuck at zero.
    var timer = setInterval(function () {
      var k = Math.min(1, (performance.now() - start) / dur);
      node.textContent = (target * (1 - Math.pow(1 - k, 3))).toFixed(decimals);
      if (k >= 1) { node.textContent = target.toFixed(decimals); clearInterval(timer); }
    }, 16);
  }

  /* ---------------------------------------------------- under the hood  */

  function renderHood(b) {
    var s = b.summary;
    var m = ensureMap('mapDemand', b.center);
    drawDemand(m.layer, b.zones, 18000, 0.45);
    b.home_bases.forEach(function (h, i) {
      L.marker([h.lat, h.lng], { icon: postMarker(i + 1, { small: true }) })
        .addTo(m.layer).bindTooltip('Compliance rank #' + (i + 1));
    });

    $('statQ').textContent = s.busy_fraction_q;
    $('statStandard').textContent = s.response_standard_min + ' min';
    $('routingSource').textContent = s.routing_source;

    var rankOf = {};
    b.compliance_table.forEach(function (z, i) { rankOf[z] = i + 1; });
    var maxCalls = Math.max.apply(null, b.zones.map(function (z) { return z.calls; }));
    var tbody = document.querySelector('#zoneTable tbody');
    tbody.innerHTML = '';
    b.zones.map(function (z, i) { return { z: z, i: i }; })
      .sort(function (a, c) { return c.z.calls - a.z.calls; })
      .forEach(function (row) {
        var color = demandColor(row.z.weight, Math.max.apply(null, b.zones.map(function (x) { return x.weight; })));
        var tr = document.createElement('tr');
        tr.innerHTML = '<td><span class="swatch" style="background:' + color + '"></span></td>' +
          '<td class="num">' + row.i + '</td>' +
          '<td class="bar-cell"><div class="tbar" style="width:' + (row.z.calls / maxCalls * 100) + '%"></div></td>' +
          '<td class="num">' + fmt(row.z.calls) + '</td>' +
          '<td class="num">' + (rankOf[row.i] ? '<span class="staffed">#' + rankOf[row.i] + '</span>' : '—') + '</td>';
        tbody.appendChild(tr);
      });

    Charts.histogram($('chartHist'), b.hist, s.response_standard_min);
    Charts.cumulative($('chartCum'), b.cumulative);
    Charts.savedArea($('chartSaved'), b.cumulative);
    $('chartHistSub').textContent = fmt(s.n_calls) + ' calls';
    $('calibNote').textContent = b.calibration.note ||
      ('Real OSRM legs measured for this city: ' + fmt(b.calibration.n_real_legs) +
       ' (median effective straight-line speed ' + b.calibration.median_effective_straight_line_mph +
       ' mph, median road detour ' + b.calibration.median_road_detour_factor + 'x).');

    var fc = $('forecastCard');
    if (b.id === 'seattle' && global._forecast) {
      var f = global._forecast, mm = f.holdout_metrics;
      fc.style.display = '';
      $('forecastSummary').textContent = 'Gradient-boosted regressor trained on ' + fmt(f.n_train_hours) +
        ' real hourly call-volume observations. Held out the last ' + f.n_test_hours +
        ' real hours: MAE ' + mm.model_mae + ' calls/hr vs ' + mm.naive_baseline_mae +
        ' for a naive historical-average baseline (' + (mm.mae_improvement_pct_vs_naive > 0 ? '+' : '') +
        mm.mae_improvement_pct_vs_naive + '%).';
      $('forecastNext').innerHTML = 'Next hour (' + f.next_24h_forecast[0].datetime.slice(11, 16) + '): <b>' +
        f.next_24h_forecast[0].predicted_calls.toFixed(1) + ' predicted calls</b>';
    } else {
      fc.style.display = 'none';
    }

    if (b.summary.REAL_measured_response_min_median) {
      $('realCheck').style.display = '';
      $('realCheckBody').innerHTML =
        'This city\'s CAD export also records ACTUAL arrival times. Real measured response across ' +
        fmt(b.summary.REAL_measured_n) + ' calls: median <b>' + b.summary.REAL_measured_response_min_median +
        ' min</b>, p90 <b>' + b.summary.REAL_measured_response_min_p90 + ' min</b> — the simulated distribution ' +
        '(median ' + s.median_response_min_dynamic + ', p90 ' + s.p90_response_min_dynamic + ') lands in the same range. ' +
        'Realism check only: the real fleet size and post locations are unknown from this export, so this is not a causal real-vs-model comparison.';
    } else {
      $('realCheck').style.display = 'none';
    }
  }

  /* ------------------------------------------------------- live sim view */

  function renderSim(b) {
    var m = ensureMap('mapSim', b.center);
    drawDemand(m.layer, b.zones, 14000, 0.16);
    $('simDateLabel').textContent = 'Replaying real calls from ' + b.race.date + ' (' +
      fmt(b.race.n_calls) + ' calls, busiest day in the ' + b.summary.sim_days + '-day window)';
    loadStrategy($('strategySelect').value);
  }

  function loadStrategy(strategy) {
    var b = state.current, m = state.maps.mapSim, layer = state.layers.mapSim;
    if (!b || !m) return;
    if (state.sim && state.sim.timer) clearInterval(state.sim.timer);
    if (state.sim && state.sim.units) state.sim.units.forEach(function (u) { m.removeLayer(u); });

    var events = strategy === 'static' ? b.race.static_events : b.race.dynamic_events;
    var units = [];
    b.home_bases.forEach(function (h) {
      units.push(L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: '', html: '<div class="amb-icon">' + Icons.svg('ambulance', 13) + '</div>', iconSize: [22, 22] })
      }).addTo(m));
    });
    state.sim = { events: events, idx: 0, playing: false, timer: null, units: units,
                  respTotal: 0, respCount: 0, delayed: 0, lastIdle: undefined };
    $('timeline').max = Math.max(1, events.length - 1);
    $('timeline').value = 0;
    $('lastEvent').textContent = '—';
    $('playBtn').innerHTML = Icons.svg('play', 13) + 'Play';
    updateSimStats();
  }

  function stepForward() {
    var sim = state.sim, b = state.current, map = state.maps.mapSim;
    if (!sim || sim.idx >= sim.events.length) { pauseSim(); return; }
    var ev = sim.events[sim.idx];
    var unit = sim.units[ev.ambulance_id];
    if (unit) unit.setLatLng([ev.to_lat, ev.to_lng]);

    var flash = token('--static');
    var dot = L.circleMarker([ev.call_lat, ev.call_lng],
      { radius: 6, color: flash, fillColor: flash, fillOpacity: 0.9, weight: 1 }).addTo(map);
    setTimeout(function () { map.removeLayer(dot); }, 900);

    sim.respTotal += ev.response_min;
    sim.respCount++;
    if (ev.wait_min > 0) sim.delayed++;
    sim.lastIdle = ev.n_idle_at_arrival;
    $('lastEvent').textContent = ev.t.split('T')[1].slice(0, 8) + ' · Unit ' + ev.ambulance_id +
      ' dispatched, ' + ev.response_min.toFixed(1) + ' min response' +
      (ev.wait_min > 0 ? ' (waited ' + ev.wait_min.toFixed(1) + ' min — no idle unit)' : '');
    sim.idx++;
    $('timeline').value = sim.idx;
    updateSimStats();
  }

  function updateSimStats() {
    var sim = state.sim, b = state.current;
    if (!sim) return;
    $('statCalls').textContent = fmt(sim.respCount);
    $('statAvgResp').textContent = sim.respCount ? (sim.respTotal / sim.respCount).toFixed(1) + ' min' : '—';
    $('statDelayed').textContent = fmt(sim.delayed);
    var n = b.summary.n_ambulances;
    var idle = sim.lastIdle === undefined ? n : sim.lastIdle;
    $('statBusy').textContent = (n - idle) + ' / ' + n;
  }

  function playSim() {
    var sim = state.sim;
    if (!sim || sim.playing) return;
    sim.playing = true;
    $('playBtn').innerHTML = Icons.svg('pause', 13) + 'Pause';
    sim.timer = setInterval(stepForward, +$('speedSelect').value);
  }
  function pauseSim() {
    var sim = state.sim;
    if (!sim) return;
    sim.playing = false;
    $('playBtn').innerHTML = Icons.svg('play', 13) + 'Play';
    clearInterval(sim.timer);
  }

  /* -------------------------------------------------------- city loading */

  function setCity(bundle) {
    state.current = bundle;
    document.querySelectorAll('.citychip').forEach(function (c) {
      c.classList.toggle('active', c.dataset.city === bundle.id);
    });
    $('cityName').textContent = bundle.name;
    // Each view is isolated: a render failure in one must not take down the
    // others (the race dock in particular is the thing people came to see).
    [renderOverview, renderHood, renderSim].forEach(function (fn) {
      try { fn(bundle); } catch (e) { console.error(fn.name + ' failed:', e); }
    });
    Race.load(bundle);
    setTimeout(function () { Race.play(); }, 450);
  }

  function loadCity(id) {
    if (state.bundles[id]) { setCity(state.bundles[id]); return Promise.resolve(); }
    return fetch('../data/bundles/' + id + '.json')
      .then(function (r) { if (!r.ok) throw new Error('bundle ' + id + ' not found'); return r.json(); })
      .then(function (b) { state.bundles[id] = b; setCity(b); })
      .catch(function (e) { console.error(e); alert('Could not load ' + id + ': ' + e.message); });
  }

  function registerUploaded(bundle) {
    bundle.id = 'upload';
    state.bundles.upload = bundle;
    var chip = $('chipUpload');
    chip.innerHTML = '<span class="dot"></span>' + bundle.short;
    chip.classList.remove('ghost');
    chip.dataset.city = 'upload';
    setCity(bundle);
  }

  /* ---------------------------------------------------------- upload UI */

  var STEPS = [
    ['parse', 'Read the CAD export', 'Streaming CSV parse, quoted fields and all'],
    ['columns', 'Detect the schema', 'Finds lat / lng / timestamp columns by name and by value range'],
    ['clean', 'Clean the call stream', 'Drops ungeocoded rows and bad-geocode outliers, sorts by time'],
    ['zones', 'Cluster demand zones', 'k-means++ over real call locations'],
    ['routing', 'Build travel-time matrices', 'Great-circle distance at the OSRM-measured speed'],
    ['fleet', 'Size the fleet', 'Peak-hour Erlangs + 40% headroom, and the busy fraction q'],
    ['mexclp', 'Rank posts (MEXCLP)', 'Daskin 1983 greedy maximum expected coverage'],
    ['sim_static', 'Simulate static dispatch', 'Fixed home posts over the real call stream'],
    ['sim_dynamic', 'Simulate dynamic restaging', 'Idle units re-fill the compliance table'],
    ['stats', 'Test the difference', 'Wilcoxon signed-rank on paired per-call times']
  ];

  function buildPipelineUI() {
    var wrap = $('pipeline');
    wrap.innerHTML = '';
    STEPS.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'pstep';
      d.id = 'step-' + s[0];
      d.innerHTML = '<div class="icon">' + Icons.svg('dot', 10) + '</div><div><div class="ptitle">' + s[1] +
        '</div><div class="pdesc">' + s[2] + '</div></div><div class="presult"></div>';
      wrap.appendChild(d);
    });
  }

  function stepResult(key, detail) {
    var node = $('step-' + key);
    if (!node) return;
    node.classList.remove('active');
    node.classList.add('done');
    node.querySelector('.icon').innerHTML = Icons.svg('check', 13);
    var txt = '';
    switch (key) {
      case 'parse': txt = fmt(detail.rows) + ' rows × ' + detail.columns + ' cols'; break;
      case 'columns': txt = detail.lat + ' / ' + detail.lng + ' / ' + detail.time; break;
      case 'clean': txt = fmt(detail.calls) + ' calls · ' + detail.span_days + ' days'; break;
      case 'zones': txt = detail.k + ' zones · busiest ' + detail.busiest_share + '%'; break;
      case 'routing': txt = fmt(detail.legs) + ' legs @ ' + detail.mph + ' mph'; break;
      case 'fleet': txt = detail.n_ambulances + ' units · q = ' + detail.q; break;
      case 'mexclp': txt = 'top posts: ' + detail.table.slice(0, 5).join(', '); break;
      case 'sim_static': txt = detail.avg + ' min avg'; break;
      case 'sim_dynamic': txt = detail.avg + ' min avg'; break;
      case 'stats': txt = detail.pct + '% faster · p = ' + detail.p.toExponential(1); break;
      default: return;
    }
    node.querySelector('.presult').textContent = txt;
  }

  function markActive(key) {
    var node = $('step-' + key);
    if (node) node.classList.add('active');
  }

  function runUpload(text, fileName) {
    buildPipelineUI();
    $('uploadErr').style.display = 'none';
    $('uploadResult').style.display = 'none';
    $('pipelineWrap').style.display = '';
    var name = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    var queue = STEPS.map(function (s) { return s[0]; });
    var qi = 0;

    // Run each stage on its own frame so the pipeline visibly advances.
    var pending = [];
    setTimeout(function () {
      try {
        markActive(queue[0]);
        var bundle = CADEngine.run(text, { name: name, fileName: fileName }, function (key, detail) {
          pending.push([key, detail]);
        });
        (function drain() {
          if (!pending.length) { showUploadResult(bundle); return; }
          var item = pending.shift();
          stepResult(item[0], item[1]);
          qi++;
          if (queue[qi]) markActive(queue[qi]);
          setTimeout(drain, 190);
        })();
      } catch (e) {
        $('pipelineWrap').style.display = 'none';
        $('uploadErr').style.display = '';
        $('uploadErrMsg').textContent = e.message;
      }
    }, 60);
  }

  function showUploadResult(bundle) {
    var s = bundle.summary;
    $('uploadResult').style.display = '';
    $('urCity').textContent = bundle.name;
    $('urPct').textContent = s.pct_improvement + '%';
    $('urStatic').textContent = s.avg_response_min_static.toFixed(2) + ' min';
    $('urDynamic').textContent = s.avg_response_min_dynamic.toFixed(2) + ' min';
    $('urCalls').textContent = fmt(s.n_calls);
    $('urFleet').textContent = s.n_ambulances + ' units';
    $('urP').textContent = s.wilcoxon_p_value < 1e-12
      ? 'p < 10^' + Math.ceil(Math.log10(s.wilcoxon_p_value)) : 'p = ' + s.wilcoxon_p_value.toExponential(1);
    $('urOpen').onclick = function () {
      registerUploaded(bundle);
      switchView('vOverview');
    };
  }

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { runUpload(String(reader.result), file.name); };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------- wiring */

  function switchView(id) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === id); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === id); });
    setTimeout(function () {
      Object.keys(state.maps).forEach(function (k) { state.maps[k].invalidateSize(); });
    }, 60);
  }

  /* ------------------------------------------------------------- theming */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ems-theme', theme);
    paintLegend();
    // Basemap tiles and the demand overlay are colour-baked at draw time, so
    // both have to be rebuilt -- swapping CSS alone would leave a dark basemap
    // under a light UI.
    Object.keys(state.maps).forEach(function (id) {
      var map = state.maps[id];
      map.eachLayer(function (l) { if (l instanceof L.TileLayer) map.removeLayer(l); });
      tiles().addTo(map);
    });
    if (state.current) {
      [renderOverview, renderHood, renderSim].forEach(function (fn) {
        try { fn(state.current); } catch (e) { console.error(fn.name + ' failed:', e); }
      });
    }
  }

  function redrawCharts() {
    var b = state.current;
    if (!b) return;
    Charts.histogram($('chartHist'), b.hist, b.summary.response_standard_min);
    Charts.cumulative($('chartCum'), b.cumulative);
    Charts.savedArea($('chartSaved'), b.cumulative);
  }

  function init() {
    Icons.hydrate();
    paintLegend();
    Race.init();

    $('themeToggle').addEventListener('click', function () {
      applyTheme(isLight() ? 'dark' : 'light');
    });

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.dataset.view); });
    });
    document.querySelectorAll('.subtab').forEach(function (st) {
      st.addEventListener('click', function () {
        document.querySelectorAll('.subtab').forEach(function (s) { s.classList.remove('active'); });
        document.querySelectorAll('.subview').forEach(function (v) { v.classList.remove('active'); });
        st.classList.add('active');
        $(st.dataset.sub).classList.add('active');
        setTimeout(function () {
          Object.keys(state.maps).forEach(function (k) { state.maps[k].invalidateSize(); });
          if (st.dataset.sub === 'sProof') redrawCharts();
        }, 60);
      });
    });
    document.querySelectorAll('.citychip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        if (chip.id === 'chipUpload' && !state.bundles.upload) { switchView('vUpload'); return; }
        loadCity(chip.dataset.city);
      });
    });

    $('playBtn').addEventListener('click', function () {
      state.sim && state.sim.playing ? pauseSim() : playSim();
    });
    $('resetBtn').addEventListener('click', function () { pauseSim(); loadStrategy($('strategySelect').value); });
    $('strategySelect').addEventListener('change', function (e) { pauseSim(); loadStrategy(e.target.value); });
    $('speedSelect').addEventListener('change', function () {
      if (state.sim && state.sim.playing) { pauseSim(); playSim(); }
    });
    $('timeline').addEventListener('input', function (e) {
      pauseSim();
      var target = +e.target.value;
      loadStrategy($('strategySelect').value);
      while (state.sim.idx < target) stepForward();
    });

    var dz = $('dropzone');
    dz.addEventListener('click', function () { $('fileInput').click(); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); dz.classList.remove('over');
      readFile(e.dataTransfer.files[0]);
    });
    $('fileInput').addEventListener('change', function (e) { readFile(e.target.files[0]); });
    $('calibLine').textContent = CADEngine.CALIBRATION.note;

    fetch('../data/demand_forecast.json').then(function (r) { return r.json(); })
      .then(function (f) { global._forecast = f; if (state.current) renderHood(state.current); })
      .catch(function () {});

    var resizeTimer;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(redrawCharts, 180);
    });

    loadCity('seattle');
  }

  global.App = { init: init, switchView: switchView };
  document.addEventListener('DOMContentLoaded', init);
})(window);
