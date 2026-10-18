// Private support feed, not a backup. Construct fields individually; never spread source records.
import { addDays, DAY_KEYS, mondayOf, progressOf, targetOf } from './habit-core.mjs';
import { readOn } from './reading-core.mjs';

export const MAX_PAYLOAD_BYTES = 128 * 1024;
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
export function validatePayload(value) {
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
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_PAYLOAD_BYTES) fail('PAYLOAD_TOO_LARGE');
  return result;
}

function source(storage, name, required = false) {
  const raw = storage.getItem(SOURCE_KEYS[name]);
  if (raw === null || raw === undefined) { if (required) fail('SOURCE_UNINITIALIZED'); return null; }
  if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) fail('SOURCE_INVALID');
  let data; try { data = JSON.parse(raw); } catch { fail('SOURCE_INVALID'); }
  if (!plain(data)) fail('SOURCE_INVALID');
  return data;
}
function collection(data, key) {
  if (data === null) return [];
  if (!Array.isArray(data[key])) fail('SOURCE_INVALID');
  return data[key];
}
function selectionIds(selection) {
  object(selection, ['habitIds', 'readingIds', 'taskIds']);
  for (const k of Object.keys(selection)) { array(selection[k], MAX_ITEMS).forEach(id); unique(selection[k], x => x); }
  if (!Object.values(selection).some(a => a.length)) fail('EMPTY_SELECTION');
  return selection;
}
function pick(items, ids) {
  return ids.map(selectedId => {
    const matches = items.filter(item => item?.id === selectedId && !item.archived && !item.archivedOn);
    if (matches.length !== 1) fail('SELECTION_CHANGED');
    return matches[0];
  });
}
export function listSelectableItems(storage) {
  const list = (items, titleKey) => items.filter(item => plain(item) && !item.archived && !item.archivedOn && ID.test(item.id || '')).map(item => ({ id: id(item.id), name: text(item[titleKey], titleKey === 'title' ? 120 : 40) }));
  return {
    habits: list(collection(source(storage, 'habits'), 'habits'), 'name'),
    reading: list(collection(source(storage, 'reading'), 'books'), 'title'),
    tasks: list(collection(source(storage, 'todo'), 'tasks'), 'name'),
  };
}
export function buildPayload(storage, selection) {
  selectionIds(selection);
  // Read only source collections needed by the explicitly selected IDs. Never touch gym/archive/auth keys.
  const selectedHabits = selection.habitIds.length ? pick(collection(source(storage, 'habits', true), 'habits'), selection.habitIds) : [];
  const needRecords = selectedHabits.some(h => h.link && h.link !== 'reading');
  const records = needRecords ? source(storage, 'records', true) : {};
  const log = selectedHabits.some(h => !h.link) ? source(storage, 'log', true) : {};
  const needReading = selection.readingIds.length || selectedHabits.some(h => h.link === 'reading');
  const books = needReading ? collection(source(storage, 'reading', true), 'books') : [];
  const selectedBooks = pick(books, selection.readingIds);
  const tasks = selection.taskIds.length ? pick(collection(source(storage, 'todo', true), 'tasks'), selection.taskIds) : [];
  const days = new Set();
  for (const [week, weekRecords] of Object.entries(records)) {
    if (!validDate(week) || mondayOf(week) !== week || !plain(weekRecords)) fail('SOURCE_INVALID');
    for (let i = 0; i < DAY_KEYS.length; i++) if (own(weekRecords, DAY_KEYS[i])) {
      if (!plain(weekRecords[DAY_KEYS[i]])) fail('SOURCE_INVALID');
      days.add(addDays(week, i));
    }
  }
  for (const day of Object.keys(log)) { if (!validDate(day)) fail('SOURCE_INVALID'); days.add(day); }
  for (const b of books) {
    if (!plain(b.log)) fail('SOURCE_INVALID');
    for (const [day, e] of Object.entries(b.log)) {
      if (!validDate(day) || !plain(e) || !Number.isInteger(e.page) || e.page < 0 || e.page > 20000) fail('SOURCE_INVALID');
      days.add(day);
    }
  }
  const ctx = { records, log, readPages: day => books.reduce((n, b) => n + readOn(b, day), 0) };
  const sortedDays = [...days].sort();
  const payload = {
    schemaVersion: 1,
    habits: selectedHabits.map(h => {
      if (!plain(h.goal) || !['check', 'count', 'minutes'].includes(h.goal.type) || !Number.isSafeInteger(h.goal.target) || h.goal.target < 1 || h.goal.target > 999) fail('SOURCE_INVALID');
      if (h.link && !['workout', 'medicine', 'english', 'instrument', 'cooking', 'reading'].includes(h.link)) fail('SOURCE_INVALID');
      return { id: h.id, name: h.name, unit: h.goal.type, entries: sortedDays.map(day => {
        const value = progressOf(h, day, ctx);
        return { date: day, value, completed: value >= targetOf(h) };
      }).filter(e => e.value > 0) };
    }),
    reading: selectedBooks.map(b => ({
      id: b.id, title: b.title, totalPages: b.pages,
      currentPage: Object.values(b.log).reduce((max, e) => Math.max(max, e.page), 0),
      status: b.status, finishedOn: b.finishedOn ?? null,
      entries: Object.entries(b.log).sort(([a], [b]) => a.localeCompare(b)).map(([day, e]) => ({ date: day, page: e.page })),
    })),
    tasks: tasks.map(t => {
      if (!Array.isArray(t.steps)) fail('SOURCE_INVALID');
      return { id: t.id, name: t.name, due: t.due ?? null, completedOn: t.doneOn ?? null, completedSteps: t.steps.filter(s => validDate(s.doneOn)).length, totalSteps: t.steps.length };
    }),
  };
  return validatePayload(payload);
}
