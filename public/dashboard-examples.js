// Explicitly selected preview scenarios (?example=<kind>). Never mixed into
// the live feed. Each pins its own clock so phases render deterministically.
import { localInstant } from './day-model.js';

const zone = 'America/Los_Angeles';
const MINUTE = 60_000;
export const EXAMPLES = ['day', 'now', 'soon', 'morning', 'winddown', 'bedtime', 'quiet', 'agents', 'linger', 'stale'];

// Local clock time per scenario (hour, minute) on today's date.
const CLOCK = {
  day: [14, 10], now: [11, 20], soon: [15, 52], morning: [8, 55], winddown: [22, 40],
  bedtime: [0, 50], quiet: [16, 0], agents: [14, 10], linger: [14, 10], stale: [14, 10], talking: [14, 10],
};

export function exampleState(kind, realNow = Date.now()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(realNow);
  const [hour, minute] = CLOCK[kind] ?? CLOCK.day;
  const now = localInstant(today, hour, zone, minute);
  const iso = (t) => new Date(t).toISOString();
  const at = (h, m = 0, day = today) => localInstant(day, h, zone, m);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const module = (data) => ({ data, stale: false, fetchedAt: now });
  const event = (id, title, start, minutes, location = null) =>
    ({ id, title, allDay: false, busy: true, start: iso(start), end: iso(start + minutes * MINUTE), location });

  const events = [
    event('standup', 'Team standup', at(10), 30, 'Video call'),
    event('review', 'Design review with Aitana', at(11), 60, 'Room 4 / Zoom'),
    event('lunch', 'Lunch · Sam', at(12, 30), 60, 'Tamari Bar'),
    event('demo', 'FLUX demo dry run', at(16), 45, 'Video call'),
    event('climb', 'Bouldering + anti-rotation', at(19), 65, 'Klickway'),
    event('t-standup', 'Team standup', at(10, 0, tomorrow), 30, 'Video call'),
    event('t-1on1', '1:1 with Andreas', at(11, 30, tomorrow), 30),
  ];
  const s = {
    generatedAt: iso(now), exampleNow: now, display: { on: true },
    modules: {
      calendar: module({ configured: true, coverageComplete: true, timeZone: zone, events }),
      weather: module({
        current: { temp: 14, code: 2, text: 'Partly cloudy' }, today: { hi: 18, lo: 11 },
        hours: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ at: iso(now - (now % (60 * MINUTE)) + i * 60 * MINUTE), temp: 14 + (i < 3 ? i : 5 - i), code: i === 3 || i === 4 ? 61 : 2 })),
      }),
      astro: module({ sunsetAt: iso(at(19, 2)), uvHours: [9, 10, 11, 12, 13, 14, 15, 16, 17].map((h, i) => ({ at: iso(at(h)), uv: [1, 2, 3.2, 4.4, 5, 4.6, 3.4, 2, 1][i] })) }),
      notion: module({ configured: true, items: [
        { id: 'p1', title: 'Book the physio appointment', due: today, source: 'personal' },
        { id: 'p2', title: 'Pack for SF move', status: 'In progress', source: 'personal' },
      ] }),
      workboard: module({ configured: true, items: [
        { id: 'w1', title: 'Review the new demo samples', status: 'Review', source: 'work' },
        { id: 'w2', title: 'Draft the launch FAQ', status: 'In progress', source: 'work' },
      ] }),
      countdown: module({ items: [{ kind: 'flight', label: 'ATHENS', days: 6, via: ['TORONTO'] }, { kind: 'milestone', label: 'SF MOVE', days: 18 }] }),
      progress: module({ weekCount: 6, trackingSince: iso(now - 20 * 86_400_000), timeZone: zone, items: [] }),
      nanoleaf: module({ lights: [
        { entityId: 'light.shapes_a418', name: 'Flower', on: true, brightness: 140 },
        { entityId: 'light.shapes_dedf', name: 'Bedstagons', on: false, brightness: 0 },
      ] }),
      quote: module({ text: 'Knowing yourself is the beginning of all wisdom.', author: 'Aristotle' }),
      wellness: module({ score: 78, hrv: 52, dayWindow: {
        lastNight: { wakeAt: iso(at(8, 20)), durationHours: 7.4, score: 84 },
      } }),
      agents: module({ connected: true, items: [] }),
      spotify: module({ isPlaying: false }),
    },
  };
  const m = s.modules;
  if (kind === 'day' || kind === 'linger' || kind === 'agents') {
    m.spotify = module({ isPlaying: true, track: { name: 'You Are the Right One', artists: ['Sports'] }, progressMs: 74_000, durationMs: 210_000 });
    m.agents.data.items = [
      { id: 'a', name: 'Hermes', task: 'Preparing the demo comparison', status: 'running', live: true },
      { id: 'b', name: 'Luna', task: 'Checking the documentation links', status: 'running', live: true },
    ];
  }
  if (kind === 'agents') m.agents.data.items.push(
    { id: 'c', name: 'Scout', task: 'Collecting research sources', status: 'running', live: true },
    { id: 'f', name: 'Atlas', task: 'Waiting for your review of the draft', status: 'waiting', live: false });
  if (kind === 'quiet') m.calendar.data.events = events.filter((e) => e.id.startsWith('t-'));
  if (kind === 'morning') m.weather.data.hours[2].code = 63;
  if (kind === 'bedtime') m.wellness.data.dayWindow.lastNight.wakeAt = iso(at(8, 20, yesterday));
  if (kind === 'stale') for (const entry of Object.values(m)) { entry.fetchedAt = now - 2 * 86_400_000; entry.stale = true; }
  return s;
}
