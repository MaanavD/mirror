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
  };
  const nowPlayingEl = q('#now-playing');

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
    list.firstChild.classList.add('sel');
    target.append(list);
    const more = (data.more ?? 0) + hidden;
    if (more > 0) target.append(el('div', 'more', `+${more} more`));
  }

  function renderQuote([target], data) {
    if (!data || !data.text) return;
    target.append(el('blockquote', null, data.text));
    if (data.author) target.append(el('div', 'by', data.author));
  }

  const renderers = {
    weather: renderWeather,
    calendar: renderCalendar,
    quote: renderQuote,
    notion: renderTodos,
  };

  // ------------------------------------------------------ now playing

  let pauseFadeTimer = null;
  let pauseKey = null;
  let hiddenPausedKey = null;
  let playingKey = null;

  function trackKey(track) {
    return `${track?.name ?? ''}\\u0000${(track?.artists ?? []).join('\\u0000')}`;
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
              if (nowPlayingEl.firstElementChild === fading) nowPlayingEl.replaceChildren();
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
    source.addEventListener('error', () => {
      source.close();
      startPolling();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, SSE_RETRY_MS);
    });
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
  setInterval(shift, BURN_IN_MS);

  // A kiosk left running for weeks accumulates renderer cruft; a nightly
  // reload while the panel is dark costs nothing.
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 4 && now.getMinutes() === 3) location.reload();
  }, 60_000);
})();
