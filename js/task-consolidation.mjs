// Bounded task grouping. The exact source manifest arrives only in the private
// inbox command; public code contains no user task names or external row IDs.
export const OPERATION = 'consolidate-tasks';
export const TODO_KEY = 'wt_todo_v1';
export const BACKUP_KEY = 'wt_task_consolidation_backup_v1';
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blocked = reason => ({ status: 'blocked', reason });
const onlyKeys = (value, allowed) => object(value) && Object.keys(value).every(k => allowed.includes(k));
const exactKeys = (value, keys) => onlyKeys(value, keys) && Object.keys(value).length === keys.length;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 40 && value.trim() === value && !/[\u0000-\u001f]/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const rowId = value => typeof value === 'string' && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value);
const canonicalId = value => value.replace(/-/g, '').toLowerCase();
const unique = values => new Set(values).size === values.length;

function manifestFrom(raw, targetName) {
  if (!exactKeys(raw, ['version', 'operation', 'operationId', 'sources']) || raw.version !== 1 || raw.operation !== OPERATION
    || typeof raw.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(raw.operationId) || ['constructor', 'prototype'].includes(raw.operationId) || !text(targetName)
    || !Array.isArray(raw.sources) || raw.sources.length < 2 || raw.sources.length > 30) return null;
  if (!raw.sources.every(source => exactKeys(source, ['inboxId', 'name', 'createdOn', 'steps', 'label'])
    && rowId(source.inboxId) && text(source.name) && date(source.createdOn) && text(source.label)
    && Array.isArray(source.steps) && source.steps.length <= 30 && source.steps.every(text))) return null;
  if (!unique(raw.sources.map(s => canonicalId(s.inboxId))) || !unique(raw.sources.map(s => s.name))
    || !unique(raw.sources.map(s => s.label)) || raw.sources.some(s => s.name === targetName)) return null;
  // Construct fields explicitly so canonical comparison doesn't depend on JSON key order.
  return { version: 1, operation: OPERATION, operationId: raw.operationId, targetName,
    sources: raw.sources.map(s => ({ inboxId: canonicalId(s.inboxId), name: s.name, createdOn: s.createdOn, steps: [...s.steps], label: s.label })) };
}
export function commandManifest(item) {
  if (item?.kind !== 'タスク統合' || !rowId(item.id) || !text(item.title) || item.steps || item.date || item.gold != null
    || typeof item.note !== 'string' || item.note.length > 30000) return null;
  let raw;
  try { raw = JSON.parse(item.note); } catch { return null; }
  return manifestFrom(raw, item.title);
}
export function isConsolidationCommand(item) { return !!commandManifest(item); }
function savedManifest(raw) {
  if (!exactKeys(raw, ['version', 'operation', 'operationId', 'targetName', 'sources'])) return null;
  const { targetName, ...manifest } = raw;
  return manifestFrom(manifest, targetName);
}
function targetTask(manifest, today) {
  const id = 'inbox_group_' + manifest.operationId;
  return { id, name: manifest.targetName, icon: '📝', due: null, createdOn: today, doneOn: null, reward: 30,
    steps: manifest.sources.map((source, i) => ({ id: `${id}_${i}`, name: source.label, doneOn: null })) };
}
function unchangedSource(task, expected) {
  return onlyKeys(task, ['id', 'name', 'icon', 'due', 'steps', 'createdOn', 'doneOn', 'reward'])
    && typeof task.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(task.id) && task.name === expected.name
    && (!task.id.startsWith('inbox_') || (rowId(task.id.slice(6)) && canonicalId(task.id.slice(6)) === canonicalId(expected.inboxId)))
    && task.createdOn === expected.createdOn && task.icon === '📝' && task.due === null && task.doneOn === null && task.reward === 30
    && Array.isArray(task.steps) && task.steps.length === expected.steps.length
    && task.steps.every((step, i) => onlyKeys(step, ['id', 'name', 'doneOn'])
      && typeof step.id === 'string' && !!step.id && step.name === expected.steps[i] && step.doneOn === null)
    && unique(task.steps.map(step => step.id));
}
function validReceipt(receipt) {
  const manifest = savedManifest(receipt?.manifest);
  return !!manifest && receipt.version === 1 && receipt.operationId === manifest.operationId && rowId(receipt.inboxId)
    && date(receipt.appliedOn) && receipt.targetId === 'inbox_group_' + manifest.operationId
    && JSON.stringify(receipt.targetInitial) === JSON.stringify(targetTask(manifest, receipt.appliedOn))
    && Array.isArray(receipt.sources) && receipt.sources.length === manifest.sources.length
    && unique(receipt.sources.map(source => source.task?.id)) && unique(receipt.sources.map(source => source.index))
    && receipt.sources.every((source, i) => source.inboxId === manifest.sources[i].inboxId
      && unchangedSource(source.task, manifest.sources[i]) && Number.isInteger(source.index) && source.index >= 0);
}
function receipts(todo) {
  return object(todo?.taskConsolidations) ? Object.values(todo.taskConsolidations).filter(validReceipt) : [];
}
export function isRetiredTaskId(todo, taskId) {
  return receipts(todo).some(receipt => receipt.sources.some(source => source.task.id === taskId));
}
export function wasConsolidatedSource(todo, inboxId) {
  return rowId(inboxId) && receipts(todo).some(receipt => receipt.sources.some(source => source.inboxId === canonicalId(inboxId)));
}

// No normalization of existing records: a changed or unknown source field stops
// the operation, and unrelated raw tasks/routines/root fields remain untouched.
export function planConsolidation(todo, item, today) {
  const manifest = commandManifest(item);
  if (!manifest || !date(today)) return blocked('統合命令が承認済みの形式と一致しません');
  if (!object(todo) || !Array.isArray(todo.tasks) || !Array.isArray(todo.routines) || !object(todo.rlog)) return blocked('端末のタスクデータを確認できません');
  if (todo.taskConsolidations !== undefined && (!object(todo.taskConsolidations)
    || Object.entries(todo.taskConsolidations).some(([id, receipt]) => !validReceipt(receipt) || receipt.operationId !== id))) return blocked('統合履歴を確認できません');
  const previous = object(todo.taskConsolidations) && Object.hasOwn(todo.taskConsolidations, manifest.operationId)
    ? todo.taskConsolidations[manifest.operationId] : undefined;
  if (previous) return JSON.stringify(savedManifest(previous.manifest)) === JSON.stringify(manifest)
    ? { status: 'already-applied' } : blocked('同じ統合IDに異なる内容が届きました。再実行せず確認してください');
  const target = targetTask(manifest, today);
  if (todo.tasks.some(task => task?.id === target.id || task?.name === target.name)) return blocked('統合先と同名・同IDのタスクが既にあります');
  if (!unique(todo.tasks.map(task => task?.id))) return blocked('端末に重複するタスクIDがあります');
  const sources = [];
  for (const expected of manifest.sources) {
    const matches = todo.tasks.map((task, index) => ({ task, index })).filter(({ task }) => task?.name === expected.name);
    if (matches.length !== 1 || matches[0].task.createdOn !== expected.createdOn) return blocked(`${expected.name}: 対象がないか、同名・作成日の照合が一意ではありません`);
    const source = matches[0];
    if (!unchangedSource(source.task, expected) || isRetiredTaskId(todo, source.task.id) || wasConsolidatedSource(todo, expected.inboxId)) {
      return blocked(`${expected.name}: 進捗・内容・統合履歴を確認してください。元タスクは変更しません`);
    }
    sources.push({ ...clone(source), inboxId: expected.inboxId });
  }
  const sourceIds = new Set(sources.map(source => source.task.id));
  const firstIndex = Math.min(...sources.map(source => source.index));
  const tasks = todo.tasks.flatMap((task, i) => [...(i === firstIndex ? [target] : []), ...(!sourceIds.has(task.id) ? [task] : [])]);
  return { status: 'applied', todo: { ...todo, tasks,
    taskConsolidations: { ...todo.taskConsolidations, [manifest.operationId]: {
      version: 1, operationId: manifest.operationId, manifest, inboxId: item.id, appliedOn: today,
      targetId: target.id, targetInitial: clone(target), sources,
    } },
  } };
}

// Independent immutable per-operation backup first; replacement + primary receipt
// then commit in one setItem. Prepared backup is NOT proof of committed execution.
export function applyConsolidation(storage, item, today) {
  const before = storage.getItem(TODO_KEY);
  let todo;
  try { todo = JSON.parse(before); } catch { return blocked('端末のタスクデータを読み取れません'); }
  const result = planConsolidation(todo, item, today);
  if (result.status !== 'applied') return result;
  const operationId = commandManifest(item).operationId;
  const receipt = result.todo.taskConsolidations[operationId];
  const saved = storage.getItem(BACKUP_KEY);
  let backups = { version: 1, operations: {} };
  if (saved !== null) {
    try { backups = JSON.parse(saved); } catch { return blocked('統合の独立バックアップを確認できません'); }
    if (!exactKeys(backups, ['version', 'operations']) || backups.version !== 1 || !object(backups.operations)
      || Object.entries(backups.operations).some(([id, b]) => !validReceipt(b?.receipt) || b.receipt.operationId !== id)) return blocked('統合の独立バックアップを確認できません');
  }
  const existing = Object.hasOwn(backups.operations, operationId) ? backups.operations[operationId] : undefined;
  if (existing) {
    if (JSON.stringify(existing.receipt.manifest) !== JSON.stringify(receipt.manifest)
      || JSON.stringify(existing.receipt.sources.map(s => s.task)) !== JSON.stringify(receipt.sources.map(s => s.task))) return blocked('既存の独立バックアップと対象が一致しません。上書きせず確認してください');
  } else {
    const backup = JSON.stringify({ ...backups, operations: { ...backups.operations,
      [operationId]: { preparedOn: today, receipt, todoBefore: todo },
    } });
    storage.setItem(BACKUP_KEY, backup);
    if (storage.getItem(BACKUP_KEY) !== backup) return blocked('統合の独立バックアップを保存できません');
  }
  if (storage.getItem(TODO_KEY) !== before) return blocked('タスクが更新されたため統合を見送りました');
  storage.setItem(TODO_KEY, JSON.stringify(result.todo));
  return result;
}
