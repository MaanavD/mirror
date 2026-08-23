import { fetchJson } from '../http.js';

export const OPEN_METEO_AQI = 'https://air-quality-api.open-meteo.com/v1/air-quality';

export function buildUrl({ lat, lon }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'us_aqi,pm2_5',
  });
  return `${OPEN_METEO_AQI}?${params}`;
}

const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

/**
 * Open-Meteo air-quality payload → mirror shape.
 * Returns null when the payload is unusable (API down, malformed, etc.)
 * so the UI hides the module instead of showing an error.
 */
export function shapeAqi(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const aqi = round(raw?.current?.us_aqi);
  if (aqi === null) return null;

  const pm25 = round(raw?.current?.pm2_5);

  let level = 'good';
  if (aqi >= 151) level = 'very-unhealthy';
  else if (aqi >= 101) level = 'unhealthy';
  else if (aqi >= 60) level = 'moderate';

  return { aqi, pm25, level };
}

/** A believable AQI payload for a Seattle day. */
export function mockRaw() {
  return {
    current: {
      us_aqi: 42,
      pm2_5: 8.3,
    },
  };
}

export const aqiModule = {
  name: 'aqi',
  refreshMs: 30 * 60_000,
  staleAfterMs: 60 * 60_000,

  async fetch({ config }) {
    const raw = await fetchJson(buildUrl(config), { timeoutMs: config.fetchTimeoutMs });
    return shapeAqi(raw);
  },

  mock() {
    return shapeAqi(mockRaw());
  },
};

export default aqiModule;
