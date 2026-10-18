// Only sanitized feed records enter these calculations. Never read localStorage or reward/gym stores.
import { addDays, mondayOf, currentStreak, bestStreak, habitRate } from './habit-core.mjs';
import { routineStreak, routineBestStreak, routineRate } from './todo-core.mjs';

const inRange = (day, from, to) => day >= from && day <= to;
const streak = s => ({ count: s.n, unit: s.unit === 'w' ? 'weeks' : 'days' });
const rate = (achieved, due) => ({ achieved, due, rate: due ? achieved / due : null });
const last = values => values.length ? values.reduce((a, b) => a > b ? a : b) : null;

// Equivalent to reading-core.readOn/pagesOnDay for canonical date-sorted entries,
// but linear in history size rather than rescanning all earlier pages per day.
export function readingDailyTotals(books, excludeRecordOnly = false) {
  const result = new Map();
  for (const book of books) {
    if (excludeRecordOnly && book.recordOnly) continue;
    let highWater = 0;
    for (const entry of book.entries) {
      const pages = Math.max(0, entry.page - highWater);
      highWater = Math.max(highWater, entry.page);
      result.set(entry.date, (result.get(entry.date) || 0) + pages);
    }
  }
  return result;
}

export function deriveStatistics(payload) {
  const { asOf, habits, routines, reading, tasks } = payload;
  const recent = { from: addDays(asOf, -29), to: asOf };
  const year = { from: addDays(asOf, -364), to: asOf };
  // The app itself caps habit walks at 1200 days / 200 prior weeks. Routine walks
  // are additionally bounded here; these are explicitly record-based statistics,
  // not the app's reward-shield-adjusted streak display.
  const streakWindows = {
    days: { from: addDays(asOf, -1199), to: asOf, maximumDays: 1200 },
    weeks: { from: addDays(mondayOf(asOf), -1400), to: asOf, maximumPreviousWeeks: 200 },
  };
  const habitStats = habits.map(h => {
    const model = { id: h.id, link: null, createdOn: h.startsOn,
      goal: { type: h.unit, target: h.target }, freq: h.frequency };
    const log = Object.fromEntries(h.entries.filter(e => e.date <= asOf).map(e => [e.date, { [h.id]: { n: e.value, rest: e.rest } }]));
    const ctx = { log, today: asOf, floorKey: h.frequency.type === 'weekly' ? streakWindows.weeks.from : streakWindows.days.from };
    const recentEntries = h.entries.filter(e => inRange(e.date, recent.from, asOf) && (!h.startsOn || e.date >= h.startsOn));
    const achievement = habitRate(model, recent.from, asOf, asOf, ctx);
    return { id: h.id, lastRecordedOn: last(h.entries.filter(e => e.date <= asOf).map(e => e.date)),
      recentValue: recentEntries.reduce((sum, e) => sum + e.value, 0),
      recentCompletedDays: recentEntries.filter(e => e.completed).length,
      achievement30: rate(achievement.ok, achievement.due),
      currentStreak: streak(currentStreak(model, asOf, ctx)),
      bestStreak365: streak(bestStreak(model, year.from, asOf, ctx)) };
  });
  const routineStats = routines.map(r => {
    const model = { id: r.id, avoid: r.mode === 'avoid', createdOn: r.createdOn };
    const rlog = Object.fromEntries(r.entries.filter(e => e.date <= asOf && e.occurred).map(e => [e.date, { [r.id]: 1 }]));
    const state = { routines: [model], rlog };
    const achievement = routineRate(state, r.id, asOf, 30);
    const boundedModel = { ...model, createdOn: model.createdOn < streakWindows.days.from ? streakWindows.days.from : model.createdOn };
    const bounded = { routines: [boundedModel], rlog };
    return { id: r.id, lastOccurredOn: last(r.entries.filter(e => e.occurred && e.date <= asOf).map(e => e.date)),
      recentOccurredDays: r.entries.filter(e => e.occurred && inRange(e.date, recent.from, asOf) && e.date >= r.createdOn).length,
      achievement30: rate(achievement.done, achievement.total),
      currentStreak: { count: routineStreak(bounded, r.id, asOf), unit: 'days' },
      bestStreak1200: { count: routineBestStreak(bounded, r.id, asOf), unit: 'days' } };
  });
  const readingDays = readingDailyTotals(reading);
  const readingPeriod = range => {
    let pages = 0, days = 0;
    for (const [day, value] of readingDays) if (value > 0 && inRange(day, range.from, range.to)) { pages += value; days++; }
    return { pages, readingDays: days,
      finishedBooks: reading.filter(b => b.status === 'done' && b.finishedOn !== null && inRange(b.finishedOn, range.from, range.to)).length };
  };
  const done = t => t.completedOn !== null && t.completedOn <= asOf;
  return {
    basis: 'recorded-progress', rewardShieldsIncluded: false,
    missingDayMeaning: 'unrecorded-except-avoidance', recent, year, streakWindows,
    habits: habitStats, routines: routineStats,
    reading: { recent: readingPeriod(recent), year: readingPeriod(year) },
    tasks: { total: tasks.length, open: tasks.filter(t => !done(t)).length,
      completed: tasks.filter(done).length,
      overdue: tasks.filter(t => !done(t) && t.due !== null && t.due < asOf).length,
      dueToday: tasks.filter(t => !done(t) && t.due === asOf).length,
      completed30: tasks.filter(t => done(t) && inRange(t.completedOn, recent.from, asOf)).length,
      completedSteps: tasks.reduce((n, t) => n + t.stepEntries.filter(e => e.date <= asOf).reduce((a, e) => a + e.completedSteps, 0), 0),
      totalSteps: tasks.reduce((n, t) => n + t.totalSteps, 0) },
  };
}
