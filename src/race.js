/* race.js -- the head-to-head dock.
 *
 * What the race actually measures (it is not decoration): both strategies must
 * clear the SAME real day of 911 calls, in the same order. Each lane spends its
 * own response minutes, call by call, off one shared clock. A lane's position is
 * the share of that day's calls it has cleared by the current clock time, so the
 * strategy that spends fewer minutes per call is literally further down the
 * track. Numbers come from the bundle's paired event traces -- cumulative
 * response minutes, nothing else.
 */
(function (global) {
  'use strict';

  var state = {
    bundle: null, cumS: null, cumD: null, n: 0, total: 0,
    clock: 0, raf: null, playing: false, speed: 1, wins: { d: 0, s: 0, t: 0 }
  };

  function $(id) { return document.getElementById(id); }

  function fmt(n, d) { return n.toLocaleString(undefined, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }

  function load(bundle) {
    stop();
    state.bundle = bundle;
    var se = bundle.race.static_events, de = bundle.race.dynamic_events;
    var n = Math.min(se.length, de.length);
    state.n = n;
    state.cumS = new Float64Array(n);
    state.cumD = new Float64Array(n);
    // Progressive win/loss/tie tallies (cumulative up to and including call i),
    // so render() can show "of the calls both lanes have reached SO FAR" instead
    // of the full day's final tally from frame one.
    state.cumWinD = new Int32Array(n);
    state.cumWinS = new Int32Array(n);
    state.cumWinT = new Int32Array(n);
    var accS = 0, accD = 0, wins = { d: 0, s: 0, t: 0 };
    for (var i = 0; i < n; i++) {
      accS += se[i].response_min; accD += de[i].response_min;
      state.cumS[i] = accS; state.cumD[i] = accD;
      var diff = se[i].response_min - de[i].response_min;
      if (Math.abs(diff) < 0.005) wins.t++; else if (diff > 0) wins.d++; else wins.s++;
      state.cumWinD[i] = wins.d; state.cumWinS[i] = wins.s; state.cumWinT[i] = wins.t;
    }
    state.wins = wins;
    state.total = Math.max(accS, accD);
    // This specific real day's own improvement -- NOT the city's 60-day summary
    // stat, which is a different (larger, real-question) number. Conflating the
    // two would put a false claim in a presenter's mouth mid-demo.
    state.dayPct = accS ? (accS - accD) / accS * 100 : 0;

    $('raceVerdict').innerHTML =
      'Same <b style="color:var(--foreground)">' + fmt(n) + '</b> real calls from ' + bundle.race.date +
      ' &middot; dynamic wins by <b>' + state.dayPct.toFixed(1) + '%</b> <span style="color:var(--muted);font-weight:400;">(this day; 60-day city average is ' + bundle.summary.pct_improvement + '%)</span>';
    $('raceDay').textContent = bundle.race.date;
    $('raceCity').textContent = bundle.short;
    $('laneStatS').innerHTML = '<b>0</b> / ' + fmt(n) + ' cleared';
    $('laneStatD').innerHTML = '<b>0</b> / ' + fmt(n) + ' cleared';
    renderTicks();
    reset();
    render();
  }

  function renderTicks() {
    ['raceTrackS', 'raceTrackD'].forEach(function (id) {
      var track = $(id);
      track.querySelectorAll('.tick').forEach(function (t) { t.remove(); });
      for (var p = 25; p < 100; p += 25) {
        var tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.left = p + '%';
        track.appendChild(tick);
      }
    });
  }

  function clearedAt(cum, clock) {
    var lo = 0, hi = state.n;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= clock) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function render() {
    var n = state.n;
    if (!n) return;
    var cs = clearedAt(state.cumS, state.clock);
    var cd = clearedAt(state.cumD, state.clock);
    var pS = cs / n, pD = cd / n;

    $('raceFillS').style.width = (pS * 100) + '%';
    $('raceFillD').style.width = (pD * 100) + '%';
    $('runnerS').style.left = 'calc(' + (pS * 100) + '% - ' + (pS * 26 - 13) + 'px)';
    $('runnerD').style.left = 'calc(' + (pD * 100) + '% - ' + (pD * 26 - 13) + 'px)';
    $('runnerD').classList.toggle('lead', cd > cs);
    $('laneStatS').innerHTML = '<b>' + fmt(cs) + '</b> / ' + fmt(n) + ' cleared';
    $('laneStatD').innerHTML = '<b>' + fmt(cd) + '</b> / ' + fmt(n) + ' cleared';

    var paired = Math.min(cs, cd);
    var saved = paired ? state.cumS[paired - 1] - state.cumD[paired - 1] : 0;
    $('raceSaved').textContent = fmt(saved, 1);
    $('raceAhead').textContent = cd > cs
      ? 'Dynamic is ' + fmt(cd - cs) + ' calls ahead'
      : (cs > cd ? 'Static is ' + fmt(cs - cd) + ' calls ahead' : 'Neck and neck');

    // Progressive tally: only among calls BOTH lanes have actually cleared so
    // far, not the full day's final result shown prematurely.
    var wd = paired ? state.cumWinD[paired - 1] : 0;
    var wst = paired ? state.cumWinS[paired - 1] : 0;
    var wt = paired ? state.cumWinT[paired - 1] : 0;
    var tot = wd + wst + wt || 1;
    $('winD').style.width = (wd / tot * 100) + '%';
    $('winS').style.width = (wst / tot * 100) + '%';
    $('winT').style.width = (wt / tot * 100) + '%';
    $('winLabel').innerHTML = '<b style="color:var(--dynamic)">' + fmt(wd) + '</b> calls reached sooner &middot; ' +
      '<b style="color:var(--static)">' + fmt(wst) + '</b> slower &middot; ' + fmt(wt) + ' tied' +
      (paired < n ? ' <span style="color:var(--muted);">(of ' + fmt(paired) + ' so far)</span>' : '');
  }

  // Timer-driven rather than requestAnimationFrame: rAF is suspended whenever
  // the tab is backgrounded, which would freeze the race mid-pitch if the
  // presenter switches windows. Timers keep ticking.
  function tick() {
    if (!state.playing) return;
    var now = performance.now();
    if (!state.last) state.last = now;
    var dt = Math.min(250, now - state.last);
    state.last = now;
    // A full race takes ~22 s of wall clock at 1x, whatever the city's scale.
    state.clock += (state.total / 22000) * dt * state.speed;
    if (state.clock >= state.total) { state.clock = state.total; render(); finish(); return; }
    render();
  }

  function finish() {
    state.playing = false;
    state.last = 0;
    clearInterval(state.raf);
    $('raceBtn').innerHTML = Icons.svg('replay', 13) + 'Replay';
    $('raceAhead').textContent = 'Dynamic cleared the day ' +
      fmt(state.cumS[state.n - 1] - state.cumD[state.n - 1], 1) + ' min sooner';
    $('raceVerdict').innerHTML = 'Dynamic cleared the same <b style="color:var(--foreground)">' + fmt(state.n) +
      '</b> calls with <b>' + state.dayPct.toFixed(1) + '%</b> less time-to-patient ' +
      '<span style="color:var(--muted);font-weight:400;">(this day; 60-day city average is ' +
      state.bundle.summary.pct_improvement + '%)</span>';
  }

  function reset() {
    state.clock = 0; state.last = 0;
    $('raceBtn').innerHTML = Icons.svg('play', 13) + 'Race';
  }

  function play() {
    if (state.playing) { stop(); return; }
    if (state.clock >= state.total) reset();
    state.playing = true;
    state.last = 0;
    $('raceBtn').innerHTML = Icons.svg('pause', 13) + 'Pause';
    clearInterval(state.raf);
    state.raf = setInterval(tick, 16);
  }

  function stop() {
    state.playing = false;
    state.last = 0;
    clearInterval(state.raf);
    if ($('raceBtn')) {
      $('raceBtn').innerHTML = state.clock >= state.total
        ? Icons.svg('replay', 13) + 'Replay'
        : Icons.svg('play', 13) + 'Race';
    }
  }

  function init() {
    $('raceBtn').addEventListener('click', function (e) { e.stopPropagation(); play(); });
    $('raceSpeed').addEventListener('change', function (e) {
      e.stopPropagation();
      state.speed = +e.target.value;
    });
    $('raceSpeed').addEventListener('click', function (e) { e.stopPropagation(); });
    $('raceHead').addEventListener('click', function () {
      $('raceDock').classList.toggle('collapsed');
      setTimeout(function () { global.dispatchEvent(new Event('resize')); }, 320);
    });
  }

  global.Race = { init: init, load: load, play: play, stop: stop };
})(window);
