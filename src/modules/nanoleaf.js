import fs from 'node:fs/promises';
import { fetchJson } from '../http.js';

export const HA_DEFAULT_URL = 'http://100.97.0.104:8123';
export const ENTITY_IDS = Object.freeze(['light.shapes_a418', 'light.shapes_dedf']);

const DEFAULT_NAMES = Object.freeze({
  'light.shapes_a418': 'Shapes A',
  'light.shapes_dedf': 'Shapes B',
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function rgbColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const channels = value.slice(0, 3).map(Number);
  if (channels.some((channel) => !Number.isFinite(channel))) return null;
  return channels.map((channel) => Math.round(clamp(channel, 0, 255)));
}

function brightness(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(clamp(number, 0, 255)) : null;
}

/** Home Assistant state payload -> the small shape the mirror renders. */
export function normalizeNanoleafState(raw, entityId) {
  const state = String(raw?.state ?? '').toLowerCase();
  if (state !== 'on' && state !== 'off') {
    throw new Error(`invalid Home Assistant state for ${entityId}`);
  }

  const attributes = raw?.attributes ?? {};
  const name = String(attributes.friendly_name ?? '').trim() || DEFAULT_NAMES[entityId] || entityId;
  return {
    entityId,
    name,
    state,
    on: state === 'on',
    rgb: rgbColor(attributes.rgb_color),
    brightness: brightness(attributes.brightness),
  };
}

export function shapeNanoleaf(states, { entityIds = ENTITY_IDS } = {}) {
  if (!Array.isArray(states) || states.length !== entityIds.length) {
    throw new Error('Home Assistant returned an incomplete Nanoleaf state');
  }

  const byEntity = new Map(states.map((state) => [state?.entity_id, state]));
  const lights = entityIds.map((entityId) => normalizeNanoleafState(byEntity.get(entityId), entityId));
  return { lights };
}

async function readToken(tokenFile) {
  return (await fs.readFile(tokenFile, 'utf8')).trim();
}

function endpoint(baseUrl, entityId) {
  return `${String(baseUrl || HA_DEFAULT_URL).replace(/\/+$/, '')}/api/states/${encodeURIComponent(entityId)}`;
}

export const nanoleafModule = {
  name: 'nanoleaf',
  refreshMs: 15_000,
  staleAfterMs: 60_000,

  async fetch({ config, log }) {
    try {
      const token = await readToken(config.ha.tokenFile);
      if (!token) return null;

      const entityIds = config.nanoleaf?.entities ?? ENTITY_IDS;
      const states = await Promise.all(
        entityIds.map((entityId) =>
          fetchJson(endpoint(config.ha.url, entityId), {
            headers: { authorization: `Bearer ${token}` },
            timeoutMs: config.fetchTimeoutMs,
          }),
        ),
      );
      return shapeNanoleaf(states, { entityIds });
    } catch (err) {
      // This is deliberately invisible to the viewer: a missing HA network or
      // token makes the module disappear instead of becoming an alarm card.
      log?.warn?.(`home assistant unavailable: ${err?.message ?? err}`);
      return null;
    }
  },

  mock() {
    return shapeNanoleaf([
      {
        entity_id: 'light.shapes_a418',
        state: 'on',
        attributes: { friendly_name: 'Shapes A', rgb_color: [40, 180, 220], brightness: 128 },
      },
      {
        entity_id: 'light.shapes_dedf',
        state: 'off',
        attributes: { friendly_name: 'Shapes B', rgb_color: [180, 70, 230], brightness: 0 },
      },
    ]);
  },
};

export default nanoleafModule;
