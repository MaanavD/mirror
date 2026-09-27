import { fresh, dateKey, timeLabel, instant, horizonFor, sunlightFor, MINUTE } from './attention.js';
import { lightingFor, streamFor, headlineFor, focusTasks, comfortFor, durationLabel } from './day-model.js';
import { sleepSchedule, scheduleFromState, phaseAt } from './sleep-model.js';

/*
  Renders /api/state onto the glass. Three inputs decide what shows:
    phase    (sleep-model)  day · winddown · bedtime · night · morning
    linger   (presence)     standing at the mirror ≥ 8s reveals the second layer
    data     (modules)      a module that is stale or empty simply isn't there
*/

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const mirror = params.get('view') === 'mirror';
const example = params.get('example');
const cacheKey = 'hermy.brief.state.v1';
const LINGER_MS = 8_000;

let state = null;
let spoken = null;
let presentSince = null;
let lastClock = '';
let speechTimer;
const signatures = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ── helpers ────────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
function reveal(target) {
  if (reducedMotion.matches || document.hidden) return;
  target.getAnimations().forEach((a) => a.cancel());
  target.animate([{ opacity: 0.35, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }],
    { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' });
}
/** Rebuild a region only when what it shows actually changed. */
function replace(id, signature, build) {
  const sig = JSON.stringify(signature);
  if (signatures.get(id) === sig) return;
  signatures.set(id, sig);
  const target = $(id);
  const before = target.textContent;
  target.replaceChildren(...build().filter(Boolean));
  if (before && before !== target.textContent) reveal(target);
}
const t = (value, zone) => timeLabel(value, zone);
const minuteOf = (now) => Math.floor(now / MINUTE);
function relative(at, now) {
  const ms = at - now;
  if (ms <= MINUTE) return 'now';
  return ms < 60 * MINUTE ? `in ${Math.ceil(ms / MINUTE)} min` : `in ${durationLabel(ms)}`;
}
function weatherGlyph(code) {
  return code === 0 ? '☀' : code <= 2 ? '◐' : code <= 3 ? '☁' : code <= 48 ? '≋'
    : code >= 71 && code <= 77 ? '❄' : code >= 95 ? 'ϟ' : '☂';
}
const deg = (v) => (Number.isFinite(v) ? `${Math.round(v)}°` : '—');
const wet = (code) => code >= 51 && code <= 99;

// ── context ────────────────────────────────────────────────────────────────
function scheduleNow(now, zone) {
  const fromServer = scheduleFromState(state?.sleep);
  if (fromServer) return { ...fromServer, phase: phaseAt(fromServer, now) };
  const m = state?.modules ?? {};
  return sleepSchedule({ now, zone, calendar: m.calendar, wellness: m.wellness });
}
const lingering = () => presentSince != null && Date.now() - presentSince >= LINGER_MS;

// ── top band ───────────────────────────────────────────────────────────────
function renderClock(now, zone) {
  const text = timeLabel(now, zone);
  if (text === lastClock) return;
  lastClock = text;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(new Date(now));
  $('time').textContent = parts.filter((p) => ['hour', 'minute', 'literal'].includes(p.type)).map((p) => p.value).join('').trim();
  $('period').textContent = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
  $('date').textContent = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' })
    .format(new Date(now));
}

function renderNowWeather(m, now) {
  const d = fresh(m.weather, 'weather', now) ? m.weather.data : null;
  replace('now-weather', [d?.current, d?.today], () => {
    if (!d?.current) return [];
    const temp = el('div', 'temp');
    temp.append(el('span', 'glyph', weatherGlyph(d.current.code)), el('span', 'deg', deg(d.current.temp)));
    return [temp, el('p', 'cond', d.current.text),
      Number.isFinite(d.today?.hi) ? el('p', 'range', `H ${deg(d.today.hi)} · L ${deg(d.today.lo)}`) : null];
  });
}

function renderHeadline(h, current, now) {
  const node = $('headline');
  node.className = `headline ${h.tone}`;
  replace('headline', [h, current ? minuteOf(now) : null], () => {
    const label = el('p', 'label');
    label.append(el('span', 'kw', h.label), document.createTextNode(h.detail ?? ''));
    const out = [label, el('p', 'title', h.title)];
    if (current && h.tone === 'now') {
      const bar = el('div', 'bar'), fill = el('span');
      fill.style.width = `${Math.min(100, Math.max(0, ((now - current.at) / (current.end - current.at)) * 100))}%`;
      bar.append(fill);
      out.push(bar);
    }
    return out;
  });
}

// ── left rail: rest of today ───────────────────────────────────────────────
function streamRow(r, now, zone, sleep) {
  const li = el('li', r.kind);
  const meta = (text) => li.append(el('p', 'meta', text));
  const title = (text) => li.append(el('p', 'title', text));
  if (r.kind === 'event') {
    if (r.now) li.classList.add('now');
    else if (r.at - now <= 15 * MINUTE) li.classList.add('soon');
    meta(r.now ? `now · until ${t(r.end, zone)}` : `${t(r.at, zone)} · ${relative(r.at, now)}`);
    title(r.title);
    if (r.location) li.append(el('p', 'sub', r.location));
  } else if (r.kind === 'gap') {
    title(`${durationLabel(r.end - Math.max(r.at, now))} free${r.beforeBed ? ' before bed' : ''}`);
  } else if (r.kind === 'cutoff') {
    if (r.live) li.classList.add('live');
    meta(r.end ? `${t(r.at, zone)}–${t(r.end, zone)}` : t(r.at, zone));
    title(r.title);
  } else if (r.kind === 'bed') {
    meta(`${t(r.at, zone)} · ${relative(r.at, now)}`);
    title(`Bed → up ${t(sleep.wakeAt, zone)}`);
    if (r.basis === 'first meeting' && r.firstMeeting) li.append(el('p', 'sub', `for ${t(r.firstMeeting.at, zone)} ${r.firstMeeting.title}`));
  } else if (r.kind === 'tomorrow') {
    meta(t(r.at, zone));
    title(r.title);
  }
  return li;
}

function renderStream(stream, headline, now, sleep) {
  const { zone } = stream;
  const winddown = sleep.phase === 'winddown';
  $('stream-heading').textContent = sleep.phase === 'morning' ? 'Today' : winddown ? 'Tonight' : 'Rest of today';
  // Whatever the headline names is not repeated in the rail.
  const rows = stream.rows.filter((r) => r.id == null || r.id !== headline.eventId);
  const glance = winddown ? 6 : 4;
  replace('stream', [rows, stream.tomorrow, minuteOf(now), sleep.wakeAt], () => {
    const out = rows.map((r, i) => {
      const li = streamRow(r, now, zone, sleep);
      if (i >= glance && r.kind !== 'bed') li.classList.add('extra');
      return li;
    });
    if (stream.tomorrow.length) {
      const brk = el('li', 'day-break');
      brk.append(el('p', 'meta', 'Tomorrow'));
      out.push(brk, ...stream.tomorrow.map((r) => streamRow(r, now, zone, sleep)));
    }
    if (!out.length) out.push(el('li', 'gap', stream.calendarReady ? 'Nothing else scheduled' : 'Calendar reconnecting'));
    return out;
  });
  $('all-day').hidden = !stream.allDay.length;
  $('all-day').textContent = stream.allDay.join(' · ');
  const note = $('stream-note');
  note.hidden = stream.calendarReady;
  note.textContent = stream.calendarReady ? '' : 'Calendar update delayed';
}

// ── right rail ─────────────────────────────────────────────────────────────
function renderWeatherBlock(m, now, zone) {
  const d = fresh(m.weather, 'weather', now) ? m.weather.data : null;
  const sun = sunlightFor(m.astro, now, zone);
  const call = comfortFor(m.weather, now, zone);
  replace('weather-block', [d?.hours, call, sun, minuteOf(now) - (minuteOf(now) % 10)], () => {
    const hours = (d?.hours ?? []).filter((h) => instant(h.at) + 60 * MINUTE > now).slice(1, 6);
    if (!hours.length && !sun.length) return [];
    const out = [el('h2', 'rail-label', 'Weather ahead')];
    if (call) out.push(el('p', 'weather-call', call));
    const list = el('div', 'hours');
    for (const h of hours) {
      const row = el('div', `hour${wet(h.code) ? ' wet' : ''}`);
      row.append(el('span', 't', t(instant(h.at), zone).replace(':00', '')), el('span', 'g', weatherGlyph(h.code)), el('span', 'v', deg(h.temp)));
      list.append(row);
    }
    out.push(list);
    if (sun.length) {
      const s = el('div', 'sun');
      for (const info of sun) s.append(el('p', info.kind, [info.title, info.detail].filter(Boolean).join(' · ')));
      out.push(s);
    }
    return out;
  });
}

function renderFocus(now) {
  const tasks = focusTasks(state, now, 4);
  $('focus-block').hidden = !tasks.length;
  replace('focus', tasks.map((x) => [x.id, x.reason, x.title]), () => tasks.map((task, i) => {
    const row = el('div', `item${i >= 2 ? ' extra' : ''}`);
    row.append(el('p', 'meta', `${task.source === 'work' ? 'Work' : 'Personal'} · ${task.reason}`), el('p', 'title', task.title));
    return row;
  }));
}

function renderAhead(m, now, zone) {
  const horizon = horizonFor(m.countdown, now, zone);
  const progress = fresh(m.progress, 'progress', now) ? m.progress.data : null;
  const items = (horizon?.items ?? []).slice(0, 2);
  const week = progress?.trackingSince && Number.isFinite(progress.weekCount) ? progress.weekCount : null;
  $('ahead-block').hidden = !items.length && week == null;
  replace('ahead', [items, week], () => {
    const out = items.map((i) => {
      const row = el('div', 'count'), what = el('div', 'what');
      const name = String(i.label).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bSf\b/g, 'SF');
      what.append(el('span', 'kind', i.kind === 'flight' ? 'Trip' : 'Milestone'), document.createTextNode(name));
      const days = el('div', 'days', i.days === 0 ? 'today' : i.days);
      if (i.days) days.append(el('small', '', i.days === 1 ? 'day' : 'days'));
      row.append(what, days);
      return row;
    });
    if (week != null) {
      const p = el('p', 'week');
      p.append(el('strong', '', week), document.createTextNode(` ${week === 1 ? 'task' : 'tasks'} done this week`));
      out.push(p);
    }
    return out;
  });
}

function renderHome(m, now) {
  const lights = lightingFor(m.nanoleaf, now);
  replace('home', lights, () => {
    const row = el('div', 'lights');
    for (const l of lights) {
      const n = el('span', `light ${l.status}`);
      n.append(el('i'), document.createTextNode(`${l.name} ${l.status === 'unknown' ? '?' : l.status}`));
      if (l.percent != null) n.append(el('span', 'pct', `${l.percent}%`));
      row.append(n);
    }
    return [row];
  });
}

// ── bottom band ────────────────────────────────────────────────────────────
function renderAgents(m, now) {
  const data = fresh(m.agents, 'agents', now) ? m.agents.data : null;
  const items = (data?.items ?? []).filter((a) => a.status === 'waiting' || (a.live === true
    && (example || (Number.isFinite(a.lastActivityAt) && now / 1000 - a.lastActivityAt <= 180))
    && ['running', 'working', 'thinking', 'tool'].includes(a.status))).slice(0, 4);
  $('agents').hidden = !items.length;
  replace('agents', items.map((a) => [a.id, a.status, a.task]), () => {
    const live = items.filter((a) => a.live).length;
    const out = [el('p', 'status', live ? `${live} agent${live === 1 ? '' : 's'} working` : 'Waiting on you')];
    for (const a of items) {
      const row = el('div', `agent${a.live ? '' : ' waiting'}`);
      const sprite = el('span', 'agent-sprite');
      const hue = [0, 45, 90, 150, 220, 285][String(a.id).split('').reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 6, 0)];
      sprite.style.setProperty('--agent-hue', `${hue}deg`);
      const copy = el('div', 'agent-copy');
      copy.append(el('p', 'name', a.source?.startsWith('hermes-') ? 'Hermes' : a.name ?? 'Agent'), el('p', 'task', a.task ?? 'Working'));
      row.append(sprite, copy);
      out.push(row);
    }
    return out;
  });
}

function renderMusic(m, now) {
  const d = fresh(m.spotify, 'spotify', now) ? m.spotify.data : null;
  const playing = d?.isPlaying === true && d.track;
  $('music').hidden = !playing;
  if (!playing) return;
  replace('music', [d.track, Math.round((d.progressMs / Math.max(1, d.durationMs)) * 50)], () => {
    const out = [];
    if (d.track.albumArtUrl) { const art = el('img'); art.src = d.track.albumArtUrl; art.alt = ''; out.push(art); }
    const copy = el('div', 'copy'), title = el('p', 'title', d.track.name);
    title.append(el('span', '', `  ${(d.track.artists ?? []).join(', ')}`));
    const bar = el('div', 'progress'), fill = el('span');
    fill.style.width = `${Math.min(100, Math.max(0, (d.progressMs / Math.max(1, d.durationMs)) * 100))}%`;
    bar.append(fill);
    copy.append(el('p', 'meta', 'Now playing'), title, bar);
    out.push(copy);
    return out;
  });
}

function renderHermy(m, now) {
  const speaking = spoken?.until > Date.now() || example === 'talking';
  const quote = fresh(m.quote, 'quote', now) ? m.quote.data : null;
  $('hermy').classList.toggle('speaking', speaking);
  $('hermy-note').textContent = spoken?.until > Date.now() ? spoken.text
    : quote?.text ?? 'One thing at a time.';
  $('quote-author').textContent = !speaking && quote?.author ? `— ${quote.author}` : '';
}

// ── frame ──────────────────────────────────────────────────────────────────
function render() {
  const now = example && state?.exampleNow ? state.exampleNow : Date.now();
  const m = state?.modules ?? {};
  const zone = m.calendar?.data?.timeZone ?? 'America/Los_Angeles';
  const sleep = scheduleNow(now, zone);
  const body = document.body;
  for (const p of ['day', 'winddown', 'bedtime', 'night', 'morning']) body.classList.toggle(`phase-${p}`, sleep.phase === p);
  body.classList.toggle('warm', ['winddown', 'bedtime', 'night'].includes(sleep.phase));
  body.classList.toggle('linger', example === 'linger' || lingering());
  body.classList.toggle('soft-off', mirror && !example && state?.display?.on === false);

  const stream = streamFor(state, now, sleep, { allCutoffs: sleep.phase === 'winddown' });
  const headline = headlineFor(state, now, sleep, stream);
  renderClock(now, zone);
  renderNowWeather(m, now);
  renderHeadline(headline, stream.rows.find((r) => r.kind === 'event' && r.now), now);
  renderStream(stream, headline, now, sleep);
  renderWeatherBlock(m, now, zone);
  renderFocus(now);
  renderAhead(m, now, zone);
  renderHome(m, now);
  renderAgents(m, now);
  renderMusic(m, now);
  renderHermy(m, now);
  $('stale-dot').hidden = !Object.entries(m).some(([name, entry]) =>
    ['calendar', 'weather'].includes(name) && entry?.data && !fresh(entry, name, now));
}

function accept(next) {
  if (!next?.modules) return;
  state = next;
  if (!example) try { localStorage.setItem(cacheKey, JSON.stringify(next)); } catch {}
  render();
}

// Anywhere but the kiosk, show the whole 1080×1920 canvas scaled to fit.
function fit() {
  if (mirror) return;
  const scale = Math.min(innerWidth / 1080, innerHeight / 1920);
  const board = $('dashboard');
  board.style.transform = `scale(${scale})`;
  board.style.marginLeft = `${Math.max(0, (innerWidth - 1080 * scale) / 2)}px`;
}
addEventListener('resize', fit);
fit();

if (example) {
  const bar = $('example-bar');
  bar.hidden = false;
  bar.textContent = `Example · ${example} · sample data`;
  const { exampleState } = await import('./dashboard-examples.js');
  accept(exampleState(example, Date.now()));
} else {
  const { startLiveUpdates } = await import('./live-updates.js');
  startLiveUpdates();
  try { state = JSON.parse(localStorage.getItem(cacheKey)); } catch { state = null; }
  render();
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const r = await fetch('/api/state?view=dashboard', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (r.ok) accept(await r.json());
    } catch {} finally { polling = false; }
  };
  poll();
  const stream = new EventSource('/api/events?view=dashboard');
  stream.addEventListener('state', (e) => { try { accept(JSON.parse(e.data)); } catch {} });
  stream.addEventListener('say', (e) => {
    try {
      const d = JSON.parse(e.data);
      spoken = { text: String(d.text ?? '').slice(0, 220), until: Date.now() + Math.min(Number(d.holdMs) || 20_000, 60_000) };
      clearTimeout(speechTimer);
      speechTimer = setTimeout(() => { spoken = null; render(); }, spoken.until - Date.now());
      render();
    } catch {}
  });
  stream.addEventListener('sensors', (e) => {
    try {
      const present = JSON.parse(e.data).present === true;
      presentSince = present ? presentSince ?? Date.now() : null;
    } catch {}
  });
  // Within the agent feed's 30-second freshness window, even without SSE.
  setInterval(poll, 15_000);
}
setInterval(render, 5_000);
// Burn-in: drift the whole canvas a few pixels every ten minutes.
if (mirror && !reducedMotion.matches) {
  setInterval(() => {
    $('dashboard').style.translate = `${Math.round(Math.random() * 6 - 3)}px ${Math.round(Math.random() * 6 - 3)}px`;
  }, 10 * MINUTE);
}
