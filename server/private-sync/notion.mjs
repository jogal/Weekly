import { createHash } from 'node:crypto';
import { SyncError } from './security.mjs';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const ID = /^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$/i;
const MAX_BLOCKS = 1600;
const MAX_SCAN = 1000;
const RETAIN = 3;
const hash = s => createHash('sha256').update(s).digest('hex');
const rich = s => [{ type: 'text', text: { content: s } }];
const block = (type, s) => ({ object: 'block', type, [type]: { rich_text: rich(s) } });
const plain = b => (b[b.type]?.rich_text || []).map(t => t.text?.content ?? t.plain_text ?? '').join('');
const unmodifiedStyle = b => (!b[b.type]?.color || b[b.type].color === 'default') &&
  (b[b.type]?.rich_text || []).every(t => (!t.type || t.type === 'text') && !t.text?.link &&
    (!t.annotations || Object.entries(t.annotations).every(([k, v]) => k === 'color' ? v === 'default' : v === false)));
const equalBlocks = (actual, expected) => actual.length === expected.length && actual.every((b, i) =>
  !b.has_children && !b.archived && unmodifiedStyle(b) && b.type === expected[i].type && plain(b) === plain(expected[i]));
const titleOf = page => (page.properties?.title?.title || []).map(t => t.text?.content ?? t.plain_text ?? '').join('');
const fail = (code = 'provider_unavailable', status = 503) => { throw new SyncError(code, status); };

// Plain, labelled text preserves the approved data without embedding executable
// links, mentions or arbitrary Notion objects from a client payload.
export function snapshotBlocks(envelope) {
  const serial = JSON.stringify(envelope);
  if (Buffer.byteLength(serial) > 1024 * 1024 + 4096) fail('invalid_payload', 400);
  const marker = `weekly-snapshot-v1:${hash(serial)}`;
  const blocks = [block('paragraph', marker), block('heading_1', 'Weekly progress'),
    block('paragraph', `Revision ${envelope.revision} · Synced ${envelope.syncedAt}`),
    block('paragraph', 'Only COMPLETE snapshots are published. The highest complete revision is current. Older snapshots are historical.')];
  const p = envelope.payload;
  const from = new Date(Date.parse(`${p.asOf}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  const recent = entries => (entries || []).filter(e => e.date >= from && e.date <= p.asOf);
  const text = (type, value) => {
    let chunk = '';
    for (const char of value) {
      if (chunk.length + char.length > 1800) { blocks.push(block(type, chunk)); chunk = ''; }
      chunk += char;
    }
    if (chunk) blocks.push(block(type, chunk));
  };
  const date = value => value || '未設定';
  const unit = value => ({ check: '回', count: '回', minutes: '分', days: '日', weeks: '週' }[value] || value);
  const ratio = r => r ? `${r.achieved}/${r.due}（${r.rate === null ? '対象なし' : Math.round(r.rate * 100) + '%'}）` : '未集計';
  const streak = v => v ? `${v.count}${unit(v.unit)}` : '未集計';
  text('paragraph', `基準日 ${p.asOf} / ${p.timeZone || 'UTC'}。日別記録は直近30日（${from}〜${p.asOf}）。以前の記録は件数・累計と統計に集約し、全履歴の複製ではありません。統計は記録ベースで、報酬・シールドの補正を含みません。未記録日は原則未記録として扱います（回避習慣を除く）。`);
  for (const [key, label] of [['habits', '習慣'], ['routines', 'ルーティン'], ['reading', '読書'], ['tasks', 'タスク']]) {
    text('heading_2', label);
    if (!(p[key] || []).length) text('paragraph', 'なし');
    for (const item of p[key] || []) {
      const entries = item.entries || item.stepEntries || [];
      const history = entries.filter(e => e.date <= p.asOf);
      const older = history.filter(e => e.date < from);
      const stats = Array.isArray(p.statistics?.[key]) ? p.statistics[key].find(v => v.id === item.id) : null;
      const lines = [item.name || item.title, `全記録 ${history.length}件 / 30日より前 ${older.length}件`];
      if (key === 'habits') {
        lines.push(`目標 ${item.target}${unit(item.unit)} / 頻度 ${item.frequency?.type === 'weekly' ? `週${item.frequency.times}回` : item.frequency?.type === 'days' ? `曜日指定 ${item.frequency.days.join(',')}` : '毎日'} / 開始 ${date(item.startsOn)}`,
          `全期間累計 ${history.reduce((n, e) => n + e.value, 0)}${unit(item.unit)} / 達成記録 ${history.filter(e => e.completed).length}日`,
          `30日達成率 ${ratio(stats?.achievement30)} / 現在の連続 ${streak(stats?.currentStreak)} / 365日内最長 ${streak(stats?.bestStreak365)}`);
        lines.push(...recent(entries).map(e => `${e.date}: ${e.value}${unit(item.unit)} ${e.rest ? '休み' : e.completed ? '完了' : '未完了'}`));
      } else if (key === 'routines') {
        lines.push(`種類 ${item.mode === 'avoid' ? '回避' : '実行'} / 開始 ${date(item.createdOn)} / 全期間実行 ${history.filter(e => e.occurred).length}日`,
          `30日達成率 ${ratio(stats?.achievement30)} / 現在の連続 ${streak(stats?.currentStreak)} / 最大1200日内最長 ${streak(stats?.bestStreak1200)}`);
        lines.push(...recent(entries).map(e => `${e.date}: ${e.occurred ? '実行あり' : '実行なし'} / ${e.completed ? '完了' : '未完了'}`));
      } else if (key === 'reading') {
        lines.push(`${item.currentPage}/${item.totalPages || '未設定'}ページ / ${({ want: '読みたい', reading: '読書中', done: '読了' })[item.status] || item.status} / 読了日 ${date(item.finishedOn)} / 記録のみ ${item.recordOnly ? 'はい' : 'いいえ'}`);
        lines.push(...recent(entries).map(e => `${e.date}: ${e.page}ページまで`));
      } else {
        lines.push(`${item.completedOn ? '完了' : '未完了'} / 作成 ${date(item.createdOn)} / 期限 ${date(item.due)} / 完了日 ${date(item.completedOn)}`,
          `ステップ ${item.completedSteps}/${item.totalSteps}`);
        lines.push(...recent(entries).map(e => `${e.date}: ${e.completedSteps}ステップ完了`));
      }
      if (!recent(entries).length) lines.push('直近30日の日別記録なし');
      text('paragraph', lines.join('\n'));
    }
  }
  const stats = p.statistics;
  if (stats) {
    text('heading_2', '集計');
    for (const [key, label] of [['recent', '直近30日'], ['year', '直近365日']]) {
      const reading = stats.reading?.[key];
      if (reading) text('paragraph', `読書 ${label}: ${reading.pages}ページ / ${reading.readingDays}日 / ${reading.finishedBooks}冊読了`);
    }
    const t = stats.tasks;
    if (t) text('paragraph', `タスク: 全${t.total}件 / 未完了${t.open}件 / 完了${t.completed}件 / 期限超過${t.overdue}件 / 本日期限${t.dueToday}件 / 30日内完了${t.completed30}件 / ステップ${t.completedSteps}/${t.totalSteps}`);
    text('paragraph', '連続記録の算出範囲: 日次は最大1200日、週次は過去200週。習慣の最長連続は365日、ルーティンは最大1200日。');
  }
  if (blocks.length > MAX_BLOCKS) fail('invalid_payload', 400);
  blocks[0] = block('paragraph', `${marker}:${hash(JSON.stringify(blocks.slice(1)))}`);
  return blocks;
}

async function readJSON(res) {
  if (Number(res.headers.get('content-length')) > 2 * 1024 * 1024) fail();
  let size = 0; const chunks = [];
  try {
    for await (const chunk of res.body) {
      size += chunk.byteLength; if (size > 2 * 1024 * 1024) fail();
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { fail(); }
}

/**
 * checkpoint(old, next) must atomically compare pending.notion to old AND fence
 * the operation/generation; return false if another invocation advanced it.
 * authorize() must re-check the durable authorization fence before each write.
 * An uncertain POST/PATCH-append is never repeated. Reconciliation can observe
 * its exact result; otherwise the pending operation stays blocked for recovery.
 */
export function createNotion(config, fetcher = globalThis.fetch, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), paceMs = 350 } = {}) {
  let lastRequest = -Infinity;
  async function request(path, method = 'GET', body, beforeSend) {
    let res;
    const wait = lastRequest + paceMs - now();
    if (wait > 0) await sleep(wait);
    lastRequest = now();
    if (beforeSend) await beforeSend();
    try {
      res = await fetcher(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${config.notionToken}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail(); }
    if (res.status === 429) {
      const error = new SyncError('provider_rate_limited', 503);
      const seconds = Number(res.headers.get('retry-after'));
      error.retryAt = now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
      throw error;
    }
    if (!res.ok) fail(); // No automatic write retries, upstream bodies or logging.
    return readJSON(res);
  }
  async function children(id, limit = MAX_BLOCKS) {
    const out = []; let cursor; const seen = new Set();
    do {
      const page = await request(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(page.results)) fail();
      out.push(...page.results);
      if (out.length > limit) fail('snapshot_limit', 409);
      if (!page.has_more) return out;
      if (typeof page.next_cursor !== 'string' || seen.has(page.next_cursor)) fail();
      cursor = page.next_cursor; seen.add(cursor);
    } while (out.length < limit);
    fail('snapshot_limit', 409);
  }
  return {
    async publish(envelope, { state = null, checkpoint, authorize }) {
      if (!ID.test(config.notionPageId || '') || !config.notionToken || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1) fail('invalid_request', 400);
      const blocks = snapshotBlocks(envelope);
      const signature = hash(JSON.stringify(envelope));
      const namespace = hash(String(envelope.deviceId)).slice(0, 16);
      const base = `Weekly sync ${namespace} r${envelope.revision} ${signature.slice(0, 24)}`;
      const staging = `${base} STAGING`; const complete = `${base} COMPLETE`;
      const advance = async next => {
        if (!(await checkpoint(state, next))) fail('retry_later');
        state = next;
      };
      const mutate = (path, method, body) => request(path, method, body, authorize);
      try {
      if (state?.retryAt > now()) fail('provider_rate_limited');
      if (state && state.signature !== signature) fail('operation_conflict', 409);
      if (!state || state.phase === 'retry_create') {
        // Bounded parent scan and recoverable archival provide bounded retained
        // snapshots. Never archive this or any higher revision, even if an old
        // invocation wakes after a newer one has completed.
        const siblings = await children(config.notionPageId, MAX_SCAN);
        const pattern = new RegExp(`^Weekly sync ${namespace} r([0-9]+) [a-f0-9]{24} COMPLETE$`);
        const owned = siblings.filter(b => b.type === 'child_page' && pattern.test(b.child_page?.title || ''))
          .map(b => ({ ...b, revision: Number(b.child_page.title.match(pattern)[1]) })).sort((a, b) => b.revision - a.revision);
        const old = owned.filter(b => b.revision < envelope.revision).slice(RETAIN - 1);
        for (const b of old) {
          const content = await children(b.id);
          const digestPart = b.child_page.title.split(' ').at(-2);
          const marker = plain(content[0] || {}).match(/^weekly-snapshot-v1:([a-f0-9]{64}):([a-f0-9]{64})$/);
          const rendered = content.slice(1).map(b => block(b.type, plain(b)));
          if (!marker || !marker[1].startsWith(digestPart) || content.some(b => b.has_children || b.archived || !unmodifiedStyle(b)) ||
              marker[2] !== hash(JSON.stringify(rendered))) fail('external_change', 409);
          await mutate(`/pages/${b.id}`, 'PATCH', { archived: true });
        }
        // Refuse an unbounded accumulation of incomplete snapshots. Only a
        // successful create adds one; retries never create another.
        const ours = siblings.filter(b => b.type === 'child_page' && b.child_page?.title?.startsWith(`Weekly sync ${namespace} `));
        if (ours.length - old.length >= 10) fail('snapshot_limit', 409);
        await advance({ signature, phase: 'creating' });
        let page;
        try { page = await mutate('/pages', 'POST', { parent: { type: 'page_id', page_id: config.notionPageId },
          properties: { title: { type: 'title', title: rich(staging) } } });
        } catch (error) {
          if (error.code === 'provider_rate_limited') await advance({ signature, phase: 'retry_create', retryAt: error.retryAt });
          throw error;
        }
        if (!ID.test(page.id || '')) fail();
        await advance({ signature, phase: 'ready', pageId: page.id, count: 0 });
      }
      if (state.phase === 'creating') {
        const matches = (await children(config.notionPageId, MAX_SCAN)).filter(b =>
          b.type === 'child_page' && [staging, complete].includes(b.child_page?.title));
        if (matches.length !== 1 || !ID.test(matches[0].id)) fail('pending_operation', 409);
        await advance({ signature, phase: 'ready', pageId: matches[0].id, count: 0 });
      }
      if (!ID.test(state.pageId || '')) fail('external_change', 409);
      const pageId = state.pageId;
      const page = await request(`/pages/${pageId}`);
      if (page.parent?.page_id?.replaceAll('-', '') !== config.notionPageId.replaceAll('-', '') || page.archived || page.in_trash ||
          ![staging, complete].includes(titleOf(page))) fail('external_change', 409);
      let actual = await children(pageId);
      if (state.phase === 'appending') {
        if (!equalBlocks(actual, blocks.slice(0, state.target))) fail('pending_operation', 409);
        await advance({ signature, phase: 'ready', pageId, count: state.target });
      }
      if (!Number.isSafeInteger(state.count) || !equalBlocks(actual, blocks.slice(0, state.count))) fail('external_change', 409);
      while (state.count < blocks.length) {
        const count = state.count; const target = Math.min(count + 50, blocks.length);
        const batch = blocks.slice(count, target);
        if (Buffer.byteLength(JSON.stringify({ children: batch })) > 450000) fail('invalid_payload', 400);
        await advance({ signature, phase: 'appending', pageId, count, target });
        try { await mutate(`/blocks/${pageId}/children`, 'PATCH', { children: batch }); }
        catch (error) {
          if (error.code === 'provider_rate_limited') await advance({ signature, phase: 'ready', pageId, count, retryAt: error.retryAt });
          throw error;
        }
        actual = await children(pageId);
        if (!equalBlocks(actual, blocks.slice(0, target))) fail('external_change', 409);
        await advance({ signature, phase: 'ready', pageId, count: target });
      }
      // Retrying this exact title PATCH is safe. It cannot redirect a mutable
      // latest pointer or overwrite content belonging to a different revision.
      if (titleOf(page) !== complete) await mutate(`/pages/${pageId}`, 'PATCH', { properties: { title: { type: 'title', title: rich(complete) } } });
      const verified = await request(`/pages/${pageId}`);
      if (titleOf(verified) !== complete || verified.archived || verified.in_trash || !equalBlocks(await children(pageId), blocks)) fail('external_change', 409);
      return { snapshotId: pageId };
      } catch (error) {
        // Every rate-limited endpoint, including reads, archival and the final
        // idempotent title update, preserves a durable provider cooldown.
        if (error.code === 'provider_rate_limited' && Number.isFinite(error.retryAt) && state?.retryAt !== error.retryAt) {
          await advance({ ...(state || { signature, phase: 'retry_create' }), retryAt: error.retryAt });
        }
        throw error;
      }
    },
  };
}
