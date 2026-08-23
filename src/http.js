// Global fetch only (no axios), always with a hard timeout so a hung upstream
// can never wedge a refresh cycle.

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class TimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`timeout after ${timeoutMs}ms: ${url}`);
    this.name = 'TimeoutError';
  }
}

export async function fetchText(url, { timeoutMs = 10_000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    const body = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, body);
    return body;
  } catch (err) {
    if (err?.name === 'AbortError') throw new TimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}) {
  const body = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`invalid JSON from ${url}: ${body.slice(0, 120)}`);
  }
}
