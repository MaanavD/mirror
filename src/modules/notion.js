/**
 * Notion todos — STUB, by necessity.
 *
 * The database (NOTION_DATABASE_ID) has not been shared with the integration
 * yet, so this module cannot read anything real. See SETUP_TODO.md.
 *
 * Everything except the live credentials is already here: schema introspection,
 * property detection, the incomplete-only query, grouping by area and the
 * 8-visible cap. When the DB is shared, set NOTION_TOKEN and the real path
 * takes over with no code change — `notReady()` results simply stop happening.
 */
import { fetchJson } from '../http.js';

export const NOTION_API = 'https://api.notion.com/v1';
export const VISIBLE_CAP = 8;
export const VIRUS_CAP = 4;

const VIRUS_VARIANTS = 3;

/** Stable per-id variant so a task keeps its sprite across refreshes. */
export function variantFor(id) {
  let h = 2166136261;
  const s = String(id ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % VIRUS_VARIANTS;
}

/**
 * Open Notion tasks -> Mettaur-class virus list (F41). Flat (no area grouping),
 * capped at VIRUS_CAP visible with the remainder reported as `more`.
 */
export function toViruses(todos, { cap = VIRUS_CAP } = {}) {
  const all = (todos ?? []).map((t) => ({ id: t.id, name: t.title, variant: variantFor(t.id) }));
  const shown = all.slice(0, cap);
  return { viruses: shown, total: all.length, more: Math.max(0, all.length - shown.length) };
}

const AREA_NAME = /area|categor|bucket|domain|life|pillar/i;
const DONE_NAME = /done|complete|finish|shipped/i;
const COMPLETE_STATUS = /^(done|complete|completed|shipped|archived)$/i;
const GROUPING_TYPES = new Set(['select', 'status', 'multi_select']);

function headers(config) {
  return {
    authorization: `Bearer ${config.notion.token}`,
    'Notion-Version': config.notion.version,
    'content-type': 'application/json',
  };
}

/**
 * Works out which properties to use without hard-coding this particular DB's
 * column names: a title, something select-ish to group by, something to mean
 * "done".
 */
export function pickProperties(schema) {
  const props = schema?.properties ?? {};
  const entries = Object.entries(props);

  const title = entries.find(([, p]) => p?.type === 'title')?.[0] ?? 'Name';

  const checkbox = entries.find(([name, p]) => p?.type === 'checkbox' && DONE_NAME.test(name));
  const status = entries.find(([, p]) => p?.type === 'status');
  const done = checkbox
    ? { name: checkbox[0], type: 'checkbox' }
    : status
      ? { name: status[0], type: 'status' }
      : null;

  const grouping = entries.filter(([name, p]) => GROUPING_TYPES.has(p?.type) && name !== done?.name);
  const area = grouping.find(([name]) => AREA_NAME.test(name)) ?? grouping[0] ?? null;

  return {
    title,
    area: area ? area[0] : null,
    areaType: area ? props[area[0]].type : null,
    done,
  };
}

/** Server-side "incomplete only" filter for the chosen done property. */
export function buildFilter(props) {
  if (!props?.done) return undefined;
  if (props.done.type === 'checkbox') {
    return { property: props.done.name, checkbox: { equals: false } };
  }
  return { property: props.done.name, status: { does_not_equal: 'Done' } };
}

function plainText(richText) {
  return (richText ?? []).map((t) => t?.plain_text ?? '').join('').trim();
}

function areaOf(page, props) {
  if (!props.area) return 'other';
  const value = page?.properties?.[props.area];
  const name =
    value?.select?.name ??
    value?.status?.name ??
    value?.multi_select?.[0]?.name ??
    null;
  return name?.trim() || 'other';
}

function isDone(page, props) {
  if (!props.done) return false;
  const value = page?.properties?.[props.done.name];
  if (props.done.type === 'checkbox') return Boolean(value?.checkbox);
  return COMPLETE_STATUS.test(value?.status?.name ?? '');
}

/** Notion pages -> incomplete todos, in query order. */
export function toTodos(pages, props) {
  const out = [];
  for (const page of pages ?? []) {
    if (page?.archived || page?.in_trash) continue;
    if (isDone(page, props)) continue;
    const title = plainText(page?.properties?.[props.title]?.title);
    if (!title) continue;
    out.push({ id: page.id, title, area: areaOf(page, props) });
  }
  return out;
}

/**
 * Groups by area, preserving first-seen order, and stops at `cap` visible
 * items. Everything past the cap becomes a single "+N more".
 */
export function groupTodos(todos, { cap = VISIBLE_CAP } = {}) {
  const order = [];
  const byArea = new Map();
  let visible = 0;

  for (const todo of todos ?? []) {
    if (visible >= cap) break;
    if (!byArea.has(todo.area)) {
      byArea.set(todo.area, []);
      order.push(todo.area);
    }
    byArea.get(todo.area).push({ id: todo.id, title: todo.title });
    visible += 1;
  }

  const total = todos?.length ?? 0;
  return {
    groups: order.map((area) => ({ area, items: byArea.get(area) })),
    visible,
    total,
    more: Math.max(0, total - visible),
  };
}

function notReady(reason) {
  return {
    configured: false,
    stub: true,
    reason,
    groups: [],
    visible: 0,
    total: 0,
    more: 0,
    viruses: [],
    virusTotal: 0,
    virusMore: 0,
  };
}

let schemaCache = null;

/** Introspected once per process, at first refresh (i.e. at startup). */
export async function introspectSchema(config, { force = false } = {}) {
  if (schemaCache && !force) return schemaCache;
  const schema = await fetchJson(`${NOTION_API}/databases/${config.notion.databaseId}`, {
    headers: headers(config),
    timeoutMs: config.fetchTimeoutMs,
  });
  schemaCache = { raw: schema, props: pickProperties(schema), title: plainText(schema?.title) };
  return schemaCache;
}

export function mockTodos() {
  return groupTodos([
    { id: 'n1', area: 'Career / BFL', title: 'ship mirror v1 to the hallway panel' },
    { id: 'n2', area: 'Career / BFL', title: 'flux 2 eval writeup — first pass' },
    { id: 'n3', area: 'Career / BFL', title: 'review nyx inference PR' },
    { id: 'n4', area: 'Health / sleep', title: 'lights out by 23:30 all week' },
    { id: 'n5', area: 'Health / sleep', title: 'book physio follow-up' },
    { id: 'n6', area: 'SF / life', title: 'renew ID before the sf trip' },
    { id: 'n7', area: 'SF / life', title: 'sublet paperwork — sign + send' },
  ]);
}

export const notionModule = {
  name: 'notion',
  refreshMs: 5 * 60_000,
  staleAfterMs: 20 * 60_000,

  async fetch({ config, log }) {
    if (!config.notion.token) return notReady('NOTION_TOKEN not set');
    if (!config.notion.databaseId) return notReady('NOTION_DATABASE_ID not set');

    let schema;
    try {
      schema = await introspectSchema(config);
    } catch (err) {
      // 404 = not shared with the integration; 403 = shared without read
      // capability. Both are setup states, not outages, so don't thrash.
      if (err?.status === 404 || err?.status === 403) {
        log.warn(`notion db not accessible (HTTP ${err.status}) — share it with the integration; see SETUP_TODO.md`);
        return notReady(`database not shared with integration (HTTP ${err.status})`);
      }
      throw err;
    }

    const filter = buildFilter(schema.props);
    const payload = await fetchJson(`${NOTION_API}/databases/${config.notion.databaseId}/query`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ page_size: 100, ...(filter ? { filter } : {}) }),
      timeoutMs: config.fetchTimeoutMs,
    });

    const todos = toTodos(payload?.results, schema.props);
    const grouped = groupTodos(todos);
    const vir = toViruses(todos);
    return {
      configured: true,
      stub: false,
      database: schema.title,
      ...grouped,
      viruses: vir.viruses,
      virusTotal: vir.total,
      virusMore: vir.more,
    };
  },

  mock() {
    const grouped = mockTodos();
    const todos = grouped.groups.flatMap((g) => g.items.map((i) => ({ id: i.id, title: i.title })));
    const vir = toViruses(todos);
    return {
      configured: true,
      stub: true,
      database: 'todos (mock)',
      ...grouped,
      viruses: vir.viruses,
      virusTotal: vir.total,
      virusMore: vir.more,
    };
  },
};

export default notionModule;
