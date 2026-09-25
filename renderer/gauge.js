'use strict';

// Analog speedometer drawn as SVG. 270° sweep, 0 at lower-left, max at lower-right.
// Units-agnostic: callers pass speeds already converted to the display unit.

// eslint-disable-next-line no-unused-vars
function createGauge(svg) {
  const NS = 'http://www.w3.org/2000/svg';
  const C = 100, R = 88, START = -135, SWEEP = 270;
  let max = 120;

  const el = (tag, attrs, parent = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  // Angle in degrees clockwise from 12 o'clock -> point at radius r.
  const polar = (deg, r) => {
    const a = (deg - 90) * Math.PI / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  };
  const arc = (from, to, r) => {
    const [x1, y1] = polar(from, r), [x2, y2] = polar(to, r);
    return `M${x1} ${y1} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const angleFor = (v) => START + SWEEP * Math.max(0, Math.min(1, v / max));

  svg.setAttribute('viewBox', '0 0 200 200');
  el('circle', { cx: C, cy: C, r: 97, class: 'g-face' });
  const scale = el('g', {});
  const needle = el('g', {});
  el('path', { d: 'M97.5 108 L99 24 L101 24 L102.5 108 Z', class: 'g-needle' }, needle);
  el('circle', { cx: C, cy: C, r: 7, class: 'g-hub' });
  const readout = el('text', { x: C, y: 150, class: 'g-readout' });
  const unitText = el('text', { x: C, y: 166, class: 'g-unit' });
  unitText.textContent = 'km/h';

  function drawScale() {
    scale.replaceChildren();
    // Pick a major step that gives 6–10 labelled ticks.
    const major = [10, 20, 30, 40, 50].find((s) => max / s <= 10) || 50;
    const minor = major / 5;
    el('path', { d: arc(START, START + SWEEP, R), class: 'g-rim' }, scale);
    // Red zone for the top 15% of the scale.
    el('path', { d: arc(angleFor(max * 0.85), START + SWEEP, R - 4), class: 'g-redline' }, scale);

    for (let v = 0; v <= max + 1e-9; v += minor) {
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-9;
      const a = angleFor(v);
      const [x1, y1] = polar(a, R);
      const [x2, y2] = polar(a, R - (isMajor ? 12 : 6));
      el('line', { x1, y1, x2, y2, class: isMajor ? 'g-tick-major' : 'g-tick' }, scale);
      if (isMajor) {
        const [tx, ty] = polar(a, R - 24);
        el('text', { x: tx, y: ty, class: 'g-label' }, scale).textContent = Math.round(v);
      }
    }
  }

  function setSpeed(v) {
    const has = v != null && Number.isFinite(v);
    needle.setAttribute('transform', `rotate(${angleFor(has ? v : 0)} ${C} ${C})`);
    readout.textContent = has ? Math.round(v) : '–';
  }

  /** Scale the dial to comfortably fit the track's top speed. */
  function setMax(topSpeed) {
    const steps = [40, 60, 80, 100, 120, 140, 160, 200, 240, 300];
    max = steps.find((s) => s >= topSpeed * 1.1) || Math.ceil(topSpeed / 50) * 50;
    drawScale();
  }

  drawScale();
  setSpeed(null);
  return { setSpeed, setMax, setUnit: (label) => { unitText.textContent = label; }, show: (on) => svg.classList.toggle('hidden', !on) };
}
