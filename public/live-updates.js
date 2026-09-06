// Compare with the release embedded in the loaded HTML, not the first poll:
// a deployment may happen between loading the page and making that request.
export function createReleaseCheck({ version, fetchVersion, reload }) {
  let busy = false, reloading = false, candidate = null;
  return async function check() {
    if (!version || busy || reloading) return;
    busy = true;
    try {
      const next = await fetchVersion();
      if (typeof next !== 'string' || !/^[a-f0-9]{64}$/.test(next)) {
        candidate = null;
      } else if (next === version) {
        candidate = null;
      } else if (next === candidate) {
        reloading = true;
        reload();
      } else {
        candidate = next;
      }
    } catch {
      // Keep the rendered dashboard through outages; retry on the next tick.
      candidate = null;
    } finally { busy = false; }
  };
}

export function startLiveUpdates() {
  const check = createReleaseCheck({
    version: document.querySelector('meta[name="mirror-release"]')?.content,
    fetchVersion: async () => {
      const response = await fetch('/api/frontend-version', {
        cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Release unavailable');
      return (await response.json()).version;
    },
    reload: () => location.reload(),
  });
  check();
  // Two matching checks, 30 seconds apart, allow a file deployment to settle.
  setInterval(check, 30000);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}
