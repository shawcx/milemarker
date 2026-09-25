'use strict';

// Speed-over-time line chart (SVG). The x-axis is video time, so it doubles as the
// clip timeline: it shows the clip selection and playhead, and clicking seeks.
// Speeds come in as km/h; `setUnits` converts for display only.

// Horizontal plot margins shared by every timeline strip so their x-axes line up.
const TIMELINE_X = { left: 34, right: 10 };

// eslint-disable-next-line no-unused-vars
function createSpeedChart(container, { onSeek, onEvent }) {
  const NS = 'http://www.w3.org/2000/svg';
  const M = { top: 14, bottom: 18, ...TIMELINE_X };

  let series = [];            // [{ x: video seconds, y: km/h | null }]
  let domain = [0, 1];        // x range in seconds
  let units = { label: 'km/h', factor: 1 };
  let clip = null;            // [a, b] or null
  let playhead = null;        // seconds or null
  let events = [];            // [{ x: video seconds, label, key }] incident markers
  let W = 0, H = 0, yMax = 1;

  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };

  const svg = el('svg', { class: 'sc-svg', role: 'img' }, container);
  const gGrid = el('g', {}, svg);
  const gClip = el('g', {}, svg);
  const gData = el('g', {}, svg);
  const gEvents = el('g', {}, svg);
  const gPlay = el('g', {}, svg);
  const gHover = el('g', { class: 'sc-hover hidden' }, svg);
  const tooltip = document.createElement('div');
  tooltip.className = 'sc-tooltip hidden';
  container.appendChild(tooltip);

  const xs = (t) => M.left + ((t - domain[0]) / (domain[1] - domain[0] || 1)) * (W - M.left - M.right);
  const ys = (kmh) => H - M.bottom - ((kmh * units.factor) / yMax) * (H - M.top - M.bottom);
  const xInv = (px) => domain[0] + ((px - M.left) / (W - M.left - M.right)) * (domain[1] - domain[0]);

  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
  }
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  /** Linear interpolation of speed at video time t (null if outside / no data). */
  function speedAt(t) {
    if (!series.length || t < series[0].x || t > series[series.length - 1].x) return null;
    let lo = 0, hi = series.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (series[mid].x <= t) lo = mid; else hi = mid;
    }
    const a = series[lo], b = series[hi];
    if (a.y == null || b.y == null) return null; // dropout
    const f = (t - a.x) / (b.x - a.x || 1);
    return a.y + (b.y - a.y) * f;
  }

  function draw() {
    W = container.clientWidth;
    H = container.clientHeight;
    if (!W || !H) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    for (const g of [gGrid, gData]) g.replaceChildren();

    const hasData = series.some((p) => p.y != null);
    const top = Math.max(...series.map((p) => (p.y ?? 0) * units.factor), 0);
    const yStep = niceStep(Math.max(top, 10) / 3);
    yMax = Math.ceil(Math.max(top, 10) / yStep) * yStep;
    svg.setAttribute('aria-label', hasData
      ? `Speed over time, peak ${Math.round(top)} ${units.label}` : 'No speed data');

    // Horizontal gridlines + y labels
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      const y = ys(v / units.factor);
      el('line', { x1: M.left, x2: W - M.right, y1: y, y2: y, class: v === 0 ? 'sc-base' : 'sc-grid' }, gGrid);
      el('text', { x: M.left - 6, y, class: 'sc-ylabel' }, gGrid).textContent = v;
    }
    el('text', { x: M.left + 4, y: 2, class: 'sc-unit' }, gGrid).textContent = units.label;

    // X labels at a nice time step (~5 labels)
    const span = domain[1] - domain[0];
    const xStep = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => span / s <= 6) || 3600;
    for (let t = Math.ceil(domain[0] / xStep) * xStep; t <= domain[1] + 1e-9; t += xStep) {
      el('text', { x: xs(t), y: H - 4, class: 'sc-xlabel' }, gGrid).textContent = fmtTime(t);
    }

    if (!hasData) {
      el('text', { x: (M.left + W - M.right) / 2, y: (H - M.bottom + M.top) / 2, class: 'sc-empty' }, gData)
        .textContent = series.length ? 'No speed data' : 'Speed graph appears here';
    } else {
      // Break the line where speed is missing.
      const runs = [];
      let run = [];
      for (const p of series) {
        if (p.y == null) { if (run.length) runs.push(run); run = []; } else run.push(p);
      }
      if (run.length) runs.push(run);
      for (const r of runs) {
        const line = r.map((p, i) => `${i ? 'L' : 'M'}${xs(p.x).toFixed(1)} ${ys(p.y).toFixed(1)}`).join('');
        const base = ys(0).toFixed(1);
        el('path', { d: `${line}L${xs(r[r.length - 1].x).toFixed(1)} ${base}L${xs(r[0].x).toFixed(1)} ${base}Z`, class: 'sc-area' }, gData);
        el('path', { d: line, class: 'sc-line' }, gData);
      }
    }
    drawClip();
    drawEvents();
    drawPlayhead();
  }

  // Amber downward triangles along the top edge, with a faint guide line.
  function drawEvents() {
    gEvents.replaceChildren();
    if (!W) return;
    for (const ev of events) {
      if (ev.x < domain[0] || ev.x > domain[1]) continue;
      const x = xs(ev.x);
      const g = el('g', { class: 'sc-event', role: 'button', 'aria-label': ev.label }, gEvents);
      el('title', {}, g).textContent = ev.label;
      el('line', { x1: x, x2: x, y1: M.top, y2: H - M.bottom }, g);
      el('path', { d: `M${x - 6} ${M.top - 9}L${x + 6} ${M.top - 9}L${x} ${M.top + 1}Z` }, g);
      // Generous invisible hit area.
      el('rect', { x: x - 9, y: 0, width: 18, height: M.top + 6, fill: 'transparent' }, g);
      g.addEventListener('click', (e) => { e.stopPropagation(); onEvent?.(ev.key); });
    }
  }

  function drawClip() {
    gClip.replaceChildren();
    if (!clip || !W) return;
    const [a, b] = clip.map(xs);
    el('rect', { x: a, y: M.top, width: Math.max(0, b - a), height: H - M.top - M.bottom, class: 'sc-clip' }, gClip);
    for (const x of [a, b]) el('line', { x1: x, x2: x, y1: M.top, y2: H - M.bottom, class: 'sc-clip-edge' }, gClip);
  }

  const playLine = el('line', { class: 'sc-playhead' }, gPlay);
  const playDot = el('circle', { r: 4, class: 'sc-dot' }, gPlay);
  function drawPlayhead() {
    if (playhead == null || !W) { gPlay.classList.add('hidden'); return; }
    gPlay.classList.remove('hidden');
    const x = xs(Math.max(domain[0], Math.min(domain[1], playhead)));
    playLine.setAttribute('x1', x); playLine.setAttribute('x2', x);
    playLine.setAttribute('y1', M.top); playLine.setAttribute('y2', H - M.bottom);
    const s = speedAt(playhead);
    playDot.classList.toggle('hidden', s == null);
    if (s != null) { playDot.setAttribute('cx', x); playDot.setAttribute('cy', ys(s)); }
  }

  // Hover: crosshair snaps to the nearest sample; tooltip shows value then time.
  const hoverLine = el('line', { class: 'sc-crosshair' }, gHover);
  const hoverDot = el('circle', { r: 4, class: 'sc-dot' }, gHover);
  const ttValue = document.createElement('strong');
  const ttTime = document.createElement('span');
  tooltip.append(ttValue, ttTime);

  function nearest(t) {
    let best = null;
    for (const p of series) if (p.y != null && (!best || Math.abs(p.x - t) < Math.abs(best.x - t))) best = p;
    return best;
  }

  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const p = nearest(xInv(e.clientX - r.left));
    if (!p) return;
    const x = xs(p.x), y = ys(p.y);
    gHover.classList.remove('hidden');
    tooltip.classList.remove('hidden');
    hoverLine.setAttribute('x1', x); hoverLine.setAttribute('x2', x);
    hoverLine.setAttribute('y1', M.top); hoverLine.setAttribute('y2', H - M.bottom);
    hoverDot.setAttribute('cx', x); hoverDot.setAttribute('cy', y);
    ttValue.textContent = `${Math.round(p.y * units.factor)} ${units.label}`;
    ttTime.textContent = fmtTime(Math.max(0, p.x));
    const tw = tooltip.offsetWidth;
    tooltip.style.left = `${Math.min(W - tw - 2, Math.max(2, x + (x + tw + 12 > W ? -tw - 10 : 10)))}px`;
    tooltip.style.top = `${Math.max(2, y - 34)}px`;
  });
  svg.addEventListener('pointerleave', () => {
    gHover.classList.add('hidden');
    tooltip.classList.add('hidden');
  });
  svg.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    const t = xInv(e.clientX - r.left);
    if (t >= domain[0] && t <= domain[1]) onSeek?.(t);
  });

  new ResizeObserver(draw).observe(container);

  return {
    speedAt,
    setData(points, range) {
      series = points;
      domain = range && range[1] > range[0] ? range : [0, 1];
      draw();
    },
    setUnits(u) { units = u; draw(); },
    setClip(range) { clip = range; drawClip(); },
    setEvents(list) { events = list; drawEvents(); },
    setPlayhead(t) { playhead = t; drawPlayhead(); },
  };
}
