/*
 * cad_engine.js -- the relocation model, reimplemented in the browser so that
 * ANY city's CAD export can be run live in the demo without a Python round-trip.
 *
 * It is a faithful port of the Python pipeline (src/simulate_dynamic.py):
 * k-means demand zones -> Daskin (1983) greedy MEXCLP compliance table ->
 * paired static vs. dynamic queueing simulation over the same real call
 * stream -> Wilcoxon signed-rank test.
 *
 * ONE HONEST DIFFERENCE from the Python pipeline, surfaced in the UI: the
 * server-side runs use REAL OSRM road-network driving times. A browser can't
 * ship a 500k-leg routing matrix, so uploads estimate travel time from
 * great-circle distance using a speed constant MEASURED from those real OSRM
 * legs (see CALIBRATION below) rather than a guessed mph figure. Rankings hold
 * up well under that estimate; absolute minutes are approximate until you
 * re-run precompute_routing.py against OSRM for the new city.
 */
(function (global) {
  'use strict';

  // Measured, not assumed: median effective straight-line speed implied by
  // every real OSRM leg in both committed cities (see osrm_speed_calibration()
  // in src/export_city_bundles.py). Seattle 18.94 mph over 279,385 legs;
  // Cincinnati 19.53 mph over 213,789 legs.
  var CALIBRATION = {
    mph: 19.2,
    n_real_legs: 493174,
    detour_factor: 1.34,
    note: 'Great-circle distance converted to drive time at 19.2 mph -- the median ' +
          'effective straight-line speed measured across 493,174 real OSRM road legs ' +
          'in Seattle and Cincinnati (median road detour factor 1.34x).'
  };

  var SERVICE_MEAN_MIN = 50;      // same disclosed assumption as the Python model
  var RESPONSE_STANDARD_MIN = 8;
  var K_ZONES = 20;
  var SEED = 42;
  var MAX_CALLS = 60000;          // keeps an oversized upload from hanging the tab

  /* ---------------------------------------------------------------- utils */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    var u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function haversineMiles(lat1, lng1, lat2, lng2) {
    var r = 3958.8, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  function travelSec(lat1, lng1, lat2, lng2) {
    return haversineMiles(lat1, lng1, lat2, lng2) / CALIBRATION.mph * 3600;
  }

  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    var i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  /* ------------------------------------------------------------ csv input */

  function parseCSV(text, maxRows) {
    var rows = [], row = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
        if (maxRows && rows.length > maxRows) break;
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    var headers = rows.shift() || [];
    return { headers: headers.map(function (h) { return h.trim(); }), rows: rows };
  }

  var LAT_HINTS = ['latitude', 'lat', 'y', 'ycoord', 'lat_deg'];
  var LNG_HINTS = ['longitude', 'lon', 'lng', 'long', 'x', 'xcoord'];
  var TIME_HINTS = ['datetime', 'create_time_incident', 'received', 'call_time', 'time',
                    'timestamp', 'date', 'reported', 'dispatch'];
  var TYPE_HINTS = ['type', 'incident_type_id', 'incident_type', 'call_type', 'nature',
                    'description', 'final_type'];

  function detectColumns(headers, rows) {
    var norm = headers.map(function (h) { return h.toLowerCase().replace(/[^a-z_]/g, ''); });
    function pick(hints, validate) {
      var best = -1, bestScore = -1;
      for (var i = 0; i < norm.length; i++) {
        for (var j = 0; j < hints.length; j++) {
          if (norm[i] === hints[j] || norm[i].indexOf(hints[j]) >= 0) {
            var score = (norm[i] === hints[j] ? 100 : 50) - j;
            if (validate && !validate(i)) continue;
            if (score > bestScore) { bestScore = score; best = i; }
          }
        }
      }
      return best;
    }
    function numericIn(i, lo, hi) {
      var ok = 0, seen = 0;
      for (var r = 0; r < Math.min(rows.length, 400); r++) {
        var v = parseFloat(rows[r][i]);
        if (!isNaN(v)) { seen++; if (v >= lo && v <= hi) ok++; }
      }
      return seen > 0 && ok / seen > 0.8;
    }
    function parseableDate(i) {
      var ok = 0;
      for (var r = 0; r < Math.min(rows.length, 200); r++) {
        if (!isNaN(Date.parse(String(rows[r][i]).replace(' ', 'T')))) ok++;
      }
      return ok > Math.min(rows.length, 200) * 0.6;
    }
    return {
      lat: pick(LAT_HINTS, function (i) { return numericIn(i, -90, 90); }),
      lng: pick(LNG_HINTS, function (i) { return numericIn(i, -180, 180); }),
      time: pick(TIME_HINTS, parseableDate),
      type: pick(TYPE_HINTS, null)
    };
  }

  function extractCalls(parsed, cols) {
    var calls = [], rows = parsed.rows;
    for (var i = 0; i < rows.length; i++) {
      var lat = parseFloat(rows[i][cols.lat]), lng = parseFloat(rows[i][cols.lng]);
      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      var t = cols.time >= 0 ? Date.parse(String(rows[i][cols.time]).replace(' ', 'T')) : NaN;
      if (isNaN(t)) continue;
      calls.push({ lat: lat, lng: lng, t: t,
                   type: cols.type >= 0 ? rows[i][cols.type] : '' });
    }
    calls.sort(function (a, b) { return a.t - b.t; });
    return calls;
  }

  /** Drop geographic outliers (bad geocodes) via a median-absolute-deviation fence. */
  function trimOutliers(calls) {
    if (calls.length < 50) return calls;
    var lats = calls.map(function (c) { return c.lat; }).sort(function (a, b) { return a - b; });
    var lngs = calls.map(function (c) { return c.lng; }).sort(function (a, b) { return a - b; });
    var mLat = quantile(lats, 0.5), mLng = quantile(lngs, 0.5);
    var spanLat = quantile(lats, 0.99) - quantile(lats, 0.01);
    var spanLng = quantile(lngs, 0.99) - quantile(lngs, 0.01);
    var padLat = Math.max(spanLat, 0.05) * 1.5, padLng = Math.max(spanLng, 0.05) * 1.5;
    return calls.filter(function (c) {
      return Math.abs(c.lat - mLat) <= padLat && Math.abs(c.lng - mLng) <= padLng;
    });
  }

  /* --------------------------------------------------------------- kmeans */

  function kmeans(calls, k, seed) {
    var rand = mulberry32(seed), n = calls.length;
    var centers = [], first = Math.floor(rand() * n);
    centers.push([calls[first].lat, calls[first].lng]);
    var dist = new Float64Array(n).fill(Infinity);

    while (centers.length < k) {                       // k-means++ seeding
      var c = centers[centers.length - 1], total = 0;
      for (var i = 0; i < n; i++) {
        var d = haversineMiles(calls[i].lat, calls[i].lng, c[0], c[1]);
        d = d * d;
        if (d < dist[i]) dist[i] = d;
        total += dist[i];
      }
      var target = rand() * total, acc = 0, chosen = n - 1;
      for (var j = 0; j < n; j++) { acc += dist[j]; if (acc >= target) { chosen = j; break; } }
      centers.push([calls[chosen].lat, calls[chosen].lng]);
    }

    var assign = new Int32Array(n);
    for (var iter = 0; iter < 25; iter++) {
      var moved = 0;
      for (var p = 0; p < n; p++) {
        var best = 0, bestD = Infinity;
        for (var q = 0; q < k; q++) {
          var dd = haversineMiles(calls[p].lat, calls[p].lng, centers[q][0], centers[q][1]);
          if (dd < bestD) { bestD = dd; best = q; }
        }
        if (assign[p] !== best) { assign[p] = best; moved++; }
      }
      var sumLat = new Float64Array(k), sumLng = new Float64Array(k), cnt = new Float64Array(k);
      for (var m = 0; m < n; m++) {
        sumLat[assign[m]] += calls[m].lat; sumLng[assign[m]] += calls[m].lng; cnt[assign[m]]++;
      }
      for (var z = 0; z < k; z++) {
        if (cnt[z] > 0) centers[z] = [sumLat[z] / cnt[z], sumLng[z] / cnt[z]];
      }
      if (moved === 0) break;
    }
    return { centers: centers, assign: assign };
  }

  /* --------------------------------------------------------------- mexclp */

  function mexclpComplianceTable(weights, q, zzDur, standardSec, nRanks) {
    var k = weights.length, chosen = [], coverCount = new Float64Array(k);
    var remaining = [];
    for (var i = 0; i < k; i++) remaining.push(i);

    while (chosen.length < Math.min(nRanks, k)) {
      var bestSite = remaining[0], bestGain = -Infinity;
      for (var r = 0; r < remaining.length; r++) {
        var s = remaining[r], gain = 0;
        for (var d = 0; d < k; d++) {
          if (zzDur[d][s] <= standardSec) {
            gain += weights[d] * Math.pow(q, coverCount[d]) * (1 - q);
          }
        }
        if (gain > bestGain) { bestGain = gain; bestSite = s; }
      }
      chosen.push(bestSite);
      for (var dd = 0; dd < k; dd++) if (zzDur[dd][bestSite] <= standardSec) coverCount[dd]++;
      remaining.splice(remaining.indexOf(bestSite), 1);
    }
    return chosen;
  }

  /* ----------------------------------------------------------- simulation */

  function simulate(calls, centers, zzDur, zcDur, table, strategy, homeZoneIds, seed, logDayStart, logDayEnd) {
    var rand = mulberry32(seed), n = calls.length, nAmb = homeZoneIds.length;
    var amb = [];
    for (var i = 0; i < nAmb; i++) {
      amb.push({ id: i, zone: homeZoneIds[i], home: homeZoneIds[i],
                 lat: centers[homeZoneIds[i]][0], lng: centers[homeZoneIds[i]][1], free: -Infinity });
    }
    var resp = new Float64Array(n), wait = new Float64Array(n), events = [];

    function nearestZone(lat, lng) {
      var best = 0, bd = Infinity;
      for (var z = 0; z < centers.length; z++) {
        var d = haversineMiles(lat, lng, centers[z][0], centers[z][1]);
        if (d < bd) { bd = d; best = z; }
      }
      return best;
    }

    for (var c = 0; c < n; c++) {
      var call = calls[c], t = call.t, idle = [];
      for (var a = 0; a < nAmb; a++) if (amb[a].free <= t) idle.push(amb[a]);

      if (strategy === 'static') {
        for (var s = 0; s < idle.length; s++) {
          idle[s].zone = idle[s].home;
          idle[s].lat = centers[idle[s].zone][0]; idle[s].lng = centers[idle[s].zone][1];
        }
      } else if (idle.length) {
        var targets = table.slice(0, idle.length), pool = idle.slice();
        for (var g = 0; g < targets.length; g++) {
          var bestIdx = 0, bestDur = Infinity;
          for (var p = 0; p < pool.length; p++) {
            var src = pool[p].zone !== null ? pool[p].zone : nearestZone(pool[p].lat, pool[p].lng);
            var du = zzDur[src][targets[g]];
            if (du < bestDur) { bestDur = du; bestIdx = p; }
          }
          var unit = pool.splice(bestIdx, 1)[0];
          unit.zone = targets[g];
          unit.lat = centers[targets[g]][0]; unit.lng = centers[targets[g]][1];
        }
      }

      var chosen, startTime, waitMin, travelMin;
      if (idle.length) {
        var bi = 0, bd2 = Infinity;
        for (var q2 = 0; q2 < idle.length; q2++) {
          var zid = idle[q2].zone !== null ? idle[q2].zone : nearestZone(idle[q2].lat, idle[q2].lng);
          var dur = zcDur[zid][c];
          if (dur < bd2) { bd2 = dur; bi = q2; }
        }
        chosen = idle[bi]; startTime = t; waitMin = 0; travelMin = bd2 / 60;
      } else {
        chosen = amb[0];
        for (var f = 1; f < nAmb; f++) if (amb[f].free < chosen.free) chosen = amb[f];
        startTime = chosen.free;
        waitMin = (startTime - t) / 60000;
        var srcZ = chosen.zone !== null ? chosen.zone : nearestZone(chosen.lat, chosen.lng);
        travelMin = zcDur[srcZ][c] / 60;
      }

      resp[c] = waitMin + travelMin;
      wait[c] = waitMin;

      if (logDayStart !== undefined && t >= logDayStart && t < logDayEnd) {
        events.push({ t: new Date(t).toISOString(), call_lat: call.lat, call_lng: call.lng,
                      ambulance_id: chosen.id, from_lat: chosen.lat, from_lng: chosen.lng,
                      to_lat: call.lat, to_lng: call.lng,
                      wait_min: +waitMin.toFixed(2), travel_min: +travelMin.toFixed(2),
                      response_min: +(waitMin + travelMin).toFixed(2),
                      n_idle_at_arrival: idle.length });
      }

      var serviceMin = Math.max(5, Math.exp(Math.log(SERVICE_MEAN_MIN) + 0.35 * gaussian(rand)));
      chosen.free = startTime + (travelMin + serviceMin) * 60000;
      chosen.lat = call.lat; chosen.lng = call.lng; chosen.zone = null;
    }
    return { resp: resp, wait: wait, events: events };
  }

  /** Wilcoxon signed-rank, normal approximation with tie correction (large n). */
  function wilcoxonP(a, b) {
    var diffs = [];
    for (var i = 0; i < a.length; i++) {
      var d = a[i] - b[i];
      if (d !== 0) diffs.push({ abs: Math.abs(d), sign: d > 0 ? 1 : -1 });
    }
    var n = diffs.length;
    if (n < 10) return NaN;
    diffs.sort(function (x, y) { return x.abs - y.abs; });
    var ranks = new Float64Array(n), i2 = 0, tieCorrection = 0;
    while (i2 < n) {
      var j = i2;
      while (j + 1 < n && diffs[j + 1].abs === diffs[i2].abs) j++;
      var avgRank = (i2 + j) / 2 + 1, tiedCount = j - i2 + 1;
      for (var r = i2; r <= j; r++) ranks[r] = avgRank;
      tieCorrection += tiedCount * tiedCount * tiedCount - tiedCount;
      i2 = j + 1;
    }
    var wPlus = 0;
    for (var k = 0; k < n; k++) if (diffs[k].sign > 0) wPlus += ranks[k];
    var mean = n * (n + 1) / 4;
    var sd = Math.sqrt((n * (n + 1) * (2 * n + 1) - tieCorrection / 2) / 24);
    var z = (wPlus - mean) / sd;
    // two-sided tail of the standard normal (Abramowitz & Stegun 7.1.26)
    var x = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + 0.3275911 * x);
    var erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return { p: Math.max(1e-300, 1 - erf), z: z, n: n };
  }

  /* ------------------------------------------------------------ pipeline  */

  function stats(resp) {
    var arr = Array.prototype.slice.call(resp).sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return { mean: sum / arr.length, median: quantile(arr, 0.5), p90: quantile(arr, 0.9) };
  }

  function histogram(resp, maxMin) {
    var counts = new Array(maxMin).fill(0);
    for (var i = 0; i < resp.length; i++) {
      var b = Math.min(maxMin - 1, Math.max(0, Math.floor(resp[i])));
      counts[b]++;
    }
    return counts;
  }

  function cumulativeSeries(sResp, dResp, points) {
    var n = sResp.length, out = { call_index: [], static_avg_min: [], dynamic_avg_min: [], cumulative_minutes_saved: [] };
    var cs = 0, cd = 0, saved = 0, step = Math.max(1, Math.floor(n / points));
    for (var i = 0; i < n; i++) {
      cs += sResp[i]; cd += dResp[i]; saved += sResp[i] - dResp[i];
      if (i % step === 0 || i === n - 1) {
        out.call_index.push(i + 1);
        out.static_avg_min.push(+(cs / (i + 1)).toFixed(3));
        out.dynamic_avg_min.push(+(cd / (i + 1)).toFixed(3));
        out.cumulative_minutes_saved.push(+saved.toFixed(1));
      }
    }
    return out;
  }

  /**
   * Full pipeline over a raw CAD CSV. `onStep(key, detail)` fires as each stage
   * completes so the UI can show real intermediate numbers, not a fake spinner.
   */
  function run(csvText, opts, onStep) {
    opts = opts || {};
    var step = onStep || function () {};
    var k = opts.kZones || K_ZONES;

    var parsed = parseCSV(csvText, MAX_CALLS * 2);
    step('parse', { rows: parsed.rows.length, columns: parsed.headers.length });

    var cols = detectColumns(parsed.headers, parsed.rows);
    if (cols.lat < 0 || cols.lng < 0) throw new Error('No latitude/longitude columns found in this CSV.');
    if (cols.time < 0) throw new Error('No parseable timestamp column found in this CSV.');
    step('columns', { lat: parsed.headers[cols.lat], lng: parsed.headers[cols.lng],
                      time: parsed.headers[cols.time],
                      type: cols.type >= 0 ? parsed.headers[cols.type] : null });

    var calls = trimOutliers(extractCalls(parsed, cols));
    if (calls.length < 200) throw new Error('Only ' + calls.length + ' usable geocoded calls -- need at least 200.');
    if (calls.length > MAX_CALLS) calls = calls.slice(calls.length - MAX_CALLS);
    var spanDays = (calls[calls.length - 1].t - calls[0].t) / 86400000;
    step('clean', { calls: calls.length, span_days: +spanDays.toFixed(1),
                    start: new Date(calls[0].t).toISOString().slice(0, 10),
                    end: new Date(calls[calls.length - 1].t).toISOString().slice(0, 10) });

    var km = kmeans(calls, k, SEED);
    var counts = new Array(k).fill(0);
    for (var i = 0; i < calls.length; i++) counts[km.assign[i]]++;
    var weights = counts.map(function (c) { return c / calls.length; });
    step('zones', { k: k, busiest_share: +(Math.max.apply(null, weights) * 100).toFixed(1) });

    // Travel-time matrices from the measured-speed model.
    var zzDur = [];
    for (var z = 0; z < k; z++) {
      zzDur.push(new Float64Array(k));
      for (var z2 = 0; z2 < k; z2++) {
        zzDur[z][z2] = travelSec(km.centers[z][0], km.centers[z][1], km.centers[z2][0], km.centers[z2][1]);
      }
    }
    var zcDur = [];
    for (var zz = 0; zz < k; zz++) {
      var rowArr = new Float32Array(calls.length);
      for (var cc = 0; cc < calls.length; cc++) {
        rowArr[cc] = travelSec(km.centers[zz][0], km.centers[zz][1], calls[cc].lat, calls[cc].lng);
      }
      zcDur.push(rowArr);
    }
    step('routing', { legs: k * calls.length, mph: CALIBRATION.mph });

    // Fleet sizing from PEAK demand in Erlangs, the same way the Python city
    // configs were sized (peak hourly calls x service time, +40% headroom).
    var hourly = {};
    for (var h = 0; h < calls.length; h++) {
      var key = Math.floor(calls[h].t / 3600000);
      hourly[key] = (hourly[key] || 0) + 1;
    }
    var peak = Math.max.apply(null, Object.keys(hourly).map(function (kk) { return hourly[kk]; }));
    var nAmb = opts.nAmbulances || Math.max(4, Math.ceil(peak * (SERVICE_MEAN_MIN / 60) * 1.4));
    var simMinutes = Math.max(1, spanDays) * 24 * 60;
    var q = Math.min(0.95, (calls.length * SERVICE_MEAN_MIN) / (nAmb * simMinutes));
    step('fleet', { peak_hourly: peak, n_ambulances: nAmb, q: +q.toFixed(3) });

    var table = mexclpComplianceTable(weights, q, zzDur, RESPONSE_STANDARD_MIN * 60, k);
    var homeZoneIds = [];
    for (var m = 0; m < nAmb; m++) homeZoneIds.push(table[m % table.length]);
    step('mexclp', { table: table.slice(0, 8) });

    // Busiest calendar day -> the head-to-head race trace.
    var dayCounts = {};
    for (var d2 = 0; d2 < calls.length; d2++) {
      var day = Math.floor(calls[d2].t / 86400000);
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }
    var busiest = Object.keys(dayCounts).reduce(function (a, b) {
      return dayCounts[a] > dayCounts[b] ? a : b;
    });
    var dayStart = +busiest * 86400000, dayEnd = dayStart + 86400000;

    var st = simulate(calls, km.centers, zzDur, zcDur, table, 'static', homeZoneIds, SEED, dayStart, dayEnd);
    step('sim_static', { avg: +stats(st.resp).mean.toFixed(2) });
    var dy = simulate(calls, km.centers, zzDur, zcDur, table, 'dynamic', homeZoneIds, SEED, dayStart, dayEnd);
    step('sim_dynamic', { avg: +stats(dy.resp).mean.toFixed(2) });

    var ss = stats(st.resp), ds = stats(dy.resp);
    var w = wilcoxonP(st.resp, dy.resp);
    var improved = 0, savedTotal = 0, delayedS = 0, delayedD = 0, withinS = 0, withinD = 0;
    for (var x = 0; x < st.resp.length; x++) {
      if (dy.resp[x] < st.resp[x]) improved++;
      savedTotal += st.resp[x] - dy.resp[x];
      if (st.wait[x] > 0) delayedS++;
      if (dy.wait[x] > 0) delayedD++;
      if (st.resp[x] <= RESPONSE_STANDARD_MIN) withinS++;
      if (dy.resp[x] <= RESPONSE_STANDARD_MIN) withinD++;
    }
    var n = st.resp.length;
    step('stats', { p: w.p, pct: +((ss.mean - ds.mean) / ss.mean * 100).toFixed(1) });

    var name = opts.name || 'Your city';
    var bundle = {
      id: 'upload',
      name: name,
      short: name,
      blurb: opts.fileName || 'Uploaded CAD export',
      source_url: null,
      uploaded: true,
      center: [km.centers.reduce(function (s2, c3) { return s2 + c3[0]; }, 0) / k,
               km.centers.reduce(function (s2, c3) { return s2 + c3[1]; }, 0) / k],
      summary: {
        city: name,
        sim_days: Math.round(spanDays),
        n_calls: n,
        n_ambulances: nAmb,
        k_zones: k,
        busy_fraction_q: +q.toFixed(3),
        response_standard_min: RESPONSE_STANDARD_MIN,
        service_time_assumption_min: SERVICE_MEAN_MIN,
        window_start: new Date(calls[0].t).toISOString().slice(0, 16).replace('T', ' '),
        window_end: new Date(calls[n - 1].t).toISOString().slice(0, 16).replace('T', ' '),
        avg_response_min_static: +ss.mean.toFixed(2),
        avg_response_min_dynamic: +ds.mean.toFixed(2),
        median_response_min_static: +ss.median.toFixed(2),
        median_response_min_dynamic: +ds.median.toFixed(2),
        p90_response_min_static: +ss.p90.toFixed(2),
        p90_response_min_dynamic: +ds.p90.toFixed(2),
        minutes_saved_avg: +(ss.mean - ds.mean).toFixed(2),
        minutes_saved_total: +savedTotal.toFixed(1),
        pct_improvement: +((ss.mean - ds.mean) / ss.mean * 100).toFixed(1),
        pct_calls_improved: +(improved / n * 100).toFixed(1),
        pct_calls_delayed_static: +(delayedS / n * 100).toFixed(1),
        pct_calls_delayed_dynamic: +(delayedD / n * 100).toFixed(1),
        pct_within_standard_static: +(withinS / n * 100).toFixed(1),
        pct_within_standard_dynamic: +(withinD / n * 100).toFixed(1),
        wilcoxon_p_value: w.p,
        statistically_significant: w.p < 0.05,
        routing_source: 'Browser estimate: ' + CALIBRATION.note
      },
      compliance_table: table,
      zones: km.centers.map(function (c4, idx) {
        return { lat: c4[0], lng: c4[1], weight: weights[idx], calls: counts[idx] };
      }),
      home_bases: homeZoneIds.map(function (z3, idx) {
        return { lat: km.centers[z3][0], lng: km.centers[z3][1], zone_id: z3, rank: idx + 1 };
      }),
      hist: { bin_width_min: 1, max_min: 40, static: histogram(st.resp, 40), dynamic: histogram(dy.resp, 40) },
      cumulative: cumulativeSeries(st.resp, dy.resp, 240),
      calibration: CALIBRATION,
      race: {
        date: new Date(dayStart).toISOString().slice(0, 10),
        n_calls: Math.min(st.events.length, dy.events.length),
        n_ambulances: nAmb,
        static_events: st.events,
        dynamic_events: dy.events
      }
    };
    step('done', bundle.summary);
    return bundle;
  }

  global.CADEngine = {
    run: run,
    parseCSV: parseCSV,
    detectColumns: detectColumns,
    CALIBRATION: CALIBRATION,
    MAX_CALLS: MAX_CALLS
  };
})(window);
