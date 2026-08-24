/*
  Motion mode machine.

  The mirror runs at one of three motion levels:

    · calm   — the default. Every ambient animation keeps running but at ~40%
               intensity and on slow cycles (see the token block in styles.css).
    · active — 90 seconds of full-intensity animation after something actually
               happened: a `say` push, a Spotify track change, or a presence
               ping (POST /api/presence).
    · night  — 22:30 → 05:00. Overrides both, and the wind-down look itself is
               unchanged: the body still carries `night` and dims as before.

  Pure logic, no DOM. The clock, the hold window and the night predicate are all
  injected so the machine is exercised directly by node --test (test/mode.test.js)
  instead of only through a browser.
*/

export const CALM = 'calm';
export const ACTIVE = 'active';
export const NIGHT = 'night';

/** How long an `active` burst lasts, per the redesign brief. */
export const ACTIVE_HOLD_MS = 90_000;

/** Wind-down window, as fractional local hours: 22:30 until 05:00. */
export const NIGHT_FROM_HOUR = 22.5;
export const NIGHT_TO_HOUR = 5;

/** The wind-down boundaries the mirror has always used, now testable. */
export function isNightAt(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_TO_HOUR;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] epoch-ms clock (injected in tests)
 * @param {number} [options.holdMs] length of an `active` burst
 * @param {boolean} [options.reducedMotion] prefers-reduced-motion: never escalate
 * @param {(date: Date) => boolean} [options.isNight] night predicate
 * @param {(change: {mode: string, previous: string|null, reason: string|null}) => void} [options.onChange]
 */
export function createModeMachine({
  now = () => Date.now(),
  holdMs = ACTIVE_HOLD_MS,
  reducedMotion = false,
  isNight = isNightAt,
  onChange = null,
} = {}) {
  let activeUntil = 0;
  let lastReason = null;
  let announced = null;

  // Night wins outright; an expired burst falls back to calm on its own, so
  // there is no timer to cancel anywhere.
  const compute = () => {
    const t = now();
    if (isNight(new Date(t))) return NIGHT;
    if (!reducedMotion && t < activeUntil) return ACTIVE;
    return CALM;
  };

  const settle = (reason) => {
    const mode = compute();
    if (mode === announced) return mode;
    const previous = announced;
    announced = mode;
    if (onChange) onChange({ mode, previous, reason: reason ?? lastReason });
    return mode;
  };

  return {
    get mode() {
      return compute();
    },

    /** Announced mode, i.e. what the last onChange call reported. */
    get announced() {
      return announced;
    },

    get activeUntil() {
      return activeUntil;
    },

    get lastReason() {
      return lastReason;
    },

    get reducedMotion() {
      return reducedMotion;
    },

    /** Something happened: hold `active` for holdMs from now (re-triggers extend). */
    trigger(reason = null) {
      lastReason = reason;
      activeUntil = now() + holdMs;
      return settle(reason);
    },

    /** Cheap re-evaluation; call it on a timer. Fires onChange only on a change. */
    tick() {
      return settle(null);
    },

    /** Force an onChange for the current mode — used for the first paint. */
    sync(reason = 'init') {
      announced = null;
      return settle(reason);
    },
  };
}

export default createModeMachine;
