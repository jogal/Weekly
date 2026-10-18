# Private Notion progress summary (OFF by default)

This is a one-device, one-way coaching summary, not backup/restore. Local records remain authoritative. No real user data or credentials are used in automated tests.

## Minimum secure setup

1. Keep `PRIVATE_SYNC_ENABLED=0` during setup. Use the existing Vercel app, encrypted Upstash store and owner-only Google identity configuration. Google sign-in now requests **openid email only**, with online access; access/refresh tokens are discarded after verifying the owner's signed ID token and matching userinfo. It needs no Drive permission or refresh grant. Previously granted Drive permissions are not automatically revoked; the owner can remove obsolete grants in Google account settings.
2. In Notion, create a dedicated page in the owner's private section. Verify its sharing and all parent access: no workspace/teamspace members, guests, public publishing, or shared link access. Create an internal Notion connection with read/update/insert content only, no user information or comments. Give it access to this page only. Do not connect an entire workspace.
3. The owner enters the connection secret directly in the Vercel project's server environment settings as `PRIVATE_SYNC_NOTION_TOKEN`. Never paste credentials in chat, browser JavaScript, the repository, client storage, or logs. Set `PRIVATE_SYNC_NOTION_PAGE_ID` to the dedicated page ID. Set `PRIVATE_SYNC_NOTION_PRIVATE_CONFIRMED=1` only after checking sharing. The Notion API cannot prove the absence of all sharing; this is an owner attestation, not an API privacy check.
4. Keep existing server-only owner identity, encryption, and Redis settings from `.env.example`. Do not generate or replace credentials casually. A new destination-bound Redis namespace isolates old Drive credentials, consent and pending operations; old encrypted records are not automatically deleted. Restrict Vercel/Redis administration access.
5. After separately authorizing deployment/activation, deploy and verify HTTPS and configured status. Set `PRIVATE_SYNC_ENABLED=1` only for the intended production environment. Sign in using Google, inspect the new Notion consent preview, and explicitly enable. Connecting alone never uploads. Old Drive opt-in cannot authorize Notion. Old unacknowledged queues remain untouched and blocked pending owner/admin recovery review.

Environment templates contain placeholders only. Never expose `PRIVATE_SYNC_NOTION_TOKEN` through public/frontend-prefixed variables. Page IDs are configuration, not secret authentication credentials; do not commit personal IDs.

## Representation and boundaries

All currently registered habits, dailies, tasks and books, and future additions/renames, are covered. Names/titles, deadlines, completion/progress, approved actuals and derived statistics are included. Recent dated activity is shown over a labeled window, with older history represented by labeled aggregates and coverage/counts. No item-count truncation is permitted. The JSON preview is the full filtered source projection; the Notion page is its readable summary, not a JSON backup.

No notes, descriptions, reviews, authors, task step names, credentials or detailed Gym fields (sets, weights, pain, body measurements) are exported. Information typed into an allowed name/title remains included. Avoid-habit occurrences mean the behavior happened, not success. An absence of records is not proof of non-completion.

## Publication and failure safety

Each operation has an immutable revisioned child snapshot beneath the configured page. The previous complete snapshot remains available while the new snapshot is marked incomplete. Only a full readback verification permits its complete marker. Readers must select the **highest complete revision**, never an incomplete page or assume list order means newest. Notion has no multi-request transaction or compare-and-swap; the entire page tree is not atomically replaced.

Encrypted Redis CAS reserves one pending operation. Each non-idempotent create/append is durably marked before transmission. If an acknowledgement is lost, readback reconciles that exact operation. Unknown absence does not authorize blind retries: an ambiguous write can require administrator review rather than duplicate data. Checkpoints and every outgoing mutation recheck owner session generation and pending-operation authorization. An already transmitted request can finish after disconnect, but cannot restore authorization.

Requests, response bodies, block counts and batches are bounded. Rate limits, quota failures, external edits or oversize summaries stop safely without dropping records or acknowledging an incomplete snapshot. Recent completed snapshots are retained; archive cleanup applies only to recognized generated snapshots and never user-authored blocks/pages. It does not erase Notion history or recover free-plan lifetime block quotas.

Notion Free workspaces with multiple members have a lifetime block quota; archiving/deleting snapshots does not restore it. Frequent immutable snapshots are unsuitable for long-running use under that limit. Confirm the workspace plan/member count before activation. An unlimited-block workspace still has API rate/size limits. Foreground debounce and unchanged-payload suppression reduce writes, but do not make snapshot creation quota-free.

Disconnect stops future authorization; existing Notion content remains. Foreground changes, launch, app resume and reconnect trigger sync. There is no guarantee while iOS has closed/suspended the app. One device only; no remote restore or two-way merging.

## Verification before rollout

Run `node --test tests/*.test.mjs` and `git diff --check`. Optional mobile-settings smoke: `node tests/private-sync-ui.cjs` with Playwright and Chromium available (or set `BROWSER_PATH`). Tests use synthetic payloads and mocked provider calls only. Live OAuth, private-page sharing, connection permissions, deployment, real Notion API behavior and iPhone/PWA flows still need an authorized acceptance run. Check interruption/retry, duplicate requests, expired sessions, disconnect, oversized input and rate-limit behavior before relying on the feed.
