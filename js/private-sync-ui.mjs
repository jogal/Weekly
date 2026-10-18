import { buildPayload, listSelectableItems, validatePayload } from "./private-sync-protocol.mjs";
import { createPrivateSyncClient, SOURCE_KEYS, SYNC_KEY, STOP_KEY } from "./private-sync-client.mjs";

const messages = {
  NOT_CONFIGURED: "同期サーバーは未設定です。この端末の保存と書き出しはそのまま使えます。",
  UNAUTHENTICATED: "接続を確認できません。Google に再接続し、内容を確認してから同期を有効にしてください。",
  RECONNECT_REQUIRED: "Google への再接続が必要です。端末の記録と送信待ちは残っています。",
  DEVICE_MISMATCH: "別の端末に結び付いた同期です。この端末から上書きできません。元の端末を使ってください。",
  CONFLICT: "Drive 側の更新と競合しました。自動上書きは停止しています。端末の書き出しを保存し、前回の送信待ちを確認して再試行してください。競合が続く場合は、Drive の変更と元の端末を確認し、同期サーバーの管理者に復旧を依頼してください。",
  REVIEW_REQUIRED: "選んだ項目の名前や内容が変わったか、同期が停止しています。選び直し、JSON を確認してから再度有効にしてください。",
  INVALID_LOCAL_DATA: "選択対象の記録が未作成・空・破損、または対象外です。記録と選択を確認してください。空データは送信しません。",
  LOCAL_STATE_INVALID: "同期の設定を読み込めませんでした。自動同期はオフです。端末の記録は変更していません。",
  STOP_NOT_SAVED: "この画面の送信は止めましたが、停止状態を端末に保存できませんでした。再起動すると同期が再開する可能性があります。空き容量・保存設定を確認し、再度停止してください。",
  LOCAL_QUEUE_FAILED: "送信待ちを端末に保存できないため、送信していません。端末の空き容量を確認してください。",
  OWNER_FORBIDDEN: "この Google アカウントは同期の所有者ではありません。設定された所有者のアカウントで接続してください。",
  ORIGIN_FORBIDDEN: "この URL では同期を利用できません。設定済みの正式なアプリ URL を開いてください。",
  PENDING_REVIEW_REQUIRED: "前回の送信結果が未確認です。「前回の送信待ちを確認」を開き、同じ内容を再試行してから最新の内容を有効にしてください。",
  SYNC_DISABLED: "同期の許可が停止しています。前回の送信待ちを確認してから再開してください。",
  PENDING_DISABLED: "前回の送信結果が未確認のまま停止しています。前回の JSON を確認してから再試行してください。",
  OFFLINE: "オフラインです。送信待ちは端末に残し、オンラインで画面を開いたときに再試行します。",
  PAUSED: "画面を閉じたため送信を一時停止しました。送信待ちは残っています。",
  NETWORK_ERROR: "通信できませんでした。送信待ちは残っています。オンラインで画面を開いたときに再試行します。",
  SERVER_ERROR: "同期サーバーに接続できませんでした。送信待ちは残っています。しばらくしてから再試行してください。",
  INVALID_RESPONSE: "同期サーバーから正しい応答を確認できませんでした。送信待ちは残っています。",
  BUSY: "現在の処理が終わってから操作してください。",
  UPDATE_REQUIRED: "安全な同期にはアプリの更新が必要です。更新通知から再読み込みするか、一度閉じて開き直してください。更新を確認できるまで接続も送信もしません。",
  LOCK_UNAVAILABLE: "このブラウザーでは安全な端末内の同期制御を利用できません。ブラウザーを更新してください。同期は送信せず停止しています。",
  STATE_CHANGED: "同期設定が別の操作やタブで更新されました。現在の設定を確認してください。",
};
const messageFor = e => messages[e?.code || e] || "選択した記録を確認できません。対象の記録と選択を見直してください。";
const stamp = value => value ? new Date(value).toLocaleString("ja-JP") : "まだありません";
const overlay = document.createElement("div");
overlay.className = "overlay ps-overlay"; overlay.id = "private-sync-modal"; overlay.hidden = true;
overlay.innerHTML = `<section class="modal-box ps-box" role="dialog" aria-modal="true" aria-labelledby="ps-title" tabindex="-1">
  <h3 class="modal-title" id="ps-title">Drive に選んだ記録を同期</h3>
  <p class="ps-intro">初期設定はオフです。正本はこの端末に残り、選んだ項目だけを送信します。</p>
  <div class="ps-notice">
    <p>保存先は自分の My Drive にある通常の非公開 JSON ファイルです。共有リンクは作成しません。選んだデータは同期サーバー（Vercel）と Google Drive で処理されます。未確認の送信データは暗号化してサーバーの保存先（Upstash）にも一時保持されます。</p>
    <p>メモ・感想・健康情報・ジムの記録・過去のアーカイブ・認証情報は対象外です。名前や書名、タスク名に個人情報や健康情報などが含まれる項目も選ばないでください。</p>
    <p>これは選んだ記録を読むための限定的な同期です。完全なバックアップや複数端末の統合ではありません。「データを書き出す」も引き続き使ってください。</p>
  </div>
  <dl class="ps-status" aria-live="polite">
    <div><dt>この端末の保存</dt><dd id="ps-local">既存の端末記録を使用</dd></div>
    <div><dt>自動同期</dt><dd id="ps-enabled">オフ</dd></div>
    <div><dt>送信待ち</dt><dd id="ps-pending">なし</dd></div>
    <div><dt>最終同期</dt><dd id="ps-last">まだありません</dd></div>
    <div><dt>Google 接続</dt><dd id="ps-connection">未確認</dd></div>
  </dl>
  <p class="ps-message" id="ps-message" role="status"></p>
  <p class="ps-hint">同期の試行は、アプリ起動時・画面に戻ったとき・オンラインに戻ったとき・記録の保存後です。iPhone で画面を閉じている間の同期は保証できません。</p>
  <div id="ps-items"></div>
  <p class="ps-hint">項目は一つずつ選びます。新しく追加した項目は自動では選ばれません。選択済みの名前が変わった場合は再確認が必要です。</p>
  <button type="button" class="btn btn-secondary" id="ps-preview-button">選んだ内容を JSON で確認</button>
  <button type="button" class="btn btn-secondary" id="ps-pending-review-button" hidden>前回の送信待ちを確認</button>
  <section id="ps-preview-section" hidden>
    <h4 id="ps-preview-title">送信する JSON</h4>
    <p class="ps-hint" id="ps-pending-explanation" hidden>前回の未確認の送信を、同じ内容・同じ識別子で確認します。停止中の場合は、この 1 回の送信を再許可します。現在の端末記録と異なる場合もあるため、名前を含めて確認してください。これだけでは継続的な自動同期は再開しません。</p>
    <p class="ps-hint">この内容を確認してから接続・有効化してください。値が変わったら、もう一度確認します。</p>
    <pre id="ps-preview" tabindex="0" aria-label="送信する JSON"></pre>
    <label class="ps-consent"><input type="checkbox" id="ps-consent">選んだ名前・書名・タスク名は送信してよく、健康情報などの機微な情報を含まないことを確認しました。</label>
  </section>
  <div class="ps-actions">
    <button type="button" class="btn btn-secondary" id="ps-connect" disabled>Google に接続</button>
    <button type="button" class="btn btn-primary" id="ps-enable" disabled>この内容で同期を有効にする</button>
    <button type="button" class="btn btn-secondary" id="ps-retry" hidden>送信待ちを再試行</button>
    <button type="button" class="btn btn-secondary" id="ps-disable" hidden>自動同期を停止して選び直す</button>
    <button type="button" class="btn btn-secondary" id="ps-disconnect" hidden>Google との接続を解除</button>
  </div>
  <p class="ps-hint">接続だけでは送信しません。Google から戻った後、再びこの画面を開いて内容を確認し「有効にする」を押してください。停止・解除しても端末の記録と Drive のファイルは削除されません。停止前に送信済みの処理は完了する場合がありますが、その後の自動送信は止まります。競合した未確認の送信は自動では上書きしません。</p>
  <div class="btn-row"><button type="button" class="btn btn-secondary" id="ps-close">閉じる</button></div>
</section>`;
document.body.appendChild(overlay);
const $ = id => document.getElementById(id);
let preview = null, selectionError = null, opener = null;
const client = createPrivateSyncClient({ storage: localStorage, fetch: (...args) => fetch(...args), buildPayload, listSelectableItems, validatePayload,
  onChange: () => updateStatus() });

function updateStatus() {
  const state = client.getState();
  $("ps-local").textContent = state.localSavedAt ? `保存済み ${stamp(state.localSavedAt)}` : "既存の端末記録を使用";
  $("ps-enabled").textContent = state.enabled ? (state.blocked ? "確認待ちで停止中" : "オン") : "オフ";
  $("ps-pending").textContent = state.queue ? (state.busy ? "送信を確認中" : "1 件（端末に保持）") : "なし";
  $("ps-last").textContent = stamp(state.lastSyncedAt);
  $("ps-connection").textContent = state.connected ? "接続済み" : state.configured === null ? "未確認" : state.configured ? "未接続・再接続が必要" : "サーバー未設定";
  $("ps-message").textContent = selectionError || (state.error ? messageFor(state.error) : state.blocked ? messageFor(state.blocked) : !state.online ? messages.OFFLINE : "");
  const ready = !!preview && $("ps-consent").checked && !state.busy && (!state.enabled || preview.kind === "pending") && state.online;
  $("ps-connect").disabled = !ready || state.configured !== true || state.connected;
  $("ps-connect").textContent = state.lastSyncedAt || state.blocked ? "Google に再接続" : "Google に接続";
  $("ps-enable").disabled = !ready || !state.connected || (state.serverDeviceId && state.serverDeviceId !== state.deviceId);
  $("ps-enable").textContent = preview?.kind === "pending" ? "この前回の送信を再開して確認" : state.blocked === "CONFLICT" ? "確認した内容で再度有効にする" : "この内容で同期を有効にする";
  $("ps-disable").hidden = !state.enabled && !state.busy;
  $("ps-retry").hidden = !state.enabled || !state.queue || !!state.blocked;
  $("ps-retry").disabled = state.busy || !state.online;
  $("ps-disconnect").hidden = !state.connected;
  $("ps-disconnect").disabled = state.busy;
  $("ps-disable").disabled = false;
  $("ps-preview-button").disabled = state.enabled || state.busy;
  $("ps-pending-review-button").hidden = !state.queue;
  $("ps-pending-review-button").disabled = state.busy;
  $("ps-items").querySelectorAll("input").forEach(input => { input.disabled = state.enabled || state.busy; });
}
function invalidatePreview() {
  $("ps-preview-title").textContent = "送信する JSON"; $("ps-pending-explanation").hidden = true;
  preview = null; $("ps-preview-section").hidden = true; $("ps-preview").textContent = ""; $("ps-consent").checked = false;
}
function selected() {
  const selection = { habitIds: [], readingIds: [], taskIds: [] };
  $("ps-items").querySelectorAll("input:checked").forEach(input => selection[input.dataset.group].push(input.value));
  return selection;
}
function renderItems() {
  $("ps-items").replaceChildren();
  try {
    const items = listSelectableItems(localStorage), saved = client.getState().selection;
    [["habits", "habitIds", "習慣"], ["reading", "readingIds", "本"], ["tasks", "taskIds", "大きなタスク"]].forEach(([group, key, title]) => {
      const field = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = title; field.append(legend);
      if (!items[group].length) { const empty = document.createElement("p"); empty.className = "ps-hint"; empty.textContent = "選べる記録はまだありません"; field.append(empty); }
      items[group].forEach(item => {
        const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
        input.type = "checkbox"; input.value = item.id; input.dataset.group = key; input.checked = saved[key].includes(item.id);
        text.textContent = item.name; label.className = "ps-item"; label.append(input, text); field.append(label);
      });
      $("ps-items").append(field);
    });
  } catch (e) { selectionError = messageFor(e); }
}
async function run(action) {
  selectionError = null;
  try { await action(); } catch (e) { selectionError = messageFor(e); }
  updateStatus();
}
async function openSettings() {
  opener = document.activeElement; selectionError = null; invalidatePreview(); renderItems(); overlay.hidden = false;
  updateStatus(); $("ps-close").focus();
  await run(() => client.refreshStatus());
}
function closeSettings() { overlay.hidden = true; opener?.focus(); }
$("private-sync-open")?.addEventListener("click", openSettings);
$("ps-close").addEventListener("click", closeSettings);
overlay.addEventListener("click", event => { if (event.target === overlay) closeSettings(); });
overlay.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); closeSettings(); }
  if (event.key === "Tab") {
    const items = [...overlay.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex='0']")].filter(e => e.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$("ps-items").addEventListener("change", () => { selectionError = null; invalidatePreview(); updateStatus(); });
$("ps-consent").addEventListener("change", updateStatus);
$("ps-preview-button").addEventListener("click", () => {
  selectionError = null; invalidatePreview();
  try { preview = client.review(selected()); $("ps-preview").textContent = preview.json; $("ps-preview-section").hidden = false; }
  catch (e) { selectionError = messageFor(e); }
  updateStatus();
});
$("ps-pending-review-button").addEventListener("click", () => {
  selectionError = null; invalidatePreview();
  try { preview = client.pendingReview(); $("ps-preview").textContent = preview.json; $("ps-preview-section").hidden = false;
    $("ps-preview-title").textContent = "前回の未確認の送信 JSON"; $("ps-pending-explanation").hidden = false; }
  catch (e) { selectionError = messageFor(e); }
  updateStatus();
});
$("ps-connect").addEventListener("click", () => run(async () => {
  const url = await client.connect({ ...preview, confirmed: $("ps-consent").checked });
  location.assign(url);
}));
$("ps-enable").addEventListener("click", () => run(async () => {
  const approved = { ...preview, confirmed: $("ps-consent").checked };
  if (preview?.kind === "pending") {
    await client.retryPending(approved); selectionError = "前回の送信結果を確認しました。自動同期はオフです。最新の内容を確認してから有効にしてください。";
  } else await client.enable(approved);
  invalidatePreview();
}));
$("ps-disable").addEventListener("click", () => run(() => { const stop = client.disable(); invalidatePreview(); return stop; }));
$("ps-disconnect").addEventListener("click", () => run(async () => { await client.disconnect(); invalidatePreview(); renderItems(); }));
$("ps-retry").addEventListener("click", () => run(() => client.attempt()));
window.addEventListener("weekly:local-saved", event => {
  if (!SOURCE_KEYS.has(event.detail?.key)) return;
  if (!overlay.hidden && preview) { invalidatePreview(); selectionError = "端末の記録が更新されました。送信する JSON をもう一度確認してください。"; }
  client.localSaved(event.detail.key);
});
window.addEventListener("storage", event => {
  if (event.key === SYNC_KEY || event.key === STOP_KEY || event.key === null) {
    client.syncExternal(); invalidatePreview(); if (!overlay.hidden) renderItems(); updateStatus();
  }
  // Another tab's data changes are read fresh; never overwrite source records from a sync response.
  if (SOURCE_KEYS.has(event.key)) client.localSaved(event.key);
});
window.addEventListener("online", () => client.resume());
window.addEventListener("offline", updateStatus);
window.addEventListener("pageshow", () => client.resume());
window.addEventListener("pagehide", () => client.pause());
document.addEventListener("visibilitychange", () => { if (document.hidden) client.pause(); else client.resume(); });
client.resume();
