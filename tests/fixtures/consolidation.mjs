// Synthetic only. No real user task, date, external identifier or domain data.
export const TODAY = '2001-01-01';
export const OPERATION_ID = 'synthetic-group-01';
export const TARGET_NAME = 'Synthetic grouped work';
export const TARGET_ID = 'inbox_group_' + OPERATION_ID;
export const SOURCES = Array.from({ length: 16 }, (_, i) => ({
  inboxId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: `Synthetic source ${i + 1}`, label: `Synthetic step ${i + 1}`,
  createdOn: TODAY, steps: ['Prepare', 'Create', 'Review'],
}));
export function command(id = '10000000-0000-4000-8000-000000000001', sources = SOURCES, operationId = OPERATION_ID) {
  return { id, kind: 'タスク統合', title: TARGET_NAME, note: JSON.stringify({ version: 1, operation: 'consolidate-tasks', operationId, sources }), steps: '', date: null, gold: null };
}
