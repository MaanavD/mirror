/*
  mirror frontend.

  Order of events on a cold, offline boot:
    1. clock paints (pure client-side, no network)
    2. last state from localStorage paints
    3. GET /api/state paints (server disk cache, possibly stale)
    4. SSE takes over; if it drops, 60s polling does
  There is no loading state and no spinner at any point.

  Motion lives in three places: the CSS tokens in styles.css, the calm/active/
  night machine in mode.js, and the small schedulers at the bottom of this file
  (frame draw-in, scanline sweep). Everything here checks prefers-reduced-motion.
*/
import { createModeMachine } from './mode.js';

(() => {
  'use strict';

  const STORAGE_KEY = 'mirror.state.v1';
  const POLL_MS = 60_000;
  const SSE_RETRY_MS = 30_000;
  const BURN_IN_MS = 10 * 60_000;
  // Module payload swaps crossfade fast; long dissolves read as a page load.
  const FADE_MS = 220;

  const REDUCED_MOTION = Boolean(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  // Imminent-event alert: a timed event drawing near gets lifted out of the
  // agenda as a HUD bracket for one beat. Each event fires once per session.
  const IMMINENT_MS = 10 * 60_000; // within 10 min → full detach alert
  const URGENT_MS = 60_000; // under 60 s → reserved shake instead
  const HOLD_MS = 8_000; // bracket holds for 8 s, then returns
  const ALERT_TOP = 1280; // below the reflected head, above the bottom band
  const ALERT_SCALE = 1.3;
  const firedAlerts = new Set(); // session-scoped guard
  let latestCalendar = null; // last calendar payload we rendered

  const root = document.getElementById('root');
  const dot = document.getElementById('dot');
  const clockEl = document.getElementById('clock');
  const dateEl = document.getElementById('date');
  const weekEl = document.getElementById('week');

  // A module may paint into several slots at once (weather splits into today's
  // readout and one tomorrow line, calendar into the two stacked day columns of
  // the right rail's frame), so every entry is a list.
  const q = (selector) => document.querySelector(selector);
  const bodies = {
    astro: [q('#astro-line')],
    countdown: [q('#countdown-line')],
    aqi: [q('#aqi-chip')],
    weather: [q('#wx-today'), q('#wx-tomorrow'), q('#wx-rain')],
    calendar: [q('#cal-today'), q('#cal-tomorrow')],
    quote: [q('#quote .body')],
    notion: [q('#notion .body')],
    nanoleaf: [q('#nanoleaf .body')],
    news: [q('#news .body')],
  };
  const nowPlayingEl = q('#now-playing');
  const leavebyEl = q('#leaveby');

  // -------------------------------------------------------------- clock

  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  }

  // One <span> per character, so a minute rollover only re-animates the cells
  // that actually changed (":" and unchanged digits sit still). A length change
  // — 9:59 to 10:00 — rebuilds the row, which reads as the whole clock ticking.
  function paintTicker(target, text) {
    const chars = [...text];
    if (target.childElementCount !== chars.length) {
      target.replaceChildren(...chars.map((ch) => el('span', 'ch', ch)));
      return;
    }
    for (let i = 0; i < chars.length; i += 1) {
      const cell = target.children[i];
      if (cell.textContent === chars[i]) continue;
      cell.textContent = chars[i];
      cell.classList.remove('tick');
      void cell.offsetWidth; // restart the animation from frame zero
      cell.classList.add('tick');
    }
  }

  function paintClock() {
    const now = new Date();
    paintTicker(clockEl, timeFmt.format(now));

    const date = dateFmt.format(now).toLowerCase();
    if (dateEl.textContent !== date) dateEl.textContent = date;

    const week = `week ${isoWeek(now)}`;
    if (weekEl.textContent !== week) weekEl.textContent = week;

    // Re-align to the next wall-clock second instead of drifting.
    setTimeout(paintClock, 1_000 - (now.getTime() % 1_000) + 5);
  }

  // ---------------------------------------------------------- rendering

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  // ------------------------------------------------------ weather icons
  //
  // Stroke-only line art built from the Open-Meteo / WMO weathercode the
  // server already ships per slot. currentColor, no fills — the same
  // brightness physics as the rest of the glass.
  //
  // Each icon is a list of parts instead of one path, because the parts move:
  // `wx-rays` turns, `wx-cloud` drifts, `wx-drop`/`wx-dash` fall, `wx-flake`
  // settles, `wx-bolt` flickers (keyframes and tempo live in styles.css). A part
  // may carry `origin` for its rotation centre and `delay`, expressed as a
  // fraction of the animation's own duration so a stagger survives a mode
  // change: a negative fraction starts that streak mid-cycle.

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const r1 = (n) => Math.round(n * 10) / 10;

  const circleD = (cx, cy, r) =>
    `M${r1(cx - r)} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

  const raysD = (cx, cy, r0, r2, angles) =>
    angles
      .map((deg) => {
        const a = (deg * Math.PI) / 180;
        return `M${r1(cx + r0 * Math.cos(a))} ${r1(cy + r0 * Math.sin(a))}L${r1(cx + r2 * Math.cos(a))} ${r1(cy + r2 * Math.sin(a))}`;
      })
      .join('');

  const cloudD = (dy = 0) => `M13 ${31 + dy}a6 6 0 0 1 3-11 9 9 0 0 1 17-1 6 6 0 0 1 2 12z`;

  const flakeD = (x, y) =>
    `M${x} ${r1(y - 3.4)}v6.8M${r1(x - 2.9)} ${r1(y - 1.7)}l5.8 3.4M${r1(x + 2.9)} ${r1(y - 1.7)}l-5.8 3.4`;

  const ICONS = {
    sun: () => [
      { d: circleD(24, 24, 8.5) },
      {
        d: raysD(24, 24, 12.5, 16.5, [0, 45, 90, 135, 180, 225, 270, 315]),
        cls: 'wx-rays',
      },
    ],
    'sun-cloud': () => [
      { d: circleD(19, 18, 7.5) },
      { d: raysD(19, 18, 11, 15, [0, 315, 270, 225, 180, 135]), cls: 'wx-rays', origin: '19px 18px' },
      { d: 'M25 36a4.5 4.5 0 0 1 2-8.4 6.5 6.5 0 0 1 12.4-.8 4.5 4.5 0 0 1 1.6 9.2z', cls: 'wx-cloud' },
    ],
    'cloud-sun': () => [
      { d: circleD(35, 12, 5) },
      { d: raysD(35, 12, 8, 11.5, [0, 315, 270]), cls: 'wx-rays', origin: '35px 12px' },
      { d: cloudD(2), cls: 'wx-cloud' },
    ],
    cloud: () => [{ d: cloudD(2), cls: 'wx-cloud' }],
    fog: () => [
      { d: cloudD(-4), cls: 'wx-cloud' },
      { d: 'M14 33h20', cls: 'wx-mist' },
      { d: 'M18 39h13', cls: 'wx-mist', delay: -0.5 },
    ],
    drizzle: () => [
      { d: cloudD(-5), cls: 'wx-cloud' },
      { d: 'M18 31l-1 3', cls: 'wx-dash' },
      { d: 'M26 31l-1 3', cls: 'wx-dash', delay: -0.33 },
      { d: 'M34 31l-1 3', cls: 'wx-dash', delay: -0.66 },
    ],
    rain: () => [
      { d: cloudD(-6), cls: 'wx-cloud' },
      { d: 'M19 29l-3 8', cls: 'wx-drop' },
      { d: 'M27 29l-3 8', cls: 'wx-drop', delay: -0.33 },
      { d: 'M35 29l-3 8', cls: 'wx-drop', delay: -0.66 },
    ],
    sleet: () => [
      { d: cloudD(-6), cls: 'wx-cloud' },
      { d: 'M19 29l-3 8', cls: 'wx-drop' },
      { d: 'M35 29l-3 8', cls: 'wx-drop', delay: -0.5 },
      { d: flakeD(26, 34), cls: 'wx-flake', delay: -0.25 },
    ],
    snow: () => [
      { d: cloudD(-6), cls: 'wx-cloud' },
      { d: flakeD(17, 33), cls: 'wx-flake' },
      { d: flakeD(25, 37), cls: 'wx-flake', delay: -0.33 },
      { d: flakeD(33, 33), cls: 'wx-flake', delay: -0.66 },
    ],
    storm: () => [
      { d: cloudD(-7), cls: 'wx-cloud' },
      { d: 'M27 26l-6 9h7l-6 10', cls: 'wx-bolt' },
    ],
    unknown: () => [{ d: 'M24 15l8 9-8 9-8-9z' }],
  };

  function iconKind(code) {
    if (code === 0) return 'sun';
    if (code === 1) return 'sun-cloud';
    if (code === 2) return 'cloud-sun';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 55) return 'drizzle';
    if (code === 56 || code === 57 || code === 66 || code === 67) return 'sleet';
    if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95 && code <= 99) return 'storm';
    return 'unknown';
  }

  // Which mode token drives each animated part's duration.
  const DELAY_TOKEN = {
    'wx-drop': '--wx-fall',
    'wx-dash': '--wx-fall',
    'wx-flake': '--wx-flake',
    'wx-mist': '--wx-drift',
  };

  function weatherIcon(code, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    for (const part of ICONS[iconKind(code)]()) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', part.d);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      if (part.cls) path.setAttribute('class', part.cls);
      if (part.origin) path.style.transformOrigin = part.origin;
      // Duration is a mode token, so a stagger has to be expressed as a
      // fraction of that same token or it would drift when the mode changes.
      if (part.delay) {
        const token = DELAY_TOKEN[part.cls] ?? '--wx-fall';
        path.style.animationDelay = `calc(var(${token}) * ${part.delay})`;
      }
      svg.append(path);
    }
    return svg;
  }

  // Small square line-work glyph (astro readout). Thinner stroke than the
  // weather icons: it sits next to text, not on its own.
  function lineGlyph(d, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  // HP-gauge temperature range (BN HP bar): lo → hi, segments lit up to the
  // current temperature. Tomorrow's line gets numbers only, no gauge.
  const HP_SEGMENTS = 8;

  function hpGauge(lo, hi, current) {
    const wrap = el('div', 'hp');
    wrap.append(el('span', 'rv', `${lo}°`));
    const bar = el('span', 'hp-bar');
    const span = Math.max(1, hi - lo);
    const pos = Math.min(1, Math.max(0, (current - lo) / span));
    const lit = Math.max(1, Math.round(pos * HP_SEGMENTS));
    for (let i = 0; i < HP_SEGMENTS; i += 1) bar.append(el('i', i < lit ? 'lit' : null));
    wrap.append(bar);
    wrap.append(el('span', 'rv', `${hi}°`));
    return wrap;
  }

  // Hourly slots stay in the payload but are no longer rendered: the readout
  // is today (current + range gauge) over one tomorrow line (icon + hi/lo).
  // Tomorrow's condition text is dropped too — its icon already says it, and
  // a second line of prose is not worth the lit pixels.
  function renderWeather(targets, data) {
    const [today, tomorrow, rainEl] = targets;
    if (!data || !data.current) return;

    const now = el('div', 'wx-now');
    now.append(weatherIcon(data.current.code, 'wxicon'));
    now.append(el('span', 'temp', `${data.current.temp}°`));
    today.append(now);
    if (data.current.text) today.append(el('div', 'cond-text', data.current.text));

    const hi = data.today?.hi;
    const lo = data.today?.lo;
    if (hi !== null && hi !== undefined && lo !== null && lo !== undefined) {
      today.append(hpGauge(lo, hi, data.current.temp));
    }

    // Older cached payloads predate the tomorrow field; render nothing then.
    const next = data.tomorrow;
    const missing = (v) => v === null || v === undefined;
    if (!next || (missing(next.hi) && missing(next.code))) return;
    const row = el('div', 'wx-now sm');
    row.append(el('span', 'lbl', 'tmr'));
    row.append(weatherIcon(next.code, 'wxicon'));
    const hilo = el('span', 'hilo');
    hilo.append(el('b', null, missing(next.hi) ? '—' : `${next.hi}°`));
    hilo.append(el('span', 'lo', missing(next.lo) ? '' : ` / ${next.lo}°`));
    row.append(hilo);
    tomorrow.append(row);

    // Dim "rain incoming" chip: only painted when the server flagged rain in
    // the next two hours — dry days earn no pixels.
    if (rainEl && data.rain && data.rain.rainAtISO) {
      const when = new Date(data.rain.rainAtISO);
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      rainEl.append(el('div', 'wx-rain-chip', `// RAIN ${hh}:${mm}`));
    }
  }

  // Sun up / sun down / UV, under the clock. The astro payload still carries the
  // moon (the /api/state contract is unchanged) — the mirror just does not paint
  // it any more: at the glass, phase names were noise and the sun times were the
  // only part anyone read. So they get glyphs and real type instead.
  const ASTRO_GLYPHS = {
    sunrise:
      'M3 20.5h18M8.5 20.5a3.5 3.5 0 0 1 7 0M5.6 15.7l1.6 1.6M18.4 15.7l-1.6 1.6' +
      'M12 3.5v7.5M9.2 6.3 12 3.5l2.8 2.8',
    sunset:
      'M3 20.5h18M8.5 20.5a3.5 3.5 0 0 1 7 0M5.6 15.7l1.6 1.6M18.4 15.7l-1.6 1.6' +
      'M12 3.5v7.5M9.2 8.2 12 11l2.8-2.8',
    uv:
      circleD(12, 8.5, 3.2) +
      raysD(12, 8.5, 5, 7, [270, 225, 315, 180, 0]) +
      'M8 14.5v4M6.9 17.4 8 18.5l1.1-1.1M16 14.5v4M14.9 17.4 16 18.5l1.1-1.1',
  };

  // "06:14" -> "6:14", "20:22" -> "8:22". The arrow glyph carries the am/pm.
  function shortTime(label) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(label ?? ''));
    if (!m) return null;
    const hour = Number(m[1]) % 12;
    return `${hour === 0 ? 12 : hour}:${m[2]}`;
  }

  function astroItem(kind, value) {
    const item = el('span', `astro-item ${kind}`);
    item.append(lineGlyph(ASTRO_GLYPHS[kind], 'astro-glyph'));
    item.append(el('span', 'astro-val', value));
    return item;
  }

  function renderAstro([target], data) {
    if (!data) return;

    const strip = el('div', 'astro-strip');
    const up = shortTime(data.sunrise);
    const down = shortTime(data.sunset);
    if (up) strip.append(astroItem('sunrise', up));
    if (down) strip.append(astroItem('sunset', down));

    // Below 3 the index is not actionable, and unlit pixels are the point.
    const uv = Number(data.uv);
    if (Number.isFinite(uv) && uv >= 3) strip.append(astroItem('uv', `UV ${Math.round(uv)}`));

    if (!strip.childElementCount) return;
    target.append(strip);
  }

  // Days-until line: "▸ SAN FRANCISCO 8D   ▸ SF MOVE 53D". "TODAY" beats "0D"
  // on the one morning it matters.
  function renderCountdown([target], data) {
    if (!data?.items?.length) return;
    const strip = el('div', 'countdown-strip');
    for (const item of data.items.slice(0, 2)) {
      const cell = el('span', `countdown-item ${item.kind}`);
      cell.append(el('span', 'countdown-label', item.label));
      cell.append(el('span', 'countdown-days', item.days === 0 ? 'TODAY' : `${item.days}D`));
      strip.append(cell);
    }
    target.append(strip);
  }

  // "9:00am" -> "9a", "9:30am" -> "9:30a": buys the title ~4 characters on the
  // narrow rail. Display-only; the server keeps the full label for leave-by.
  const compactTime = (label) =>
    String(label ?? '').replace(/:00(am|pm)$/, '$1').replace(/([ap])m$/, '$1');

  // Every 1:1 on this calendar is titled "Maanav <> X": on Maanav's own mirror
  // the prefix carries nothing, so it goes and X gets the pixels. Display-only.
  const compactTitle = (title) => String(title ?? '').replace(/^maanav\s*<>\s*/i, '');

  function agendaList(events, { cursor = false } = {}) {
    const list = el('ul', 'agenda');
    // BN selection cursor sits on the next upcoming timed event, if any.
    const selected = cursor ? events.find((e) => !e.allDay && !e.past) : undefined;
    for (const event of events) {
      const li = el(
        'li',
        [event.allDay ? 'allday' : '', event.past ? 'past' : '', event === selected ? 'sel' : '']
          .filter(Boolean)
          .join(' '),
      );
      li.dataset.eventId = event.id;
      li.dataset.eventStart = event.start;
      li.append(el('span', 't', compactTime(event.timeLabel)));
      li.append(el('span', 'n', compactTitle(event.title)));
      list.append(li);
    }
    return list;
  }

  // The agenda frame has to fit on the right rail, so the glass shows fewer
  // rows than the payload carries and folds the rest into the "+n more" line.
  const EVENTS_SHOWN = 3;

  // Three rows are too few to spend on meetings that already ended, so the
  // window slides forward until what is still to come fits — keeping earlier
  // rows only while there is room above.
  function windowStart(events) {
    const next = events.findIndex((e) => !e.past);
    const last = events.length - EVENTS_SHOWN;
    return Math.max(0, next < 0 ? last : Math.min(next, last));
  }

  function renderDay(target, events, more, options) {
    if (!events?.length) return;
    const start = windowStart(events);
    const shown = events.slice(start, start + EVENTS_SHOWN);
    target.append(agendaList(shown, options));
    const hidden = (more ?? 0) + events.length - shown.length;
    if (hidden > 0) target.append(el('div', 'more', `+${hidden} more`));
  }

  function renderCalendar([today, tomorrow], data) {
    if (!data || data.configured === false) return;
    renderDay(today, data.today, data.todayMore, { cursor: true });
    renderDay(tomorrow, data.tomorrow, data.tomorrowMore);
  }

  // ------------------------------------------------- imminent-event alert

  // A fixed clone of an agenda row travels to the alert rail — the dead air
  // below the reflected head, which stops at about y=950 — where it is framed
  // by four cyan HUD corner brackets, micro-pulses twice, then flies home.
  function findRow(id) {
    const rows = document.querySelectorAll('#cal-today li[data-event-id]');
    for (const row of rows) if (row.dataset.eventId === id) return row;
    return null;
  }

  function buildAlertClone(event) {
    const clone = el('div', 'hud-alert');
    clone.dataset.eventId = event.id;
    for (const corner of ['tl', 'tr', 'bl', 'br']) clone.append(el('span', `hud-corner ${corner}`));
    const rowEl = el('div', 'hud-row');
    rowEl.append(el('span', 't', event.timeLabel));
    rowEl.append(el('span', 'n', event.title));
    clone.append(rowEl);
    return clone;
  }

  function placeFixed(clone, x, y, scale, width) {
    clone.style.left = '0px';
    clone.style.top = '0px';
    clone.style.width = `${width}px`;
    clone.style.transformOrigin = 'center center';
    clone.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  function fireDetach(event) {
    const row = findRow(event.id);
    const clone = buildAlertClone(event);
    if (row) row.classList.add('detaching');
    clone._row = row;
    document.body.append(clone);

    const rect = row ? row.getBoundingClientRect()
      : { left: 540 - 200, top: ALERT_TOP, width: 400, height: 40 };
    const w = rect.width || 400;
    const h = rect.height || 40;

    // Start exactly where the row sits, then transition to centre-top.
    placeFixed(clone, rect.left, rect.top, 1, w);
    void clone.offsetWidth; // commit the start frame before transitioning

    const cx = 540;
    const cy = ALERT_TOP + (ALERT_SCALE * h) / 2;
    const timers = [];

    const arrive = setTimeout(() => {
      clone.classList.add('show'); // draw the HUD brackets
      clone.style.transition = 'transform 0.6s cubic-bezier(.2,.8,.2,1)';
      clone.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px) scale(${ALERT_SCALE})`;
    }, 16);

    const pulse = setTimeout(() => clone.classList.add('pulse'), 16 + 600);
    const back = setTimeout(() => returnClone(clone, event), 16 + 600 + 900 + HOLD_MS);
    timers.push(arrive, pulse, back);
    clone._timers = timers;
  }

  function returnClone(clone, event) {
    const row = clone._row || findRow(event.id);
    clone.classList.remove('pulse');
    if (row) row.classList.remove('detaching');
    if (!row) {
      // Event left the visible window: just dissolve the clone.
      clone.style.transition = 'opacity 0.4s ease';
      clone.style.opacity = '0';
      setTimeout(() => clone.remove(), 420);
      return;
    }
    const r = row.getBoundingClientRect();
    clone.style.transition = 'transform 0.5s cubic-bezier(.2,.8,.2,1)';
    clone.style.transform = `translate(${r.left}px, ${r.top}px) scale(1)`;
    setTimeout(() => clone.remove(), 540);
  }

  // Reserved urgency: a sub-60-second event gets a tight ±2px shake on its row
  // instead of the full detach — no cloning, no lingering motion.
  function fireShake(event) {
    const row = findRow(event.id);
    if (!row) return;
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
    row.addEventListener('animationend', () => row.classList.remove('shake'), { once: true });
  }

  function checkImminent() {
    if (!latestCalendar || document.hidden || document.body.classList.contains('off')) return;
    const now = Date.now();
    for (const event of latestCalendar.today ?? []) {
      if (event.allDay || event.past) continue;
      const startMs = Date.parse(event.start);
      if (Number.isNaN(startMs)) continue;
      const msUntil = startMs - now;
      if (msUntil <= 0 || msUntil > IMMINENT_MS) continue;
      if (firedAlerts.has(event.id)) continue;
      firedAlerts.add(event.id);
      if (msUntil < URGENT_MS) fireShake(event);
      else fireDetach(event);
    }
  }

  // Sparse on purpose: the server caps at 8 visible, the glass shows fewer. Down
  // from 4 with the larger chip type — at 26px titles a fourth tile would push
  // the frame (and Hermy, who sits on its top edge) up past the bottom band's
  // own clip line at y=1472. The overflow is not lost, it joins "+n more".
  const TODOS_SHOWN = 3;

  // Chip-code letter for an area, e.g. "Health / sleep" -> "H".
  const codeLetter = (area) => (String(area ?? '').match(/[a-z0-9]/i)?.[0] ?? '·').toUpperCase();

  // Chip-card rows: one framed tile per task, area initial as the chip code.
  function renderTodos([target], data) {
    if (!data || !data.groups?.length) return;
    const list = el('ul', 'chips');
    let shown = 0;
    let hidden = 0;
    for (const group of data.groups) {
      for (const item of group.items) {
        if (shown >= TODOS_SHOWN) {
          hidden += 1;
          continue;
        }
        const li = el('li', 'chip');
        li.append(el('span', 'code', codeLetter(group.area)));
        li.append(el('span', 't', item.title));
        list.append(li);
        shown += 1;
      }
    }
    if (shown === 0) return;
    target.append(list);
    const more = (data.more ?? 0) + hidden;
    if (more > 0) target.append(el('div', 'more', `+${more} more`));
  }

  // Each Nanoleaf light reads as ONE hex glyph (BN chip icon). Outline stays
  // visible when off; an on light only adds a restrained color wash so the
  // OLED mirror keeps its black budget.
  const NANOFORMS = [
    { kind: 'hex', points: '26,6 44,16 44,36 26,46 8,36 8,16' },
  ];

  function nanoleafIcon(light) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 52 52');
    svg.setAttribute('class', 'nanoleaf-icon');
    svg.setAttribute('aria-hidden', 'true');

    const rgb = Array.isArray(light.rgb) && light.rgb.length >= 3
      ? light.rgb.slice(0, 3).map(Number).filter(Number.isFinite)
      : [];
    if (light.on && rgb.length === 3) svg.style.color = `rgb(${rgb.map((value) => Math.min(255, Math.max(0, Math.round(value)))).join(' ')})`;

    const level = Number.isFinite(Number(light.brightness)) ? Math.min(255, Math.max(0, Number(light.brightness))) / 255 : 0.5;
    const fillOpacity = light.on ? (0.08 + level * 0.16).toFixed(3) : '0';
    for (const form of NANOFORMS) {
      const polygon = document.createElementNS(SVG_NS, 'polygon');
      polygon.setAttribute('points', form.points);
      polygon.setAttribute('class', `nanoleaf-panel ${form.kind}`);
      polygon.setAttribute('fill', 'currentColor');
      polygon.setAttribute('fill-opacity', fillOpacity);
      svg.append(polygon);
    }
    return svg;
  }

  function renderNanoleaf([target], data) {
    if (!data?.lights?.length) return;
    const list = el('div', 'nanoleaf-lights');
    for (const light of data.lights) {
      const row = el('div', `nanoleaf-light${light.on ? ' on' : ' off'}`);
      const label = String(light.name ?? light.entityId ?? 'shapes');
      const state = light.on ? 'on' : 'off';
      const level = light.on && Number.isFinite(Number(light.brightness))
        ? ` ${Math.round((Number(light.brightness) / 255) * 100)}%`
        : '';
      row.append(nanoleafIcon(light));
      const meta = el('div', 'nanoleaf-meta');
      meta.append(el('div', 'nanoleaf-name', label));
      meta.append(el('div', 'nanoleaf-state', `${state}${level}`));
      row.append(meta);
      row.setAttribute('aria-label', `${label} ${state}`);
      list.append(row);
    }
    target.append(list);
  }

  function renderQuote([target], data) {
    if (!data || !data.text) return;
    target.append(el('blockquote', null, data.text));
    if (data.author) target.append(el('div', 'by', data.author));
  }

  function renderLeaveby(target, data) {
    if (!data) return;
    if (data.label) {
      target.append(el('span', null, data.label));
      return;
    }
    if (!data.eventTitle || !data.leaveBy) return;
    target.append(el('span', null, `\u25B6 LEAVE BY ${data.leaveBy} \u00B7 ${data.driveMin} MIN DRIVE`));
  }

  function renderAqi([target], data) {
    if (!data || data.aqi === null || data.aqi === undefined) return;
    if (data.aqi < 60) return;
    const chip = el('div', `aqi-chip ${data.level}`);
    chip.append(el('span', 'aqi-label', `AQI ${data.aqi}`));
    chip.append(el('span', 'aqi-level', data.level.replace('-', ' ')));
    target.append(chip);
  }

  // Net feed: one HN headline at a time, cross-fading every 20s (no scrolling
  // marquee). The rotation is module-level so a re-render only resets it when
  // the payload actually changes (the `update` guard handles that upstream).
  const NEWS_SWAP_MS = 20_000;
  const NEWS_FADE_MS = 500;
  let newsTimer = null;
  let newsItems = [];
  let newsPos = 0;
  let newsTitleEl = null;
  let newsScoreEl = null;

  function paintNewsHead() {
    const item = newsItems[newsPos];
    if (!item) return;
    newsTitleEl.textContent = String(item.title ?? '').toUpperCase();
    newsScoreEl.textContent = `${item.score}`;
  }

  function renderNews([target], data) {
    clearInterval(newsTimer);
    newsTimer = null;
    newsItems = Array.isArray(data) ? data.slice() : [];
    if (!newsItems.length) {
      target.replaceChildren();
      return;
    }

    const feed = el('div', 'feed');
    const tab = el('span', 'tag');
    tab.append(el('span', null, '>> NET NEWS'));
    const head = el('div', 'head');
    const title = el('span', 't');
    const score = el('span', 'pts');
    head.append(title, score);
    feed.append(tab, head);
    target.append(feed);

    newsTitleEl = title;
    newsScoreEl = score;
    newsPos = 0;
    paintNewsHead();

    newsTimer = setInterval(() => {
      head.classList.add('swap');
      setTimeout(() => {
        newsPos = (newsPos + 1) % newsItems.length;
        paintNewsHead();
        head.classList.remove('swap');
      }, NEWS_FADE_MS);
    }, NEWS_SWAP_MS);
  }

  const renderers = {
    weather: renderWeather,
    astro: renderAstro,
    countdown: renderCountdown,
    aqi: renderAqi,
    calendar: renderCalendar,
    quote: renderQuote,
    notion: renderTodos,
    nanoleaf: renderNanoleaf,
    news: renderNews,
  };

  // ------------------------------------------------------ now playing

  let pauseFadeTimer = null;
  let pauseKey = null;
  let hiddenPausedKey = null;
  let playingKey = null;

  // Client-side progress reconciliation. The server only sends a snapshot of
  // progressMs every refresh; between updates we advance the arc locally so it
  // sweeps smoothly, then re-anchor on each fresh server payload.
  let vinylLocal = null; // { durationMs, serverProgressMs, serverTs, playing }
  let vinylRaf = 0;

  function trackKey(track) {
    return `${track?.name ?? ''}\\u0000${(track?.artists ?? []).join('\\u0000')}`;
  }

  // ------------------------------------------------- album accent tinting
  // While music plays, the whole UI's line work retints to the album art's
  // dominant color. Frame geometry is a baked SVG data URL, so we rebuild it
  // with the accent hex. Everything reverts when the overlay goes away.

  const rootStyle = document.documentElement.style;
  let accentKey = null;

  function frameSrc(hex) {
    const c = encodeURIComponent(hex);
    return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'%3E%3Cpath fill='none' stroke='${c}' stroke-width='3' d='M10.5 2.5H49.5V6.5H53.5V10.5H57.5V49.5H53.5V53.5H49.5V57.5H10.5V53.5H6.5V49.5H2.5V10.5H6.5V6.5H10.5Z'/%3E%3Crect x='8.5' y='8.5' width='43' height='43' fill='none' stroke='${c}' stroke-opacity='.45'/%3E%3C/svg%3E")`;
  }

  function applyAccent(rgb) {
    const [r, g, b] = rgb;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    rootStyle.setProperty('--navy', `rgba(${r}, ${g}, ${b}, 0.55)`);
    rootStyle.setProperty('--line', `rgba(${r}, ${g}, ${b}, 0.36)`);
    rootStyle.setProperty('--line-dim', `rgba(${r}, ${g}, ${b}, 0.18)`);
    rootStyle.setProperty('--frame-src', frameSrc(hex));
    rootStyle.setProperty('--vinyl-accent', `rgba(${r}, ${g}, ${b}, 0.6)`);
  }

  function clearAccent() {
    accentKey = null;
    for (const prop of ['--navy', '--line', '--line-dim', '--frame-src', '--vinyl-accent']) {
      rootStyle.removeProperty(prop);
    }
  }

  // Dominant color: downsample, score pixels by saturation, average the
  // strongest hue bucket, then lift toward OLED-safe brightness.
  function extractAccent(img) {
    try {
      const size = 24;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        const max = Math.max(r, g, b); const min = Math.min(r, g, b);
        if (max < 28) continue; // near-black: ignore
        const sat = max === 0 ? 0 : (max - min) / max;
        const weight = 0.2 + sat * (max / 255);
        const hue = Math.round(((Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI + 360) % 360 / 24);
        const bucket = buckets.get(hue) ?? { w: 0, r: 0, g: 0, b: 0 };
        bucket.w += weight; bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight;
        buckets.set(hue, bucket);
      }
      let best = null;
      for (const bucket of buckets.values()) if (!best || bucket.w > best.w) best = bucket;
      if (!best || best.w === 0) return null;
      let rgb = [best.r / best.w, best.g / best.w, best.b / best.w];
      // Lift dim accents so the line work stays legible on the mirror.
      const peak = Math.max(...rgb, 1);
      if (peak < 150) rgb = rgb.map((v) => v * (150 / peak));
      return rgb.map((v) => Math.min(255, Math.round(v)));
    } catch {
      return null; // canvas tainted or decode issue: keep BN palette
    }
  }

  function makeVinyl(data, key) {
    const overlay = el('section', 'vinyl-overlay');
    overlay.dataset.trackKey = key;
    overlay.append(el('div', 'vinyl-kicker', 'now playing'));

    const disc = el('div', 'vinyl-disc');
    const record = el('div', 'vinyl-record');
    const art = document.createElement('img');
    art.className = 'vinyl-art';
    art.alt = '';
    art.draggable = false;
    art.crossOrigin = 'anonymous';
    art.addEventListener('load', () => {
      if (accentKey === key) return;
      const rgb = extractAccent(art);
      if (rgb) {
        applyAccent(rgb);
        accentKey = key;
      }
    });
    if (data.track.albumArtUrl) art.src = data.track.albumArtUrl;
    record.append(art);

    // Thin progress arc sitting just outside the rim. The SVG does not spin
    // with the record, so the sweep stays anchored to the top.
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arc.setAttribute('class', 'vinyl-arc');
    arc.setAttribute('viewBox', '0 0 100 100');
    arc.setAttribute('aria-hidden', 'true');
    const arcCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arcCircle.setAttribute('class', 'vinyl-arc-ring');
    arcCircle.setAttribute('cx', '50');
    arcCircle.setAttribute('cy', '50');
    arcCircle.setAttribute('r', '49');
    arc.append(arcCircle);

    disc.append(record, arc);
    overlay.append(disc);

    const meta = el('div', 'vinyl-meta');
    meta.append(el('div', 'vinyl-title'));
    meta.append(el('div', 'vinyl-artists'));
    const progress = el('div', 'vinyl-progress');
    progress.append(el('span'));
    meta.append(progress);
    meta.append(el('div', 'vinyl-remaining'));
    overlay.append(meta);
    return overlay;
  }

  // Re-anchor local progress from a fresh server payload.
  function anchorProgress(data) {
    const durationMs = Number(data.durationMs) || 0;
    const serverProgressMs = Math.max(0, Number(data.progressMs) || 0);
    vinylLocal = {
      durationMs,
      serverProgressMs,
      serverTs: Date.now(),
      playing: Boolean(data.isPlaying),
    };
  }

  // Interpolated progress in ms, advancing only while playing.
  function liveProgressMs() {
    if (!vinylLocal) return 0;
    const { durationMs, serverProgressMs, serverTs, playing } = vinylLocal;
    let ms = serverProgressMs;
    if (playing) ms += Math.max(0, Date.now() - serverTs);
    if (durationMs > 0) ms = Math.min(ms, durationMs);
    return ms;
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `-${m}:${String(s).padStart(2, '0')}`;
  }

  function paintVinylProgress(overlay) {
    if (!overlay || !vinylLocal) return;
    const { durationMs } = vinylLocal;
    const ms = liveProgressMs();
    const ratio = durationMs > 0 ? Math.min(1, Math.max(0, ms / durationMs)) : 0;

    overlay.querySelector('.vinyl-progress span').style.width = `${Math.round(ratio * 1000) / 10}%`;

    const ring = overlay.querySelector('.vinyl-arc-ring');
    if (ring) {
      const r = 49;
      const circumference = 2 * Math.PI * r;
      ring.style.strokeDasharray = `${circumference}`;
      ring.style.strokeDashoffset = `${circumference * (1 - ratio)}`;
    }

    const rem = overlay.querySelector('.vinyl-remaining');
    if (rem) rem.textContent = durationMs > 0 ? formatRemaining(durationMs - ms) : '';
  }

  function tickVinyl() {
    const overlay = nowPlayingEl.firstElementChild;
    if (overlay && vinylLocal && vinylLocal.playing) paintVinylProgress(overlay);
    vinylRaf = requestAnimationFrame(tickVinyl);
  }

  function updateVinylDetails(overlay, data) {
    overlay.classList.toggle('is-playing', Boolean(data.isPlaying));
    overlay.classList.toggle('is-paused', !data.isPlaying);
    overlay.querySelector('.vinyl-title').textContent = data.track.name;
    overlay.querySelector('.vinyl-artists').textContent = (data.track.artists ?? []).join('  /  ') || 'unknown artist';
    anchorProgress(data);
    paintVinylProgress(overlay);
  }

  function renderNowPlaying(data) {
    const track = data?.track;
    if (!track?.name || data.configured === false) {
      clearTimeout(pauseFadeTimer);
      pauseFadeTimer = null;
      pauseKey = null;
      hiddenPausedKey = null;
      playingKey = null;
      nowPlayingEl.replaceChildren();
      clearAccent();
      vinylLocal = null;
      return;
    }

    const key = trackKey(track);
    if (data.isPlaying) {
      clearTimeout(pauseFadeTimer);
      pauseFadeTimer = null;
      pauseKey = null;
      hiddenPausedKey = null;
    } else {
      if (hiddenPausedKey === key) return;
      if (pauseKey !== key) {
        clearTimeout(pauseFadeTimer);
        pauseKey = key;
        pauseFadeTimer = setTimeout(() => {
          const fading = nowPlayingEl.firstElementChild;
          if (fading) {
            fading.classList.add('is-expiring');
            setTimeout(() => {
              if (nowPlayingEl.firstElementChild === fading) {
                nowPlayingEl.replaceChildren();
                clearAccent();
              }
              hiddenPausedKey = key;
            }, 1_400);
          } else {
            hiddenPausedKey = key;
          }
          pauseFadeTimer = null;
        }, 30_000);
      }
    }

    let overlay = nowPlayingEl.firstElementChild;
    if (!overlay || playingKey !== key) {
      // A genuine track change wakes the mirror up; the first track we ever see
      // (hydrating from localStorage on boot) does not.
      if (playingKey !== null && playingKey !== key) wake('track');
      overlay = makeVinyl(data, key);
      nowPlayingEl.replaceChildren(overlay);
      playingKey = key;
    }
    overlay.classList.remove('is-expiring');
    updateVinylDetails(overlay, data);
  }

  // Cross-fade, and only when the payload actually changed.
  const signatures = {};
  const swapTimers = {};
  const shimmerTimers = {};
  const SHIMMER_MS = 700;

  // Ambient life: fresh data makes the module's own tab flare for a moment, the
  // way a BN folder tab acknowledges a packet. Never the body text — a shimmer
  // that hits the words would make them unreadable at the exact wrong moment.
  function shimmerTab(name) {
    if (REDUCED_MOTION) return;
    const section = document.querySelector(`[data-module="${name}"]`);
    const tabs = section?.querySelectorAll('.tab, .tag');
    if (!tabs?.length) return;
    clearTimeout(shimmerTimers[name]);
    for (const tab of tabs) {
      tab.classList.remove('shimmer');
      void tab.offsetWidth;
      tab.classList.add('shimmer');
    }
    shimmerTimers[name] = setTimeout(() => {
      for (const tab of tabs) tab.classList.remove('shimmer');
    }, SHIMMER_MS);
  }

  function update(name, data) {
    const targets = bodies[name];
    if (!targets) return;
    const signature = JSON.stringify(data ?? null);
    if (signatures[name] === signature) return;
    const first = signatures[name] === undefined;
    signatures[name] = signature;

    const paint = () => {
      for (const target of targets) target.replaceChildren();
      renderers[name](targets, data);
      for (const target of targets) target.classList.remove('fading');
      if (!first) shimmerTab(name);
    };

    clearTimeout(swapTimers[name]);
    if (first) {
      paint();
      return;
    }
    for (const target of targets) target.classList.add('fading');
    swapTimers[name] = setTimeout(paint, FADE_MS);
  }

  // -------------------------------------------------------------- state

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    const modules = state.modules ?? {};
    for (const name of Object.keys(bodies)) update(name, modules[name]?.data ?? null);
    renderNowPlaying(modules.spotify?.data ?? null);

    const cal = modules.calendar?.data ?? null;
    latestCalendar = cal && cal.configured !== false ? cal : null;
    checkImminent();
    if (leavebyEl) {
      const lbData = modules.leaveby?.data ?? null;
      leavebyEl.replaceChildren();
      if (lbData) renderLeaveby(leavebyEl, lbData);
    }

    const stale = Object.values(modules).some((entry) => entry && entry.stale);
    dot.classList.toggle('on', stale);

    document.body.classList.toggle('off', state.display?.on === false);
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full or disabled: the server disk cache still covers a reboot
    }
  }

  function hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) apply(JSON.parse(raw));
    } catch {
      // ignore unreadable cache
    }
  }

  function accept(state) {
    apply(state);
    save(state);
  }

  // ------------------------------------------------------ transport

  let pollTimer = null;

  async function pollOnce() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) accept(await res.json());
    } catch {
      // offline: keep showing what we have, the dot will tell the story
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  let retryTimer = null;

  function connect() {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    let source;
    try {
      source = new EventSource('/api/events');
    } catch {
      startPolling();
      return;
    }

    source.addEventListener('open', stopPolling);
    source.addEventListener('state', (event) => {
      stopPolling();
      try {
        accept(JSON.parse(event.data));
      } catch {
        // malformed frame: next one will do
      }
    });
    source.addEventListener('say', (event) => {
      try {
        const { text, holdMs } = JSON.parse(event.data);
        hermySay(text, holdMs);
        wake('say');
      } catch {
        // malformed say frame: ignore
      }
    });
    // Presence ping from /api/presence (mmWave sensor, eventually). The server
    // keeps no presence state; this is purely a motion cue, and an "absent"
    // frame is a no-op rather than a forced stand-down — a burst that is already
    // running is short enough to let finish.
    source.addEventListener('presence', (event) => {
      try {
        const { present } = JSON.parse(event.data);
        if (present !== false) wake('presence');
      } catch {
        // malformed presence frame: ignore
      }
    });
    source.addEventListener('error', () => {
      source.close();
      startPolling();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, SSE_RETRY_MS);
    });
  }

  // ------------------------------------------------------- hermy avatar

  // 12-frame sheet, 32px cells shown 4x: row 0 idle, row 1 look, row 2 talk.
  // Idle breathes slowly; every so often Hermy glances around. Talk row runs
  // while the dialogue box is typing.
  const hermy = q('#hermy');
  let hermyTalking = false;

  function hermyRun() {
    if (!hermy) return;
    const FRAME = 128;
    let row = 0;
    let col = 0;
    let seq = null; // remaining one-shot frames [row, col]
    const paint = () => {
      hermy.style.backgroundPosition = `-${col * FRAME}px -${row * FRAME}px`;
    };
    const tick = () => {
      if (hermyTalking) {
        row = 2;
        col = (col + 1) % 4;
      } else if (seq && seq.length) {
        [row, col] = seq.shift();
        if (!seq.length) seq = null;
      } else {
        row = 0;
        col = (col + 1) % 4;
      }
      paint();
      setTimeout(tick, hermyTalking ? 220 : seq ? 340 : 700);
    };
    const glance = () => {
      if (!hermyTalking) {
        // look-around one-shot: sweep row 1 out and back
        seq = [[1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 1], [1, 0]];
      }
      setTimeout(glance, 18_000 + Math.random() * 26_000);
    };
    paint();
    setTimeout(tick, 700);
    setTimeout(glance, 9_000 + Math.random() * 9_000);
  }

  // ---------------------------------------------------- hermy dialogue box

  // Output-only BN message box: pixel portrait left, typewriter text right.
  // Triggered by the server's `say` SSE event; auto-dismisses. No input, no
  // log, no sound (speakers belong to Spotify).
  const dialogueMount = q('#hermy-dialogue');
  let sayTimers = [];

  function hermySay(text, holdMs = 0) {
    if (!dialogueMount || !text) return;
    for (const t of sayTimers) clearTimeout(t);
    sayTimers = [];
    dialogueMount.textContent = '';

    const box = el('div', 'say-box');
    const portrait = el('div', 'say-portrait');
    const body = el('p', 'say-text');
    box.append(portrait, body);
    dialogueMount.append(box);

    hermyTalking = true;
    const chars = [...text];
    let i = 0;
    const TYPE_MS = 34;
    const step = () => {
      body.textContent = chars.slice(0, ++i).join('');
      if (i < chars.length) {
        sayTimers.push(setTimeout(step, TYPE_MS));
      } else {
        hermyTalking = false;
        const hold = holdMs || Math.min(4_000 + chars.length * 70, 20_000);
        sayTimers.push(setTimeout(() => {
          box.classList.add('fading');
          sayTimers.push(setTimeout(() => { dialogueMount.textContent = ''; }, 900));
        }, hold));
      }
    };
    sayTimers.push(setTimeout(step, 350));
  }

  // Morning greeting: once per day, first paint between 5am and 11am.
  function maybeGreet() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() < 5 || now.getHours() >= 11) return;
    try {
      if (localStorage.getItem('hermy-greeted') === today) return;
      localStorage.setItem('hermy-greeted', today);
    } catch {
      // storage unavailable: greet anyway
    }
    const day = now.toLocaleDateString('en-US', { weekday: 'long' });
    hermySay(`Good morning, Maanav! ${day}, jacked in and ready. Let's make it count.`);
  }

  // ------------------------------------------------------ motion mode / night

  // calm (default) · active (90s bursts) · night. The machine itself is in
  // mode.js so it can be tested; all this does is publish the result as a body
  // attribute, which is what the CSS motion tokens key off.
  //
  // night keeps its old meaning and its old class: from 22:30 until 05:00 the
  // whole surface dims and non-essential modules (tasks, nanoleaf, quote, hermy)
  // fade out, then the display schedule cuts power at its usual time.
  const modes = createModeMachine({
    reducedMotion: REDUCED_MOTION,
    onChange: ({ mode }) => {
      document.body.dataset.mode = mode;
      document.body.classList.toggle('night', mode === 'night');
    },
  });

  // Something happened at the mirror: run everything at full intensity for a
  // while. Sources are the `say` push, a Spotify track change, and /api/presence.
  function wake(reason) {
    modes.trigger(reason);
  }

  // ---------------------------------------------------------- scanline sweep

  // Every few minutes one window frame gets a single dim scanline. Cadence is
  // deliberately irregular so it never reads as a metronome, and it doubles up
  // while active. Skipped entirely when the panel is dark or nobody can see it.
  const SCAN_MS = { active: [50_000, 40_000], calm: [170_000, 120_000] };

  function scanDelay() {
    const [base, jitter] = SCAN_MS[modes.mode] ?? SCAN_MS.calm;
    return base + Math.random() * jitter;
  }

  function scanOnce() {
    if (document.hidden || document.body.classList.contains('off')) return;
    const frames = [...document.querySelectorAll('.win')].filter(
      (win) => win.offsetWidth > 0 && getComputedStyle(win).visibility !== 'hidden',
    );
    if (!frames.length) return;
    const win = frames[Math.floor(Math.random() * frames.length)];
    win.classList.add('scanning');
    setTimeout(() => win.classList.remove('scanning'), 1_100);
  }

  function scanWatch() {
    if (REDUCED_MOTION) return;
    const loop = () => {
      scanOnce();
      setTimeout(loop, scanDelay());
    };
    setTimeout(loop, scanDelay());
  }

  // ------------------------------------------------------- frame draw-in

  // First paint after the JACK IN overlay clears: each window's notched outline
  // draws itself on, stroke-dashoffset style, then hands over to the real
  // border-image frame. The path is generated at the window's actual pixel size
  // with the same geometry the frame SVG uses (2px inset, 3.4px corner steps at
  // the reference 12px border), so the drawn line lands exactly where the frame
  // will be — including on the rail's one-size-down 9px frame, which scales the
  // border-image slice and therefore scales the inset and the steps with it.
  const DRAW_MS = 900;
  const FRAME_INSET = 2;
  const FRAME_STEP = 3.4;
  const FRAME_BORDER = 12;

  function framePathD(w, h, a = FRAME_INSET, s = FRAME_STEP) {
    const c = a + 2 * s; // where the corner stair meets the straight edge
    return [
      `M${r1(c)} ${r1(a)}`, `H${r1(w - c)}`, `V${r1(a + s)}`, `H${r1(w - a - s)}`,
      `V${r1(c)}`, `H${r1(w - a)}`, `V${r1(h - c)}`, `H${r1(w - a - s)}`,
      `V${r1(h - a - s)}`, `H${r1(w - c)}`, `V${r1(h - a)}`, `H${r1(c)}`,
      `V${r1(h - a - s)}`, `H${r1(a + s)}`, `V${r1(h - c)}`, `H${r1(a)}`,
      `V${r1(c)}`, `H${r1(a + s)}`, `V${r1(a + s)}`, `H${r1(c)}`, 'Z',
    ].join('');
  }

  function drawFrame(win) {
    const w = win.offsetWidth;
    const h = win.offsetHeight;
    if (!w || !h || getComputedStyle(win).visibility === 'hidden') return;

    const frame = win.querySelector('.frame');
    const border = frame ? parseFloat(getComputedStyle(frame).borderTopWidth) : FRAME_BORDER;
    const scale = (Number.isFinite(border) && border > 0 ? border : FRAME_BORDER) / FRAME_BORDER;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'frame-draw');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', framePathD(w, h, FRAME_INSET * scale, FRAME_STEP * scale));
    svg.append(path);
    win.append(svg);

    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    win.classList.add('drawing');
    void svg.getBoundingClientRect(); // commit the undrawn state first

    path.style.transition = `stroke-dashoffset ${DRAW_MS}ms cubic-bezier(.25,.8,.25,1)`;
    path.style.strokeDashoffset = '0';
    setTimeout(() => {
      win.classList.remove('drawing'); // frame + tabs fade in underneath
      svg.classList.add('gone');
      setTimeout(() => svg.remove(), 420);
    }, DRAW_MS);
  }

  function drawFrames() {
    if (REDUCED_MOTION) return;
    for (const win of document.querySelectorAll('.win')) drawFrame(win);
  }

  // ------------------------------------------------------- burn-in shift

  const OFFSETS = [
    [0, 0],
    [4, 3],
    [-3, 5],
    [5, -4],
    [-5, -3],
    [3, 6],
    [-4, 2],
    [2, -5],
  ];
  let offsetIndex = 0;

  function shift() {
    offsetIndex = (offsetIndex + 1) % OFFSETS.length;
    const [x, y] = OFFSETS[offsetIndex];
    root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  // ------------------------------------------------------------- boot

  // One-shot "JACK IN! HERMY.EXE" boot sequence, played only on a full page
  // load (kiosk restart). Black glass, line-work only, no sound; the whole
  // thing is cleared from the DOM when done. Under prefers-reduced-motion we
  // skip straight to the dashboard.
  function bootAnimation(whenDone = () => {}) {
    const boot = document.getElementById('boot');
    if (!boot) {
      whenDone();
      return;
    }

    if (REDUCED_MOTION) {
      boot.classList.add('gone');
      boot.remove();
      whenDone();
      return;
    }

    const textEl = boot.querySelector('.boot-text');
    const sweep = boot.querySelector('.boot-sweep');
    if (!textEl || !sweep) {
      boot.remove();
      whenDone();
      return;
    }

    const phrase = 'JACK IN! HERMY.EXE';
    const TYPE_MS = 40;
    const timers = [];
    let i = 0;

    const finish = () => {
      boot.classList.add('done');
      timers.push(setTimeout(() => {
        boot.classList.add('gone');
        boot.remove();
        whenDone();
      }, 540));
    };

    const type = () => {
      i += 1;
      textEl.textContent = phrase.slice(0, i);
      if (i < phrase.length) {
        timers.push(setTimeout(type, TYPE_MS));
      } else {
        timers.push(setTimeout(() => {
          sweep.classList.add('run');
          timers.push(setTimeout(finish, 380));
        }, 140));
      }
    };

    timers.push(setTimeout(type, 200));
  }

  paintClock();
  modes.sync();
  hydrate();
  pollOnce();
  connect();
  tickVinyl();
  hermyRun();
  maybeGreet();
  scanWatch();
  setInterval(shift, BURN_IN_MS);
  // One second-hand for both: the imminent-event check and the calm/active/night
  // decision are equally cheap and neither wants its own timer.
  setInterval(() => {
    modes.tick();
    checkImminent();
  }, 1_000);
  bootAnimation(drawFrames);

  // A kiosk left running for weeks accumulates renderer cruft; a nightly
  // reload while the panel is dark costs nothing.
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 4 && now.getMinutes() === 3) location.reload();
  }, 60_000);
})();
