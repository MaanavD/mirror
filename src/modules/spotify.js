const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PLAYER_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const PLAYING_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 30_000;
const TOKEN_SKEW_MS = 60_000;

export const SPOTIFY_TOKEN_URL = TOKEN_URL;
export const SPOTIFY_PLAYER_URL = PLAYER_URL;
export const SPOTIFY_PLAYING_REFRESH_MS = PLAYING_REFRESH_MS;
export const SPOTIFY_IDLE_REFRESH_MS = IDLE_REFRESH_MS;

const isObject = (value) => value !== null && typeof value === 'object';
const finiteMs = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

export function isSpotifyConfigured(config) {
  return Boolean(config?.spotify?.clientId && config?.spotify?.clientSecret && config?.spotify?.refreshToken);
}

export function largestAlbumArt(images) {
  if (!Array.isArray(images)) return null;
  return (
    images
      .filter((image) => image?.url)
      .slice()
      .sort((a, b) => (Number(b.width ?? 0) * Number(b.height ?? 0)) - (Number(a.width ?? 0) * Number(a.height ?? 0)))[0]
      ?.url ?? null
  );
}

/** Converts Spotify's player response into the deliberately small mirror payload. */
export function shapeCurrentlyPlaying(raw, { configured = true } = {}) {
  const item = isObject(raw?.item) ? raw.item : null;
  if (!item) {
    return { configured, isPlaying: false, track: null, progressMs: 0, durationMs: 0 };
  }

  const artists = Array.isArray(item.artists)
    ? item.artists.map((artist) => String(artist?.name ?? '').trim()).filter(Boolean)
    : [];
  const track = {
    name: String(item.name ?? '').trim() || 'untitled',
    artists,
    albumArtUrl: largestAlbumArt(item.album?.images),
  };

  return {
    configured,
    isPlaying: Boolean(raw?.is_playing),
    track,
    progressMs: finiteMs(raw?.progress_ms),
    durationMs: finiteMs(item.duration_ms),
  };
}

function responseBody(response) {
  if (response.status === 204) return Promise.resolve(null);
  if (typeof response.json === 'function') return response.json();
  return response.text().then((text) => (text ? JSON.parse(text) : null));
}

function responseError(status, url, body) {
  const error = new Error(`Spotify HTTP ${status} ${url}${body ? ` — ${String(body).slice(0, 160)}` : ''}`);
  error.status = status;
  return error;
}

/** Small injectable client so token and player flows can be tested without credentials. */
export class SpotifyClient {
  #clientId;
  #clientSecret;
  #refreshToken;
  #fetch;
  #timeoutMs;
  #token = null;
  #tokenExpiresAt = 0;

  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#refreshToken = refreshToken;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    if (typeof this.#fetch !== 'function') throw new TypeError('SpotifyClient requires fetch');
  }

  invalidate() {
    this.#token = null;
    this.#tokenExpiresAt = 0;
  }

  async #request(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
      let payload = null;
      try {
        payload = await responseBody(response);
      } catch {
        payload = null;
      }
      if (!response.ok) throw responseError(response.status, url, payload?.error_description ?? payload?.error ?? '');
      return { response, payload };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Spotify request timed out after ${this.#timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExpiresAt - TOKEN_SKEW_MS) return this.#token;
    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.#refreshToken });
    const { payload } = await this.#request(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!payload?.access_token) throw new Error('Spotify token response missing access_token');
    this.#token = payload.access_token;
    this.#tokenExpiresAt = Date.now() + Math.max(1, Number(payload.expires_in) || 3_600) * 1_000;
    return this.#token;
  }

  async currentlyPlaying() {
    let token = await this.#accessToken();
    try {
      const result = await this.#request(PLAYER_URL, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      });
      return result.payload;
    } catch (error) {
      if (error?.status !== 401) throw error;
      this.invalidate();
      token = await this.#accessToken();
      const result = await this.#request(PLAYER_URL, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      });
      return result.payload;
    }
  }
}

let client = null;
let clientKey = '';

function clientFor(config) {
  const spotify = config.spotify;
  const key = `${spotify.clientId}\u0000${spotify.clientSecret}\u0000${spotify.refreshToken}`;
  if (!client || key !== clientKey) {
    clientKey = key;
    client = new SpotifyClient({
      clientId: spotify.clientId,
      clientSecret: spotify.clientSecret,
      refreshToken: spotify.refreshToken,
      timeoutMs: config.fetchTimeoutMs,
    });
  }
  return client;
}

const MOCK_ART = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" fill="%23005098"/%3E%3Cpath d="M0 78 100 18M-20 56 80-4M20 104 120 44" stroke="%2310f8f8" stroke-width="8" opacity=".8"/%3E%3Ccircle cx="50" cy="50" r="22" fill="%23000" stroke="%23d8f8ff" stroke-width="3"/%3E%3C/svg%3E';

export const spotifyModule = {
  name: 'spotify',
  staleAfterMs: 2 * 60_000,

  refreshMsFor({ data }) {
    return data?.isPlaying ? PLAYING_REFRESH_MS : IDLE_REFRESH_MS;
  },

  async fetch({ config }) {
    if (!isSpotifyConfigured(config)) {
      return { configured: false, isPlaying: false, track: null, progressMs: 0, durationMs: 0 };
    }
    const raw = await clientFor(config).currentlyPlaying();
    return shapeCurrentlyPlaying(raw, { configured: true });
  },

  mock() {
    return {
      configured: true,
      isPlaying: true,
      track: { name: 'Mega Man.EXE // Transmission', artists: ['Hermy'], albumArtUrl: MOCK_ART },
      progressMs: 76_000,
      durationMs: 214_000,
    };
  },
};

export default spotifyModule;
