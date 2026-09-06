// Shared, clock-driven presentation model. No network, DOM, or side effects.
export const MINUTE = 60_000;
const WINDOWS = { calendar: 20, notion: 20, weather: 45, leaveby: 15,
  aqi: 60, astro: 180, wellness: 180, countdown: 360, spotify: 2, nanoleaf: 1,
  news: 45, quote: 2160, hermy: 20, chipdrop: 1440, mystery: 10080, workboard:20, progress:20, agents:.5 };
export const instant = (value) => value == null || value === '' ? NaN
  : typeof value === 'number' ? value : Date.parse(value);
export function fresh(entry, name, now = Date.now()) {
  const age = now - instant(entry?.fetchedAt);
  return Boolean(entry && !entry.stale && Number.isFinite(age)
    && age >= -MINUTE && age <= (WINDOWS[name] ?? 20) * MINUTE);
}
export function dateKey(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export function timeLabel(now, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(now));
}
export function ageLabel(at, now = Date.now()) {
  const age = now - instant(at);
  if (!Number.isFinite(age)) return 'No recent update';
  const mins = Math.max(0, Math.floor(age / MINUTE));
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  if (mins < 1440) return `Updated ${Math.floor(mins / 60)} hr ago`;
  return `Updated ${Math.floor(mins / 1440)} days ago`;
}
export function allEvents(data) {
  const seen = new Set();
  return [...(data?.events ?? []), ...(data?.today ?? []), ...(data?.tomorrow ?? [])]
    .filter(e => {
      const key = `${e.calendarId ?? ''}:${e.id}:${e.start}`;
      if (seen.has(key) || !Number.isFinite(instant(e.start))) return false;
      seen.add(key); return true;
    }).sort((a,b) => instant(a.start) - instant(b.start));
}
export function agendaFor(data, day, now, timeZone) {
  return allEvents(data).filter(e => {
    const end = instant(e.end);
    if (e.allDay) return dateKey(instant(e.start), timeZone) <= day
      && dateKey(Number.isFinite(end) ? end - 1 : instant(e.start), timeZone) >= day;
    return dateKey(instant(e.start), timeZone) <= day
      && dateKey(Number.isFinite(end) && end > instant(e.start) ? end - 1 : instant(e.start), timeZone) >= day
      && (!Number.isFinite(end) || end > now || instant(e.start) >= now);
  });
}
const dueDay = (task, zone) => task.due && Number.isFinite(instant(task.due))
  ? task.due.length===10?task.due:dateKey(instant(task.due),zone) : null;
export function tasksFor(data, focusId, now = Date.now(), timeZone = 'America/Los_Angeles') {
  const items = data?.items ?? (data?.groups ?? []).flatMap(g =>
    (g.items ?? []).map(i => ({...i, area: g.area})));
  const today = dateKey(now,timeZone);
  const rank = t => {const due=dueDay(t,timeZone);return !due?3:due===today?0:due<today?1:2;};
  return [...items].sort((a,b) => Number(b.id === focusId) - Number(a.id === focusId)
    || rank(a)-rank(b)
    || (rank(a)===1 ? String(b.due).localeCompare(String(a.due)) : String(a.due??'').localeCompare(String(b.due??''))));
}
export function horizonFor(entry, now, timeZone) {
  if (!fresh(entry,'countdown',now)) return null;
  const elapsedDays = Math.round((Date.parse(dateKey(now,timeZone))-Date.parse(dateKey(instant(entry.fetchedAt),timeZone)))/86400000);
  return {items:(entry.data?.items??[]).map(i=>({...i,days:i.days-elapsedDays})).filter(i=>Number.isFinite(i.days)&&i.days>=0)};
}
export function buildAttention(state, { now = Date.now(), snoozed = {} } = {}) {
  const m = state?.modules ?? {};
  const timeZone = m.calendar?.data?.timeZone ?? 'America/Los_Angeles';
  const notices = [];
  const events = fresh(m.calendar, 'calendar', now) && m.calendar?.data?.configured !== false
    ? allEvents(m.calendar.data).filter(e => !e.allDay) : [];
  const next = events.find(e => instant(e.start) > now);
  const current = events.find(e => instant(e.start) <= now && instant(e.end) > now);
  const leave = fresh(m.leaveby, 'leaveby', now) ? m.leaveby.data : null;
  const leaveAt = instant(leave?.leaveByMs);
  const leaveEvent = events.find(e => e.title === leave?.eventTitle && instant(e.start) > now);
  let leaving = false;
  if (leaveEvent && leaveAt > now - 10 * MINUTE && leaveAt <= now + 60 * MINUTE) {
    const minutes = Math.max(0, Math.ceil((leaveAt - now) / MINUTE));
    leaving = true;
    notices.push({ id: `leave:${leaveEvent.id}:${leaveAt}`, type: 'leave', priority: 100,
      label: minutes <= 1 ? 'Time to leave' : `Leave in ${minutes} min`,
      title: leave.eventTitle, detail: `${leave.driveMin ?? 'Estimated'} min drive · arrive by ${timeLabel(instant(leaveEvent.start), timeZone)}`,
      note: 'Route estimate includes an 8 min buffer; traffic may vary.',
      expiresAt: Math.min(instant(leaveEvent.start), leaveAt + 10 * MINUTE), urgent: minutes <= 10 });
  }
  const event = next && instant(next.start) - now <= 10 * MINUTE ? next : current ?? next;
  if (event && !(leaving && event.id === leaveEvent.id)) {
    const minutes = Math.ceil((instant(event.start) - now) / MINUTE);
    const isCurrent=event===current;
    if (isCurrent || minutes <= 30) notices.push({ id: `event:${event.id}:${event.start}`, type: 'event',
      priority: isCurrent ? 80 : minutes <= 10 ? 90 : 70,
      label: isCurrent ? 'Happening now' : `Starts in ${minutes} min`, title: event.title,
      detail: isCurrent ? `Until ${timeLabel(instant(event.end), timeZone)}` : `${timeLabel(instant(event.start), timeZone)}${event.location ? ` · ${event.location}` : ''}`,
      expiresAt: instant(event.end) || instant(event.start) + 30 * MINUTE, urgent: !isCurrent && minutes <= 10 });
  }
  const rain = fresh(m.weather, 'weather', now) ? m.weather.data?.rain : null;
  const rainAt = instant(rain?.rainAtISO);
  if (rainAt >= now - 15 * MINUTE && rainAt <= now + 90 * MINUTE) {
    const minutes = Math.ceil((rainAt - now) / MINUTE);
    notices.push({ id: `rain:${rain.rainAtISO}`, type: 'rain', priority: 60,
      label: minutes <= 0 ? 'Rain forecast now' : `Rain in about ${minutes} min`,
      title: 'Take an umbrella if you head out', detail: 'Local precipitation forecast',
      expiresAt: rainAt + 15 * MINUTE, urgent: false });
  }
  if (fresh(m.notion, 'notion', now)) {
    const today = dateKey(now, timeZone);
    const due = tasksFor(m.notion.data,null,now,timeZone).filter(t => dueDay(t,timeZone) && dueDay(t,timeZone) <= today);
    const dueToday=due.filter(t=>dueDay(t,timeZone)===today);
    if (due.length) notices.push({ id: `tasks:${today}`, type: 'task', priority: 50,
      label: dueToday.length ? `${dueToday.length} due today` : `${due.length} overdue ${due.length===1?'reminder':'reminders'}`, title: due[0].title,
      detail: dueToday.length ? 'Due today in Notion' : 'Review its due date in Notion',
      expiresAt: now + 60 * MINUTE, urgent: false });
  }
  const available = notices.filter(n => !(snoozed[n.id] > now) && n.expiresAt > now)
    .sort((a,b) => b.priority - a.priority || a.expiresAt - b.expiresAt);
  return { notices: available, next, current, timeZone,
    calendarReady: fresh(m.calendar, 'calendar', now) && Boolean(m.calendar?.data) && m.calendar.data.configured !== false,
    snoozedCount: notices.length - available.length };
}


// Forecast values are hourly instants. Interpolate only between adjacent,
// valid slots; never carry a midday maximum forward as evening exposure.
export function sunlightFor(entry, now, zone = 'America/Los_Angeles') {
  if (!fresh(entry, 'astro', now)) return [];
  const a = entry.data ?? {}, today = dateKey(now, zone);
  const hours = (a.uvHours ?? []).filter(h => Number.isFinite(h.uv) && h.uv >= 0 && Number.isFinite(instant(h.at)))
    .map(h => ({ ...h, at: instant(h.at) })).sort((a,b) => a.at-b.at);
  const previous = hours.findLast(h => h.at <= now), next = hours.find(h => h.at > now);
  let current = null;
  if (previous?.at === now) current = previous.uv;
  else if (previous && next && next.at-previous.at <= 60*MINUTE) {
    current = previous.uv + (next.uv-previous.uv)*(now-previous.at)/(next.at-previous.at);
  }
  const remaining = hours.filter(h => h.at > now && dateKey(h.at, zone) === today);
  if (current != null) remaining.push({ at: now, uv: current });
  const peak = remaining.reduce((best,h) => !best || h.uv > best.uv ? h : best, null);
  const out = [], number = v => (Math.round(v*10)/10).toFixed(1);
  if (peak?.uv > 2) out.push({
    kind: 'uv',
    title: current > 2 ? `UV ${number(current)} now` : `UV ${number(peak.uv)} later`,
    detail: current > 2 ? (peak.uv-current >= .2 ? `Peak ${number(peak.uv)} at ${timeLabel(peak.at,zone)}` : null) : `Peak at ${timeLabel(peak.at,zone)}`,
  });
  const sunset = instant(a.sunsetAt), minutes = Math.ceil((sunset-now)/MINUTE);
  if (Number.isFinite(sunset) && dateKey(sunset, zone) === today && minutes >= 0 && (minutes <= 120 || peak?.uv > 2)) {
    out.push({kind:'sunset', title:`Sunset ${timeLabel(sunset,zone)}`, detail:minutes<=120 ? minutes<=1?'Sunset now':`In ${minutes>=60?`${Math.floor(minutes/60)}h `:''}${minutes%60?`${minutes%60}m`:''}`.trim() : null});
  }
  return out;
}
