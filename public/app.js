/*
  mirror frontend.

  Order of events on a cold, offline boot:
    1. clock paints (pure client-side, no network)
    2. last state from localStorage paints
    3. GET /api/state paints (server disk cache, possibly stale)
    4. SSE takes over; if it drops, 60s polling does
  There is no loading state and no spinner at any point.
*/
(() => {
  'use strict';

  const STORAGE_KEY = 'mirror.state.v1';
  const POLL_MS = 60_000;
  const SSE_RETRY_MS = 30_000;
  const BURN_IN_MS = 10 * 60_000;
  const FADE_MS = 900;

  const root = document.getElementById('root');
  const dot = document.getElementById('dot');
  const clockEl = document.getElementById('clock');
  const dateEl = document.getElementById('date');
  const weekEl = document.getElementById('week');

  // A module may paint into several slots at once (weather splits into today's
  // readout and one tomorrow line, calendar into the two agenda columns of the
  // shared frame), so every entry is a list.
  const q = (selector) => document.querySelector(selector);
  const bodies = {
    weather: [q('#wx-today'), q('#wx-tomorrow')],
    calendar: [q('#cal-today'), q('#cal-tomorrow')],
    quote: [q('#quote .body')],
    notion: [q('#notion .body')],
    nanoleaf: [q('#nanoleaf .body')],
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

  function paintClock() {
    const now = new Date();
    const time = timeFmt.format(now);
    if (clockEl.textContent !== time) clockEl.textContent = time;

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
  // server already ships per slot. One <path> per icon, currentColor, no
  // fills — the same brightness physics as the rest of the glass.

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
    sun: () => circleD(24, 24, 8.5) + raysD(24, 24, 12.5, 16.5, [0, 45, 90, 135, 180, 225, 270, 315]),
    'sun-cloud': () =>
      circleD(19, 18, 7.5) +
      raysD(19, 18, 11, 15, [0, 315, 270, 225, 180, 135]) +
      'M25 36a4.5 4.5 0 0 1 2-8.4 6.5 6.5 0 0 1 12.4-.8 4.5 4.5 0 0 1 1.6 9.2z',
    'cloud-sun': () => circleD(35, 12, 5) + raysD(35, 12, 8, 11.5, [0, 315, 270]) + cloudD(2),
    cloud: () => cloudD(2),
    fog: () => cloudD(-4) + 'M14 33h20M18 39h13',
    drizzle: () => cloudD(-5) + 'M18 31l-1 3M26 31l-1 3M34 31l-1 3',
    rain: () => cloudD(-6) + 'M19 29l-3 9M27 29l-3 9M35 29l-3 9',
    sleet: () => cloudD(-6) + 'M19 29l-3 9M35 29l-3 9' + flakeD(26, 34),
    snow: () => cloudD(-6) + flakeD(17, 33) + flakeD(25, 37) + flakeD(33, 33),
    storm: () => cloudD(-7) + 'M27 26l-6 9h7l-6 10',
    unknown: () => 'M24 15l8 9-8 9-8-9z',
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

  function weatherIcon(code, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[iconKind(code)]());
    path.setAttribute('stroke-width', '2');
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
  function renderWeather([today, tomorrow], data) {
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
  }

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
      li.append(el('span', 't', event.timeLabel));
      li.append(el('span', 'n', event.title));
      list.append(li);
    }
    return list;
  }

  // The agenda frame has to fit inside the top band, so the glass shows fewer
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

  // Sparse on purpose: the server caps at 8 visible, the glass shows fewer.
  const TODOS_SHOWN = 4;

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
    if (!data || !data.eventTitle || !data.leaveBy) return;
    target.append(el('span', null, `\u25B6 LEAVE BY ${data.leaveBy} \u00B7 ${data.driveMin} MIN DRIVE`));
  }

  const renderers = {
    weather: renderWeather,
    calendar: renderCalendar,
    quote: renderQuote,
    notion: renderTodos,
    nanoleaf: renderNanoleaf,
  };

  // ------------------------------------------------------ now playing

  let pauseFadeTimer = null;
  let pauseKey = null;
  let hiddenPausedKey = null;
  let playingKey = null;

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
    overlay.append(record);

    const meta = el('div', 'vinyl-meta');
    meta.append(el('div', 'vinyl-title'));
    meta.append(el('div', 'vinyl-artists'));
    const progress = el('div', 'vinyl-progress');
    progress.append(el('span'));
    meta.append(progress);
    overlay.append(meta);
    return overlay;
  }

  function updateVinylDetails(overlay, data) {
    overlay.classList.toggle('is-playing', Boolean(data.isPlaying));
    overlay.classList.toggle('is-paused', !data.isPlaying);
    overlay.querySelector('.vinyl-title').textContent = data.track.name;
    overlay.querySelector('.vinyl-artists').textContent = (data.track.artists ?? []).join('  /  ') || 'unknown artist';
    const ratio = data.durationMs > 0 ? Math.min(1, Math.max(0, data.progressMs / data.durationMs)) : 0;
    overlay.querySelector('.vinyl-progress span').style.width = `${Math.round(ratio * 1000) / 10}%`;
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
      overlay = makeVinyl(data, key);
      nowPlayingEl.replaceChildren(overlay);
      playingKey = key;
    }
    overlay.classList.remove('is-expiring');
    updateVinylDetails(overlay, data);
  }

  // Slow cross-fade, and only when the payload actually changed.
  const signatures = {};
  const swapTimers = {};

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
      } catch {
        // malformed say frame: ignore
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

  // ------------------------------------------------------------ night mode

  // From 22:30 until 05:00 the whole surface dims and non-essential modules
  // (tasks, nanoleaf, quote, hermy) fade out: the mirror keeps clock, weather
  // and agenda at low brightness for the wind-down, then the display schedule
  // cuts power at its usual time. Pure CSS class; no server involvement.
  function nightWatch() {
    const apply = () => {
      const h = new Date().getHours() + new Date().getMinutes() / 60;
      document.body.classList.toggle('night', h >= 22.5 || h < 5);
    };
    apply();
    setInterval(apply, 60_000);
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

  paintClock();
  hydrate();
  pollOnce();
  connect();
  hermyRun();
  maybeGreet();
  nightWatch();
  setInterval(shift, BURN_IN_MS);

  // A kiosk left running for weeks accumulates renderer cruft; a nightly
  // reload while the panel is dark costs nothing.
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 4 && now.getMinutes() === 3) location.reload();
  }, 60_000);
})();
