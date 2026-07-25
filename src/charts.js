/* charts.js -- small dependency-free SVG charts. Every series is drawn straight
   from the city bundle's real arrays; nothing here smooths or invents points. */
(function (global) {
  'use strict';

  /* Series colours come from the stylesheet tokens so the charts follow the
     active theme. Read per-draw, not once at load -- a theme switch redraws. */
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function palette() {
    return {
      S: token('--static'),
      D: token('--dynamic'),
      Sfill: token('--static-soft'),
      Dfill: token('--dynamic-soft'),
      muted: token('--muted'),
      dim: token('--dim')
    };
  }

  function el(tag, attrs, children) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  /* Draw in the container's own pixel space rather than scaling a fixed
     viewBox: a stretched viewBox smears text and strokes in a wide card, and a
     uniformly-scaled one leaves the plot floating in dead space. Measuring the
     container means one plot geometry that fills any width with 1:1 text. */
  function widthOf(container) {
    var w = container.clientWidth || container.getBoundingClientRect().width;
    return Math.max(240, Math.round(w) || 300);
  }

  function svgRoot(w, h) {
    var s = el('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'chart',
                        preserveAspectRatio: 'xMidYMid meet' });
    s.style.height = h + 'px';
    return s;
  }

  function path(points, color, width, fill) {
    var d = points.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ');
    return el('path', { d: d + (fill ? ' Z' : ''), fill: fill || 'none', stroke: color, 'stroke-width': width || 2,
                        'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  }

  /** Overlaid response-time distributions: where the whole curve shifts left. */
  function histogram(container, hist, standardMin) {
    container.innerHTML = '';
    var c = palette();
    var w = widthOf(container), h = 108, pad = 16;
    var bins = hist.static.length;
    var totalS = hist.static.reduce(function (a, b) { return a + b; }, 0);
    var totalD = hist.dynamic.reduce(function (a, b) { return a + b; }, 0);
    var sPct = hist.static.map(function (c) { return c / totalS; });
    var dPct = hist.dynamic.map(function (c) { return c / totalD; });
    var max = Math.max.apply(null, sPct.concat(dPct)) || 1;
    var svg = svgRoot(w, h);
    var x = function (i) { return pad + (i / (bins - 1)) * (w - pad * 2); };
    var y = function (v) { return h - 14 - (v / max) * (h - 26); };

    [[sPct, c.S, c.Sfill], [dPct, c.D, c.Dfill]].forEach(function (series) {
      var pts = series[0].map(function (v, i) { return [x(i), y(v)]; });
      var area = [[x(0), h - 14]].concat(pts, [[x(bins - 1), h - 14]]);
      svg.appendChild(path(area, 'none', 0, series[2]));
      svg.appendChild(path(pts, series[1], 1.8));
    });

    if (standardMin) {
      svg.appendChild(el('line', { x1: x(standardMin), x2: x(standardMin), y1: 6, y2: h - 14,
                                   stroke: c.muted, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.65 }));
      var lbl = el('text', { x: x(standardMin) + 4, y: 13, fill: c.muted, 'font-size': 8.5 });
      lbl.textContent = standardMin + '-min standard';
      svg.appendChild(lbl);
    }
    [0, 10, 20, 30, 40].forEach(function (m) {
      if (m > bins) return;
      var t = el('text', { x: x(Math.min(m, bins - 1)), y: h - 3, fill: c.dim, 'font-size': 8.5,
                           'text-anchor': m === 0 ? 'start' : (m >= 40 ? 'end' : 'middle') });
      t.textContent = m + (m === 40 ? '+ min' : '');
      svg.appendChild(t);
    });
    container.appendChild(svg);
  }

  /** Cumulative average response over the full call stream -- the gap is the result. */
  function cumulative(container, cum) {
    container.innerHTML = '';
    var c = palette();
    var w = widthOf(container), h = 108, pad = 16, n = cum.call_index.length;
    var all = cum.static_avg_min.concat(cum.dynamic_avg_min);
    var lo = Math.min.apply(null, all) * 0.9, hi = Math.max.apply(null, all) * 1.04;
    var svg = svgRoot(w, h);
    var x = function (i) { return pad + (i / (n - 1)) * (w - pad * 2); };
    var y = function (v) { return h - 16 - ((v - lo) / (hi - lo)) * (h - 28); };

    var band = cum.static_avg_min.map(function (v, i) { return [x(i), y(v)]; })
      .concat(cum.dynamic_avg_min.map(function (v, i) { return [x(n - 1 - i), y(cum.dynamic_avg_min[n - 1 - i])]; }));
    svg.appendChild(path(band, 'none', 0, c.Dfill));
    svg.appendChild(path(cum.static_avg_min.map(function (v, i) { return [x(i), y(v)]; }), c.S, 2));
    svg.appendChild(path(cum.dynamic_avg_min.map(function (v, i) { return [x(i), y(v)]; }), c.D, 2));

    [[cum.static_avg_min[n - 1], c.S], [cum.dynamic_avg_min[n - 1], c.D]].forEach(function (p) {
      svg.appendChild(el('circle', { cx: x(n - 1), cy: y(p[0]), r: 3, fill: p[1] }));
      var t = el('text', { x: x(n - 1) - 5, y: y(p[0]) - 6, fill: p[1], 'font-size': 9.5, 'font-weight': 700, 'text-anchor': 'end' });
      t.textContent = p[0].toFixed(2) + ' min';
      svg.appendChild(t);
    });
    var lab = el('text', { x: pad, y: h - 3, fill: c.dim, 'font-size': 8.5 });
    lab.textContent = 'call 1';
    svg.appendChild(lab);
    var lab2 = el('text', { x: w - pad, y: h - 3, fill: c.dim, 'font-size': 8.5, 'text-anchor': 'end' });
    lab2.textContent = 'call ' + cum.call_index[n - 1].toLocaleString();
    svg.appendChild(lab2);
    container.appendChild(svg);
  }

  /** Cumulative ambulance-minutes returned to the city across the window. */
  function savedArea(container, cum) {
    container.innerHTML = '';
    var c = palette();
    var w = widthOf(container), h = 86, pad = 14, n = cum.call_index.length;
    var vals = cum.cumulative_minutes_saved;
    var hi = Math.max.apply(null, vals) || 1;
    var svg = svgRoot(w, h);
    var x = function (i) { return pad + (i / (n - 1)) * (w - pad * 2); };
    var y = function (v) { return h - 16 - (v / hi) * (h - 26); };
    var pts = vals.map(function (v, i) { return [x(i), y(v)]; });
    svg.appendChild(path([[x(0), h - 16]].concat(pts, [[x(n - 1), h - 16]]), 'none', 0, c.Dfill));
    svg.appendChild(path(pts, c.D, 2));
    var t = el('text', { x: w - pad, y: 12, fill: c.D, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'end' });
    t.textContent = Math.round(hi).toLocaleString() + ' min';
    svg.appendChild(t);
    var t2 = el('text', { x: pad, y: h - 3, fill: c.dim, 'font-size': 8.5 });
    t2.textContent = 'ambulance-minutes saved, cumulative';
    svg.appendChild(t2);
    container.appendChild(svg);
  }

  global.Charts = { histogram: histogram, cumulative: cumulative, savedArea: savedArea };
})(window);
