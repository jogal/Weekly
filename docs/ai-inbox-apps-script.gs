// Weekly AI受け取り箱の中継（Google Apps Script）
// スクリプトプロパティに次の3つを入れておく:
//   NOTION_TOKEN  … Notionのインテグレーションのシークレット
//   NOTION_DB_ID  … 「Weekly 受け取り箱」データベースのID
//   WEEKLY_KEY    … 週クエと共有する合い言葉（長いランダム文字列）
// 週クエからは GET で呼ぶ:
//   ?key=…               → 未取り込みの行を返す {items:[…]}
//   ?key=…&ack=id1,id2   → その行に「取り込み済み」を付ける {acked:n}
const NOTION_VERSION = '2022-06-28';
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function doGet(e) {
  const p = (e && e.parameter) || {};
  const props = PropertiesService.getScriptProperties();
  const want = props.getProperty('WEEKLY_KEY');
  if (!want || p.key !== want) return json({ error: 'unauthorized' });
  try {
    if (p.ack) {
      const ids = String(p.ack).split(',').filter(id => ID_RE.test(id)).slice(0, 50);
      return json({ acked: ack(ids) });
    }
    return json({ items: list() });
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

function notion(path, method, body) {
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, {
    method: method,
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN'),
      'Notion-Version': NOTION_VERSION,
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error('Notion ' + res.getResponseCode() + ': ' + (data.message || ''));
  return data;
}

function dbId() {
  return PropertiesService.getScriptProperties().getProperty('NOTION_DB_ID').replace(/-/g, '');
}

function list() {
  const data = notion('databases/' + dbId() + '/query', 'post', {
    filter: { property: '取り込み済み', checkbox: { equals: false } },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
    page_size: 50,
  });
  return data.results.map(toItem);
}

function toItem(page) {
  const pr = page.properties || {};
  const text = x => ((x && (x.title || x.rich_text)) || []).map(t => t.plain_text).join('');
  const num = x => (x && typeof x.number === 'number') ? x.number : null;
  return {
    id: page.id,
    kind: pr['種類'] && pr['種類'].select ? pr['種類'].select.name : '',
    title: text(pr['内容']),
    date: pr['日付'] && pr['日付'].date ? String(pr['日付'].date.start).slice(0, 10) : null,
    minutes: num(pr['分']),
    questions: num(pr['問題数']),
    correct: num(pr['正解数']),
    note: text(pr['メモ']),
    steps: text(pr['ステップ']),
    gold: num(pr['ゴールド']),
    created: page.created_time,
  };
}

// 受け取り箱の行だけに「取り込み済み」を付ける（ほかのページは触らない）
function ack(ids) {
  let n = 0;
  ids.forEach(id => {
    const page = notion('pages/' + id, 'get');
    const parent = page.parent && page.parent.database_id ? page.parent.database_id.replace(/-/g, '') : '';
    if (parent !== dbId()) return;
    notion('pages/' + id, 'patch', { properties: { '取り込み済み': { checkbox: true } } });
    n++;
  });
  return n;
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// 動作確認用: エディタでこれを実行すると、未取り込みの行がログに出る
function testList() {
  Logger.log(JSON.stringify(list(), null, 2));
}
