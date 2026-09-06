import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const PROBE_COMMAND = 'python3';
export const PROBE_PATH = '/home/hermes/deckbridge/hermes_agents_probe.py';
export const PROBE_LIMIT = 10;
export const PROBE_TIMEOUT_MS = 8_000;
export const PROBE_MAX_BUFFER = 256 * 1024;
export const HEARTBEAT_MAX_AGE_S = 180;
export const MAX_FUTURE_SKEW_S = 30;
export const AGENTS_REFRESH_MS = 7_500;
export const AGENTS_STALE_AFTER_MS = 30_000;

const PROBE_ARGS = [PROBE_PATH, '--limit', String(PROBE_LIMIT)];
const WORKING_STATUSES = new Set(['working', 'running', 'busy', 'thinking', 'tool']);
const WAITING_STATUSES = new Set([
  'blocked', 'waiting', 'needs input', 'needs you', 'approval', 'permission',
]);

function cleanText(value, maxLength) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxLength).trim();
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochSeconds(now) {
  const date = now instanceof Date ? now : new Date(now);
  const value = date.getTime();
  if (!Number.isFinite(value)) throw new TypeError('agents module needs a valid clock');
  return value / 1000;
}

export function normalizeStatus(value) {
  const status = String(value ?? '').trim().toLowerCase().replace(/[-_]+/g, ' ');
  if (WAITING_STATUSES.has(status)) return 'waiting';
  if (WORKING_STATUSES.has(status)) return 'working';
  if (status === 'done' || status === 'complete' || status === 'completed' || status === 'finished') {
    return 'done';
  }
  return 'idle';
}

export function isWorkingHeartbeatLive(status, lastActivityAt, now = new Date()) {
  if (normalizeStatus(status) !== 'working') return false;
  const timestamp = asFiniteNumber(lastActivityAt);
  if (timestamp === null) return false;
  const age = epochSeconds(now) - timestamp;
  return age <= HEARTBEAT_MAX_AGE_S && age >= -MAX_FUTURE_SKEW_S;
}

export function normalizeAgent(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  const source = cleanText(raw.source, 40);
  const threadId = cleanText(raw.thread_id, 160);
  const sessionId = cleanText(raw.session_id, 160);
  const fallbackId = [source, threadId || sessionId].filter(Boolean).join(':');
  const id = cleanText(threadId || sessionId || fallbackId || raw.name || raw.title, 180);
  if (!id) return null;

  const status = normalizeStatus(raw.status);
  const name = cleanText(raw.name || raw.title || id, 48) || 'agent';
  const task = cleanText(raw.title || raw.name || id, 120) || name;
  const lastActivityAt = asFiniteNumber(raw.last_activity_at);

  return {
    id,
    name,
    task,
    status,
    live: isWorkingHeartbeatLive(status, lastActivityAt, now),
    lastActivityAt,
    source,
    url: cleanText(raw.url, 500),
  };
}

export function parseProbeOutput(stdout, now = new Date()) {
  let document;
  try {
    document = JSON.parse(String(stdout ?? ''));
  } catch (error) {
    throw new Error(`Hermes agents probe returned invalid JSON: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.agents)) {
    throw new Error('Hermes agents probe JSON must contain an agents array');
  }
  return document.agents.map((raw) => normalizeAgent(raw, now)).filter(Boolean);
}

export async function fetchAgents({
  now = new Date(),
  execImpl = execFile,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBuffer = PROBE_MAX_BUFFER,
} = {}) {
  const result = await execImpl(PROBE_COMMAND, PROBE_ARGS, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
  });
  return {
    connected: true,
    items: parseProbeOutput(result?.stdout, now),
  };
}

export const agentsModule = {
  name: 'agents',
  refreshMs: AGENTS_REFRESH_MS,
  staleAfterMs: AGENTS_STALE_AFTER_MS,

  async fetch({ now }) {
    // Let probe and parse failures escape so Store keeps the last-good snapshot
    // and ages it into stale instead of presenting a false connected state.
    return fetchAgents({ now });
  },
};

export default agentsModule;
