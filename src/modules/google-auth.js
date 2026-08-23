import fsp from 'node:fs/promises';
import { fetchText } from '../http.js';

export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

async function readJson(file, label) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${label} (${file}): ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON (${file})`);
  }
}

/** Accepts both the "installed" (desktop) and "web" client secret shapes. */
export function extractClient(secret) {
  const block = secret?.installed ?? secret?.web ?? secret;
  const clientId = block?.client_id;
  const clientSecret = block?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('client secret file has no installed.client_id / installed.client_secret');
  }
  return { clientId, clientSecret };
}

export function extractRefreshToken(token) {
  const refreshToken = token?.refresh_token ?? token?.refreshToken;
  if (!refreshToken) throw new Error('token file has no refresh_token');
  return refreshToken;
}

/**
 * Refresh-token OAuth against the raw token endpoint (no googleapis SDK).
 * The access token is cached in memory only — the refresh token on disk is the
 * durable credential, so a restart costs one extra round trip and nothing else.
 */
export class GoogleAuth {
  #clientSecretFile;
  #tokenFile;
  #timeoutMs;
  #accessToken = null;
  #expiresAt = 0;
  #inflight = null;

  constructor({ clientSecretFile, tokenFile, timeoutMs = 10_000 }) {
    this.#clientSecretFile = clientSecretFile;
    this.#tokenFile = tokenFile;
    this.#timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.#clientSecretFile && this.#tokenFile);
  }

  async accessToken({ now = Date.now() } = {}) {
    if (this.#accessToken && now < this.#expiresAt) return this.#accessToken;
    if (this.#inflight) return this.#inflight;

    this.#inflight = (async () => {
      const [secret, token] = await Promise.all([
        readJson(this.#clientSecretFile, 'GOOGLE_CLIENT_SECRET_FILE'),
        readJson(this.#tokenFile, 'GOOGLE_TOKEN_FILE'),
      ]);
      const { clientId, clientSecret } = extractClient(secret);
      const refreshToken = extractRefreshToken(token);

      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });

      const raw = await fetchText(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        timeoutMs: this.#timeoutMs,
      });

      const parsed = JSON.parse(raw);
      if (!parsed.access_token) throw new Error('token endpoint returned no access_token');
      this.#accessToken = parsed.access_token;
      // 60s of slack so a token never expires mid-request.
      const lifetime = Number(parsed.expires_in) || 3600;
      this.#expiresAt = Date.now() + Math.max(30, lifetime - 60) * 1000;
      return this.#accessToken;
    })();

    try {
      return await this.#inflight;
    } finally {
      this.#inflight = null;
    }
  }

  invalidate() {
    this.#accessToken = null;
    this.#expiresAt = 0;
  }
}

export default GoogleAuth;
