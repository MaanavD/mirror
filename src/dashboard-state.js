// The server's progress ledger needs full task history; the browser does not.
// Preserve the full /api/state contract for other clients and project only the
// dashboard requests, without modifying Store or its persisted records.
const TASK_FIELDS = ['id', 'title', 'url', 'status', 'done', 'due', 'priority', 'area', 'effortMinutes'];
const BOARD_FIELDS = ['configured', 'available', 'availability', 'coverage', 'truncated', 'total', 'more'];
const pick = (object, fields) => Object.fromEntries(fields.filter(key => key in object).map(key => [key, object[key]]));

export function dashboardState(snapshot) {
  const modules = { ...snapshot.modules };
  for (const name of ['notion', 'workboard']) {
    const entry = modules[name];
    if (!entry?.data) continue;
    modules[name] = { ...entry, data: {
      ...pick(entry.data, BOARD_FIELDS),
      items: (entry.data.items ?? [])
        .filter(item => !item.done && !/^(done|completed|trashed|archived)$/i.test(String(item.status ?? '').trim()))
        .map(item => pick(item, TASK_FIELDS)),
    } };
  }
  return { ...snapshot, modules };
}
