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

  const bodies = {
    weather: document.querySelector('#weather .body'),
    calendar: document.querySelector('#calendar .body'),
    quote: document.querySelector('#quote .body'),
    notion: document.querySelector('#notion .body'),
  };

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

  function renderWeather(target, data) {
    if (!data || !data.current) return;
    const wx = el('div', 'wx');
    wx.append(el('span', 'temp', `${data.current.temp}°`));
    wx.append(el('span', 'glyph', data.current.glyph ?? ''));

    const cond = el('span', 'cond');
    cond.append(el('em', null, data.current.text ?? ''));
    const hi = data.today?.hi;
    const lo = data.today?.lo;
    if (hi !== null && hi !== undefined && lo !== null && lo !== undefined) {
      cond.append(el('span', 'hilo', `hi ${hi} · lo ${lo}`));
    }
    wx.append(cond);
    target.append(wx);

    if (data.hours?.length) {
      const hours = el('div', 'hours');
      for (const hour of data.hours) {
        const cell = el('div', 'hour');
        cell.append(el('span', 'h', hour.label));
        cell.append(el('span', 'g', hour.glyph ?? ''));
        cell.append(el('span', 't', hour.temp === null ? '—' : `${hour.temp}°`));
        hours.append(cell);
      }
      target.append(hours);
    }
  }

  function agendaList(events) {
    const list = el('ul', 'agenda');
    for (const event of events) {
      const li = el('li', [event.allDay ? 'allday' : '', event.past ? 'past' : ''].filter(Boolean).join(' '));
      li.append(el('span', 't', event.timeLabel));
      li.append(el('span', null, event.title));
      list.append(li);
    }
    return list;
  }

  function renderCalendar(target, data) {
    if (!data || data.configured === false) return;
    if (data.today?.length) {
      target.append(agendaList(data.today));
      if (data.todayMore > 0) target.append(el('div', 'more', `+${data.todayMore} more`));
    }
    if (data.tomorrow?.length) {
      const sub = el('div', 'sub');
      sub.append(el('span', 'label', 'tomorrow'));
      sub.append(agendaList(data.tomorrow));
      if (data.tomorrowMore > 0) sub.append(el('div', 'more', `+${data.tomorrowMore} more`));
      target.append(sub);
    }
  }

  function renderTodos(target, data) {
    if (!data || !data.groups?.length) return;
    const list = el('ul', 'todos');
    for (const group of data.groups) {
      list.append(el('li', 'area', group.area));
      for (const item of group.items) list.append(el('li', 'item', item.title));
    }
    target.append(list);
    if (data.more > 0) target.append(el('div', 'more', `+${data.more} more`));
  }

  function renderQuote(target, data) {
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

  // Slow cross-fade, and only when the payload actually changed.
  const signatures = {};
  const swapTimers = {};

  function update(name, data) {
    const target = bodies[name];
    if (!target) return;
    const signature = JSON.stringify(data ?? null);
    if (signatures[name] === signature) return;
    const first = signatures[name] === undefined;
    signatures[name] = signature;

    const paint = () => {
      target.replaceChildren();
      renderers[name](target, data);
      target.classList.remove('fading');
    };

    clearTimeout(swapTimers[name]);
    if (first) {
      paint();
      return;
    }
    target.classList.add('fading');
    swapTimers[name] = setTimeout(paint, FADE_MS);
  }

  // -------------------------------------------------------------- state

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    const modules = state.modules ?? {};
    for (const name of Object.keys(bodies)) update(name, modules[name]?.data ?? null);

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
