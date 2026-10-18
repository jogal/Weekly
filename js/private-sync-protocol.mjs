// Private support feed, not a backup. Construct every field individually; never spread source records.
import { addDays, DAY_KEYS, mondayOf } from './habit-core.mjs';
import { deriveStatistics, readingDailyTotals } from './private-sync-stats.mjs';

export const MAX_PAYLOAD_BYTES = 1024 * 1024;
const LEGACY_MAX_PAYLOAD_BYTES = 128 * 1024;
export const MAX_ITEMS = 100;
export const MAX_ENTRIES = 1500;
const SOURCE_KEYS = Object.freeze({ habits: 'wt_habits_v1', records: 'wt_records', log: 'wt_habit_log_v1', reading: 'wt_reading_v1', todo: 'wt_todo_v1' });
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const own = (o, k) => Object.hasOwn(o, k);
const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
function fail(code = 'INVALID_PAYLOAD') { const e = new Error(code); e.code = code; throw e; }
function object(o, keys) {
  if (!plain(o) || Object.keys(o).length !== keys.length || keys.some(k => !own(o, k)) || Object.keys(o).some(k => !keys.includes(k))) fail();
}
function text(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail(); return value; }
function integer(n, max = 1000000) { if (!Number.isSafeInteger(n) || n < 0 || n > max) fail(); return n; }
function bool(b) { if (typeof b !== 'boolean') fail(); return b; }
export function validDate(d) {
  return typeof d === 'string' && /^(19|20|21)\d\d-\d\d-\d\d$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
}
function date(d, nullable = false) { if (nullable && d === null) return null; if (!validDate(d)) fail(); return d; }
function array(a, max) { if (!Array.isArray(a) || a.length > max) fail(); return a; }
function unique(a, key) { if (new Set(a.map(key)).size !== a.length) fail(); }
function entries(a, parser) {
  const result = array(a, MAX_ENTRIES).map(parser);
  unique(result, x => x.date);
  if (result.some((x, i) => i > 0 && result[i - 1].date >= x.date)) fail();
  return result;
}
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function sizeBound(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PAYLOAD_BYTES) fail('PAYLOAD_TOO_LARGE');
  return value;
}
function zone(value) {
  text(value, 100);
  if (!/^[A-Za-z0-9_+/-]+$/.test(value)) fail();
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0)); } catch { fail(); }
  return value;
}
function sameShape(actual, expected) {
  if (Array.isArray(expected)) {
    array(actual, expected.length);
    if (actual.length !== expected.length) fail();
    actual.forEach((v, i) => sameShape(v, expected[i]));
  } else if (plain(expected)) {
    object(actual, Object.keys(expected));
    for (const key of Object.keys(expected)) sameShape(actual[key], expected[key]);
  } else if (actual !== expected) fail();
}
function frequency(f) {
  object(f, ['type', 'days', 'times']);
  if (!['daily', 'days', 'weekly'].includes(f.type)) fail();
  const days = array(f.days, 7).map(d => integer(d, 6));
  unique(days, d => d);
  if (days.some((d, i) => i > 0 && days[i - 1] >= d) || (f.type === 'days' ? !days.length : days.length)) fail();
  const times = integer(f.times, 7);
  if (times < 1 || (f.type !== 'weekly' && times !== 1)) fail();
  return { type: f.type, days, times };
}
function parseHabits(value) {
  return array(value, MAX_ITEMS).map(h => {
    object(h, ['id', 'name', 'unit', 'target', 'frequency', 'startsOn', 'entries']);
    if (!['check', 'count', 'minutes'].includes(h.unit)) fail();
    const target = integer(h.target, 999);
    if (!target || (h.unit === 'check' && target !== 1)) fail();
    return { id: id(h.id), name: text(h.name, 40), unit: h.unit, target, frequency: frequency(h.frequency), startsOn: date(h.startsOn, true),
      entries: entries(h.entries, e => {
        object(e, ['date', 'value', 'completed', 'rest']);
        // Switching a custom count/minutes goal to check preserves its old numeric log.
        const value = integer(e.value), completed = bool(e.completed);
        if (completed !== (value >= target)) fail();
        return { date: date(e.date), value, completed, rest: bool(e.rest) };
      }) };
  });
}
function parseReading(value) {
  return array(value, MAX_ITEMS).map(b => {
    object(b, ['id', 'title', 'totalPages', 'currentPage', 'status', 'finishedOn', 'recordOnly', 'entries']);
    if (!['want', 'reading', 'done'].includes(b.status)) fail();
    const totalPages = integer(b.totalPages, 20000), currentPage = integer(b.currentPage, 20000);
    if (totalPages && currentPage > totalPages) fail();
    const log = entries(b.entries, e => { object(e, ['date', 'page']); return { date: date(e.date), page: integer(e.page, totalPages || 20000) }; });
    if (currentPage !== log.reduce((max, e) => Math.max(max, e.page), 0)) fail();
    const finishedOn = date(b.finishedOn, true), recordOnly = bool(b.recordOnly);
    if (b.status !== 'done' && (finishedOn !== null || recordOnly)) fail();
    return { id: id(b.id), title: text(b.title), totalPages, currentPage, status: b.status, finishedOn, recordOnly, entries: log };
  });
}
function parseTasks(value) {
  return array(value, MAX_ITEMS).map(t => {
    object(t, ['id', 'name', 'createdOn', 'due', 'completedOn', 'completedSteps', 'totalSteps', 'stepEntries']);
    const completedSteps = integer(t.completedSteps, 30), totalSteps = integer(t.totalSteps, 30);
    const stepEntries = entries(t.stepEntries, e => {
      object(e, ['date', 'completedSteps']);
      const count = integer(e.completedSteps, 30); if (!count) fail();
      return { date: date(e.date), completedSteps: count };
    });
    if (completedSteps > totalSteps || stepEntries.reduce((n, e) => n + e.completedSteps, 0) !== completedSteps) fail();
    return { id: id(t.id), name: text(t.name, 40), createdOn: date(t.createdOn, true), due: date(t.due, true), completedOn: date(t.completedOn, true), completedSteps, totalSteps, stepEntries };
  });
}
function parseRoutines(value) {
  return array(value, MAX_ITEMS).map(r => {
    object(r, ['id', 'name', 'mode', 'createdOn', 'entries']);
    if (!['do', 'avoid'].includes(r.mode)) fail();
    return { id: id(r.id), name: text(r.name, 40), mode: r.mode, createdOn: date(r.createdOn), entries: entries(r.entries, e => {
      object(e, ['date', 'occurred', 'completed']);
      const occurred = bool(e.occurred), completed = bool(e.completed);
      if (completed !== (r.mode === 'avoid' ? !occurred : occurred)) fail();
      return { date: date(e.date), occurred, completed };
    }) };
  });
}
export function validatePayload(value) {
  // Check aggregate size before potentially expensive date/statistics walks.
  sizeBound(value);
  object(value, ['schemaVersion', 'asOf', 'timeZone', 'habits', 'routines', 'reading', 'tasks', 'statistics']);
  if (value.schemaVersion !== 2) fail();
  const asOf = date(value.asOf), timeZone = zone(value.timeZone);
  // Leave enough calendar range for the explicitly published bounded windows.
  if (asOf < '1904-01-01') fail();
  const habits = parseHabits(value.habits), routines = parseRoutines(value.routines), reading = parseReading(value.reading), tasks = parseTasks(value.tasks);
  [habits, routines, reading, tasks].forEach(a => { unique(a, x => x.id); a.sort(byId); });
  if (!habits.length && !routines.length && !reading.length && !tasks.length) fail('EMPTY_PAYLOAD');
  const result = { schemaVersion: 2, asOf, timeZone, habits, routines, reading, tasks };
  result.statistics = deriveStatistics(result);
  // Do not trust client-supplied statistics or accept an arbitrary statistics object.
  sameShape(value.statistics, result.statistics);
  return sizeBound(result);
}
export function validateLegacyPayload(value) {
  object(value, ['schemaVersion', 'habits', 'reading', 'tasks']);
  if (value.schemaVersion !== 1) fail();
  // Reject unknown fields rather than removing them after arrival at the server.
  const habits = array(value.habits, MAX_ITEMS).map(h => {
    object(h, ['id', 'name', 'unit', 'entries']);
    if (!['check', 'count', 'minutes'].includes(h.unit)) fail();
    return { id: id(h.id), name: text(h.name, 40), unit: h.unit, entries: entries(h.entries, e => {
      object(e, ['date', 'value', 'completed']);
      const v = integer(e.value, h.unit === 'check' ? 1 : 1000000);
      return { date: date(e.date), value: v, completed: bool(e.completed) };
    }) };
  });
  const reading = array(value.reading, MAX_ITEMS).map(b => {
    object(b, ['id', 'title', 'totalPages', 'currentPage', 'status', 'finishedOn', 'entries']);
    if (!['want', 'reading', 'done'].includes(b.status)) fail();
    const totalPages = integer(b.totalPages, 20000), currentPage = integer(b.currentPage, 20000);
    if (totalPages && currentPage > totalPages) fail();
    const log = entries(b.entries, e => { object(e, ['date', 'page']); return { date: date(e.date), page: integer(e.page, totalPages || 20000) }; });
    if (log.some(e => e.page > currentPage)) fail();
    const finishedOn = date(b.finishedOn, true);
    if (b.status !== 'done' && finishedOn !== null) fail();
    return { id: id(b.id), title: text(b.title), totalPages, currentPage, status: b.status, finishedOn, entries: log };
  });
  const tasks = array(value.tasks, MAX_ITEMS).map(t => {
    object(t, ['id', 'name', 'due', 'completedOn', 'completedSteps', 'totalSteps']);
    const completedSteps = integer(t.completedSteps, 30), totalSteps = integer(t.totalSteps, 30);
    if (completedSteps > totalSteps) fail();
    return { id: id(t.id), name: text(t.name, 40), due: date(t.due, true), completedOn: date(t.completedOn, true), completedSteps, totalSteps };
  });
  [habits, reading, tasks].forEach(a => unique(a, x => x.id));
  if (!tasks.length && !habits.some(h => h.entries.some(e => e.value > 0 || e.completed)) && !reading.some(b => b.currentPage > 0 || b.status === 'done')) fail('EMPTY_PAYLOAD');
  const result = { schemaVersion: 1, habits, reading, tasks };
  if (new TextEncoder().encode(JSON.stringify(result)).length > LEGACY_MAX_PAYLOAD_BYTES) fail('PAYLOAD_TOO_LARGE');
  return result;
}

function source(storage, name) {
  const raw = storage.getItem(SOURCE_KEYS[name]);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) fail('SOURCE_INVALID');
  let data; try { data = JSON.parse(raw); } catch { fail('SOURCE_INVALID'); }
  if (!plain(data)) fail('SOURCE_INVALID');
  return data;
}
function collection(data, key) {
  if (data === null || !own(data, key)) return [];
  if (!Array.isArray(data[key])) fail('SOURCE_INVALID');
  return data[key];
}
function active(items) {
  const out = items.filter(item => {
    if (!plain(item)) fail('SOURCE_INVALID');
    return !item.archived && !item.archivedOn && !item.deleted && !item.deletedOn;
  });
  array(out, MAX_ITEMS); unique(out, x => x.id);
  return out.sort(byId);
}
function sourceObject(value, optional = false) {
  if (optional && (value === undefined || value === null)) return {};
  if (!plain(value)) fail('SOURCE_INVALID');
  return value;
}
function sourceBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value !== true && value !== false && value !== 0 && value !== 1) fail('SOURCE_INVALID');
  return !!value;
}
function sourceDate(value, nullable = true) { return date(value === undefined ? null : value, nullable); }
function dateOptions({ asOf, timeZone } = {}) {
  const resolvedZone = zone(timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  if (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { asOf: date(asOf), timeZone: resolvedZone };
  if (asOf !== undefined && !(asOf instanceof Date) &&
    (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(asOf))) fail();
  if (typeof asOf === 'string' && !validDate(asOf.slice(0, 10))) fail();
  const time = asOf instanceof Date ? asOf : asOf === undefined ? new Date() : new Date(asOf);
  if (!Number.isFinite(time.getTime())) fail();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: resolvedZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
  const get = type => parts.find(p => p.type === type).value;
  return { asOf: date(`${get('year')}-${get('month')}-${get('day')}`), timeZone: resolvedZone };
}
export function buildPayload(storage, options = {}) {
  if (!plain(options) || Object.keys(options).some(k => !['asOf', 'timeZone'].includes(k))) fail();
  const { asOf, timeZone } = dateOptions(options);
  // Only these approved stores are ever read; absent optional categories/logs are empty.
  // Never synthesize default items on an uninitialized device or enumerate storage keys.
  const habitSource = source(storage, 'habits'), readingSource = source(storage, 'reading'), todoSource = source(storage, 'todo');
  if (habitSource === null && readingSource === null && todoSource === null) fail('SOURCE_UNINITIALIZED');
  const rawHabits = active(collection(habitSource, 'habits'));
  const rawBooks = active(collection(readingSource, 'books'));
  const rawTasks = active(collection(todoSource, 'tasks'));
  const rawRoutines = active(collection(todoSource, 'routines'));
  const reading = rawBooks.map(b => {
    const log = sourceObject(b.log, true);
    const bookEntries = Object.entries(log).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([day, e]) => {
      sourceObject(e); return { date: date(day), page: integer(e.page, 20000) };
    });
    return { id: b.id, title: b.title, totalPages: b.pages, currentPage: bookEntries.reduce((max, e) => Math.max(max, e.page), 0),
      status: b.status, finishedOn: b.finishedOn ?? null, recordOnly: sourceBoolean(b.recordOnly), entries: bookEntries };
  });
  // Validate before deriving linked reading progress; all notes/reviews/metadata are already gone.
  sizeBound(reading);
  const readingProgress = readingDailyTotals(parseReading(reading), true);
  const records = rawHabits.some(h => h.link && h.link !== 'reading') ? source(storage, 'records') ?? {} : {};
  const log = rawHabits.length ? source(storage, 'log') ?? {} : {};
  const recordDays = new Map();
  for (const [week, weekRecords] of Object.entries(records)) {
    if (!validDate(week) || mondayOf(week) !== week || !plain(weekRecords)) fail('SOURCE_INVALID');
    for (let i = 0; i < DAY_KEYS.length; i++) if (own(weekRecords, DAY_KEYS[i])) {
      const day = sourceObject(weekRecords[DAY_KEYS[i]]);
      recordDays.set(addDays(week, i), day);
    }
  }
  for (const [day, value] of Object.entries(log)) {
    if (!validDate(day) || !plain(value)) fail('SOURCE_INVALID');
  }
  const habits = rawHabits.map(h => {
    const goal = sourceObject(h.goal);
    if (!['check', 'count', 'minutes'].includes(goal.type) || !Number.isSafeInteger(goal.target) || goal.target < 1 || goal.target > 999) fail('SOURCE_INVALID');
    const link = h.link ?? null;
    if (link && !['workout', 'medicine', 'english', 'instrument', 'cooking', 'reading'].includes(link)) fail('SOURCE_INVALID');
    if (link && !(link === 'workout' || link === 'reading' ? ['check', 'count'] : ['check', 'minutes']).includes(goal.type)) fail('SOURCE_INVALID');
    const freq = h.freq === undefined ? { type: 'daily', days: [], times: 1 } : sourceObject(h.freq);
    const frequencyValue = frequency({ type: freq.type, days: freq.days, times: freq.times });
    const target = goal.type === 'check' ? 1 : goal.target;
    const days = new Set();
    const sanitizedLog = {}, sanitizedRecords = {};
    for (const [day, values] of Object.entries(log)) if (own(values, h.id)) {
      const value = sourceObject(values[h.id]);
      const n = value.n === undefined ? 0 : Number(value.n);
      integer(n);
      const rest = sourceBoolean(value.rest);
      days.add(day); sanitizedLog[day] = { [h.id]: { n, rest } };
    }
    if (link === 'reading') {
      for (const day of readingProgress.keys()) days.add(day);
    } else if (link) {
      for (const [day, values] of recordDays) {
        const keys = link === 'workout' ? Object.keys(values).filter(key => key.startsWith('workout_')) : own(values, link) ? [link] : [];
        if (!keys.length) continue;
        // Workouts enter only as a count of completed tracks. Never retain part IDs,
        // exercise details, durations, sets, weights, health fields or gym_* records.
        let completed = 0, minutes = 0;
        for (const key of keys) {
          const record = sourceObject(values[key]);
          if (sourceBoolean(record.done)) {
            completed++;
            if (link !== 'workout' && goal.type === 'minutes') {
              const duration = parseInt(record.duration, 10) || 0;
              minutes += integer(duration);
            }
          }
        }
        const value = goal.type === 'check' ? (completed ? 1 : 0) : goal.type === 'count' ? completed : minutes;
        days.add(day);
        sanitizedRecords[day] = integer(value);
      }
    }
    return { id: h.id, name: h.name, unit: goal.type, target, frequency: frequencyValue,
      startsOn: !link || link === 'reading' ? sourceDate(h.createdOn) : null,
      entries: [...days].sort().map(day => {
        const n = link === 'reading' ? readingProgress.get(day) ?? 0 : link ? sanitizedRecords[day] ?? 0 : sanitizedLog[day]?.[h.id]?.n ?? 0;
        const value = link === 'reading' && goal.type === 'check' ? (n > 0 ? 1 : 0) : n;
        return { date: day, value, completed: value >= target, rest: sanitizedLog[day]?.[h.id]?.rest ?? false };
      }) };
  });
  const rlog = rawRoutines.length ? sourceObject(todoSource?.rlog, true) : {};
  for (const [day, value] of Object.entries(rlog)) {
    if (!validDate(day) || !plain(value)) fail('SOURCE_INVALID');
  }
  const routines = rawRoutines.map(r => {
    const mode = sourceBoolean(r.avoid) ? 'avoid' : 'do';
    return { id: r.id, name: r.name, mode, createdOn: sourceDate(r.createdOn, false),
      entries: Object.keys(rlog).filter(day => own(rlog[day], r.id)).sort().map(day => {
        const occurred = sourceBoolean(rlog[day][r.id]);
        return { date: day, occurred, completed: mode === 'avoid' ? !occurred : occurred };
      }) };
  });
  const tasks = rawTasks.map(t => {
    const steps = t.steps === undefined ? [] : array(t.steps, 30), counts = new Map();
    for (const step of steps) {
      sourceObject(step);
      const done = sourceDate(step.doneOn);
      if (done) counts.set(done, (counts.get(done) || 0) + 1);
    }
    return { id: t.id, name: t.name, createdOn: sourceDate(t.createdOn), due: sourceDate(t.due), completedOn: sourceDate(t.doneOn),
      completedSteps: [...counts.values()].reduce((n, count) => n + count, 0), totalSteps: steps.length,
      stepEntries: [...counts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([day, count]) => ({ date: day, completedSteps: count })) };
  });
  const payload = { schemaVersion: 2, asOf, timeZone, habits, routines, reading, tasks };
  // Canonical parsers bound records before running any statistics walk.
  payload.habits = parseHabits(habits); payload.routines = parseRoutines(routines);
  payload.reading = parseReading(reading); payload.tasks = parseTasks(tasks);
  sizeBound(payload);
  payload.statistics = deriveStatistics(payload);
  return validatePayload(payload);
}
