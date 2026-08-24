/**
 * Hermy.EXE reactions (F21 + F42).
 *
 * Reads the rest of the mirror's state (weather / calendar / countdown) and
 * reacts like a Battle Network navi: a short BN-tone line for each thing worth
 * commenting on, and a "battle stance" + enemy nameplate when the weather turns
 * hostile. All output is pure here so the frontend is just a renderer and the
 * logic is trivially testable.
 */

const FAHRENHEIT = (c) => (Number(c) * 9) / 5 + 32;

// Keep every line at or under 34 characters (BN navi bark budget).
const LINES = {
  rain: 'RAIN INBOUND. GRAB THE UMBRELLA.',
  heat: 'HEATWAVE! HYDRATE, HUMAN.',
  storm: 'THUNDER! SEEK SHELTER.',
  flight: 'FLIGHT SOON. PACK THE BAG.',
  readiness: 'RUNNING LOW. REST UP.',
};

export function classifyWeather(weather) {
  const reactions = [];
  let enemy = null;

  if (weather?.rain?.rainAtISO) reactions.push(LINES.rain);

  const temp = weather?.current?.temp;
  const code = weather?.current?.code;
  if (Number.isFinite(temp) && FAHRENHEIT(temp) >= 90) {
    reactions.push(LINES.heat);
    enemy = enemy ?? 'HEATWAVE.EXE';
  }
  if (Number.isFinite(code) && code >= 95) {
    reactions.push(LINES.storm);
    enemy = 'STORMY.EXE';
  }
  return { reactions, enemy };
}

/**
 * Reacts to the aggregate mirror state.
 * Returns { lines, enemy, battle } — `enemy` is the nameplate to fight, or null;
 * `battle` is true whenever there is an enemy.
 */
export function shapeHermy(
  { weather, calendar, countdown, readiness } = {},
  { readinessThreshold = 40 } = {},
) {
  const { reactions, enemy } = classifyWeather(weather);

  const flight = countdown?.items?.find((i) => i.kind === 'flight');
  if (flight && flight.days <= 1) reactions.push(LINES.flight);

  if (readiness != null && Number.isFinite(readiness) && readiness < readinessThreshold) {
    reactions.push(LINES.readiness);
  }

  return {
    lines: reactions,
    enemy,
    battle: enemy !== null,
  };
}

function mockWeather() {
  return {
    current: { temp: 12, code: 95 },
    rain: { rainAtISO: new Date(0).toISOString() },
  };
}

export const hermyModule = {
  name: 'hermy',
  refreshMs: 2 * 60_000,
  staleAfterMs: 10 * 60_000,

  async fetch({ config, now, getModule }) {
    const weather = getModule?.('weather')?.data ?? null;
    const calendar = getModule?.('calendar')?.data ?? null;
    const countdown = getModule?.('countdown')?.data ?? null;
    return shapeHermy({ weather, calendar, countdown }, { now });
  },

  mock({ config, now, getModule }) {
    const weather = getModule?.('weather')?.data ?? mockWeather();
    const countdown = getModule?.('countdown')?.data ?? null;
    return shapeHermy({ weather, calendar: null, countdown }, { now });
  },
};

export default hermyModule;
