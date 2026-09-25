'use strict';

/* global TIMELINE_X */

// Audio waveform strip on the same time axis as the speed chart. The waveform is
// painted on a canvas (thousands of columns); clip band, playhead and hover live in
// an SVG layer on top so playback updates don't repaint the waveform.
// Amplitude is normalised to the file's loudest peak so quiet dashcam mics stay visible;
// the hover readout shows the true level in dBFS.

// eslint-disable-next-line no-unused-vars
function createWaveform(container, { onSeek }) {
  const NS = 'http://www.w3.org/2000/svg';
  const M = { top: 13, bottom: 4, ...TIMELINE_X };

  let data = null;       // { rate, peaks: Float32Array }
  let status = '';       // message shown when there is no data
  let domain = [0, 1];
  let clip = null;
  let playhead = null;
  let W = 0, H = 0, norm = 1;

  const canvas = document.createElement('canvas');
  canvas.className = 'wf-canvas';
  container.appendChild(canvas);
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const svg = el('svg', { class: 'wf-svg', role: 'img', 'aria-label': 'Audio waveform' }, container);
  const gClip = el('g', {}, svg);
  const label = el('text', { class: 'sc-unit', x: M.left + 4, y: 2 }, svg);
  label.textContent = 'audio';
  const msg = el('text', { class: 'sc-empty' }, svg);
  const playLine = el('line', { class: 'sc-playhead' }, svg);
  const hoverLine = el('line', { class: 'sc-crosshair hidden' }, svg);
  const tooltip = document.createElement('div');
  tooltip.className = 'sc-tooltip hidden';
  const ttValue = document.createElement('strong');
  const ttTime = document.createElement('span');
  tooltip.append(ttValue, ttTime);
  container.appendChild(tooltip);

  const plotW = () => W - M.left - M.right;
  const xs = (t) => M.left + ((t - domain[0]) / (domain[1] - domain[0] || 1)) * plotW();
  const xInv = (px) => domain[0] + ((px - M.left) / plotW()) * (domain[1] - domain[0]);
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  /** Loudest peak between two times. */
  function peakBetween(t0, t1) {
    if (!data) return 0;
    const n = data.peaks.length;
    const i0 = Math.max(0, Math.floor(t0 * data.rate));
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(t1 * data.rate)));
    let m = 0;
    for (let i = i0; i < i1; i++) if (data.peaks[i] > m) m = data.peaks[i];
    return m;
  }

  function paint() {
    W = container.clientWidth;
    H = container.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    for (const a of ['width', 'height']) svg.setAttribute(a, a === 'width' ? W : H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const mid = (M.top + H - M.bottom) / 2;
    const half = (H - M.top - M.bottom) / 2;

    // Centre line
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(M.left, Math.round(mid), plotW(), 1);

    msg.textContent = data ? '' : status;
    msg.setAttribute('x', M.left + plotW() / 2);
    msg.setAttribute('y', H / 2);
    if (data) {
      ctx.fillStyle = getComputedStyle(container).getPropertyValue('--wave').trim() || '#9aa4b1';
      const secPerPx = (domain[1] - domain[0]) / plotW();
      for (let px = 0; px < plotW(); px++) {
        const t0 = domain[0] + px * secPerPx;
        const p = peakBetween(t0, t0 + secPerPx) / norm;
        if (!p) continue;
        const h = Math.max(1, p * half);
        ctx.fillRect(M.left + px, mid - h, 1, h * 2);
      }
    }
    drawClip();
    drawPlayhead();
  }

  function drawClip() {
    gClip.replaceChildren();
    if (!clip || !W) return;
    const [a, b] = clip.map(xs);
    el('rect', { x: a, y: 0, width: Math.max(0, b - a), height: H, class: 'sc-clip' }, gClip);
    for (const x of [a, b]) el('line', { x1: x, x2: x, y1: 0, y2: H, class: 'sc-clip-edge' }, gClip);
  }

  function drawPlayhead() {
    playLine.classList.toggle('hidden', playhead == null || !W);
    if (playhead == null || !W) return;
    const x = xs(Math.max(domain[0], Math.min(domain[1], playhead)));
    for (const [k, v] of [['x1', x], ['x2', x], ['y1', 0], ['y2', H]]) playLine.setAttribute(k, v);
  }

  svg.addEventListener('pointermove', (e) => {
    if (!data) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    const t = xInv(x);
    if (t < domain[0] || t > domain[1]) return;
    // Level over ±50 ms around the pointer.
    const p = peakBetween(t - 0.05, t + 0.05);
    for (const [k, v] of [['x1', x], ['x2', x], ['y1', 0], ['y2', H]]) hoverLine.setAttribute(k, v);
    hoverLine.classList.remove('hidden');
    ttValue.textContent = p > 0 ? `${(20 * Math.log10(p)).toFixed(0)} dBFS` : 'silence';
    ttTime.textContent = fmtTime(Math.max(0, t));
    tooltip.classList.remove('hidden');
    const tw = tooltip.offsetWidth;
    tooltip.style.left = `${Math.min(W - tw - 2, Math.max(2, x + (x + tw + 12 > W ? -tw - 10 : 10)))}px`;
    tooltip.style.top = `${Math.max(0, H / 2 - 12)}px`;
  });
  svg.addEventListener('pointerleave', () => {
    hoverLine.classList.add('hidden');
    tooltip.classList.add('hidden');
  });
  svg.addEventListener('click', (e) => {
    const t = xInv(e.clientX - svg.getBoundingClientRect().left);
    if (t >= domain[0] && t <= domain[1]) onSeek?.(t);
  });

  new ResizeObserver(paint).observe(container);

  return {
    /**
     * peaks: { rate, peaks } | null. Returns false when there's nothing worth showing: no audio,
     * or a digitally silent track (cameras with the mic switched off still record one).
     */
    setData(peaks, message = '') {
      data = peaks && peaks.peaks.length ? peaks : null;
      status = message;
      if (data) {
        let max = 0;
        for (const v of data.peaks) if (v > max) max = v;
        norm = Math.max(max, 0.05); // don't blow near-silence up to full scale
        if (max < 1e-4) data = null;
      }
      paint();
      return data != null;
    },
    setDomain(range) { domain = range && range[1] > range[0] ? range : [0, 1]; paint(); },
    setClip(range) { clip = range; drawClip(); },
    setPlayhead(t) { playhead = t; drawPlayhead(); },
  };
}
