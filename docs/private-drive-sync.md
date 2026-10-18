# Opt-in private Google Drive sync

## Status and activation gate

This change is code for an owner-only, one-way export. It does **not** activate sync, provision a store, create an OAuth client/grant, configure secrets, deploy, share a file, or upload existing user data. `PRIVATE_SYNC_ENABLED` defaults to off, and every required setting must pass validation before the backend accepts work.

The proposed durable backend is an **Upstash Redis REST database**, accessed with Node built-ins and no added packages. Creating the database, accepting its terms, choosing retention/backups/region/cost, issuing its REST credential, configuring persistent access, and deploying require separate owner approval. Do not provision one as a side effect of opening or testing this PR.

Before setting `PRIVATE_SYNC_ENABLED=1`, the owner/admin must configure and verify hosting-layer request-rate and abuse limits for `/api/private-sync`, especially anonymous `status`/`connect` requests. These routes can allocate encrypted Redis session/state records before Google owner authentication; CSRF and owner checks do not prevent a direct public request flood. This code has no built-in anonymous per-IP rate limiter and offers no quota/cost guarantee. Choose an approved platform protection, test its limits, and configure budget/quota alerts before activation. No rate-limit service or platform setting is provisioned by this change.

The client must show the complete four-category payload preview and obtain explicit category-wide confirmation before initial enable. There is no per-item selector: every eligible active item, including future additions and renames, is included after opt-in. A successful Google connection alone leaves uploads disabled. Only the one configured Google owner and the first registered browser/device can enable uploads. Every reconnect leaves uploads disabled until another explicit enable. There is no multi-device merge or restore/download-to-local path.

## Export boundary

One ordinary, private JSON file named `Weekly private progress.json` is created at the owner's My Drive root. It is not in `appDataFolder`, a shared drive, or a public link. The app never invokes a permissions API. The create call explicitly requests `visibility=PRIVATE`; existing file metadata must remain unshared, owner-owned, non-trashed, and ordinary JSON.

The schema-v2 feed includes **all active items** in four categories. Fields are constructed individually by `js/private-sync-protocol.mjs` and checked again on the server; localStorage objects are never copied wholesale.

- Habits: ID, name, unit, target/frequency settings, start date, and dated value/completion/rest records
- Daily routines: ID, name, creation date, do/avoid mode, and dated occurrence/completion records
- Books: ID, title, total/current pages, status, finish date, dated page progress, and the record-only flag used by the app's reading-habit calculation
- Large tasks: ID, name, creation/due/completion dates, step totals and completion counts grouped by date; no step names
- Bounded, record-based statistics recomputed from those validated fields, with a reference date and IANA timezone

The built-in **workout habit** is included at habit-summary level. Its value is a completion flag or aggregate count derived from the existing weekly `workout_*` activity records. The raw body-part keys and their records are never transmitted. The separate Gym app's `gym_*` stores, exercises, weights, sets, bodyweight/pain fields, and training assessments are never read by this feed. A workout-derived count uses the app's existing count meaning; it is not a count of sets, reps, or sessions.

No notes, descriptions, book reviews, authors, step names, reward/gold fields, archived music/location stores, OAuth tokens, credentials, or arbitrary localStorage fields are included. Names, titles, and routine labels are included deliberately; personal or health-related text contained in those names is not automatically detected or removed. This is not permission to add separate health-detail fields.

Currently active items retain their available historical records. Archived/deleted items are excluded from subsequent snapshots; local history is never purged. No explicit hidden/archive store is imported. If the final active item is removed, the client refuses an empty upload, leaving the last Drive snapshot intact until separately approved owner/admin cleanup. A pending operation retains its exact older snapshot until reconciled before a newer snapshot can be sent.

The payload is schema version **2**, at most **1 MiB UTF-8**, at most **100 items per category**, and at most **1,500 dated entries per item**. These bounds apply to the whole automatic feed; all-history data may exceed them. Oversized data stops with an explicit size-limit error rather than silently selecting a subset or truncating history. The HTTP/Drive envelope allows only 4 KiB additional overhead, and encrypted durable records are capped at 2 MiB and complete Redis commands at 4 MiB + 16 KiB. Legacy v1 outboxes retain their original 128 KiB inspection bound. When all definition stores are absent, the source is uninitialized and fails closed. Missing optional category/log stores are treated as empty when other valid definitions exist. Valid active definitions with zero progress can be included; a feed with zero active items is refused.

`asOf` and activity dates are local calendar dates (`YYYY-MM-DD`), and `timeZone` identifies the device's IANA timezone for the snapshot. `syncedAt` is a server UTC timestamp. Historical dates stay as recorded; changing timezone does not reinterpret old entries as instants. The Drive envelope retains version 1 (`schemaVersion`, `deviceId`, `revision`, `operationId`, `syncedAt`, `payload`), while its nested payload is version 2. The outer version describes the transport, not permission to use the former selected-item payload.

### Statistics and interpretation

Statistics have a fixed schema and are recomputed from the validated projected records. Client-supplied extra fields or fabricated totals are rejected. The feed includes explicit 30-day and 365-day observation windows and bounded record-based streak/rate definitions. It does **not** read the reward store, include gold, or apply the app's shield/freeze benefits. These values must not be presented as the reward-adjusted official UI streak.

For ordinary habits and routines, a missing record means **unrecorded**, not evidence that the activity did not happen. Achievement ratios describe the app's recorded data and schedule. Avoidance routines are a documented exception: their explicit logged days mean a lapse; the app treats other active calendar days as no recorded lapse. Consumers must retain that distinction and not describe an avoidance log as a completed positive routine. Creation dates and observation windows limit calculations; no pre-creation success is invented. Goal, unit, and frequency describe the current item settings, as in the app; the source does not retain a dated settings history. Historical targets or unit changes cannot be reconstructed, so consumers must not treat these settings as proof of which goal/unit applied on every past date.

### Consent migration from version 1

The category-wide policy is a new consent version. A v2 UI/client handshake also refuses mixed cached modules that still show the old selective-consent wording. Saved selected-item consent never enables version 2 automatically. A fresh preview and confirmation is required, and the backend requires a successful version-2 `enable` before accepting new automatic snapshots. Exact pending/applied operation identities can still be reconciled without widening consent. Newly added items and changed names then join the feed under the category-wide consent without repeated selection.

An old uncertain outbox is preserved byte-for-byte and blocks new uploads. It can be inspected, but this version does not send or rewrite version-1 payloads. Unexpected legacy pending state requires owner/admin review of the old operation and Drive state; there is no automatic discard, schema conversion, overwrite, or reset. Existing source records and full backup/export remain unchanged.

## Server configuration (placeholders only)

See `.env.example`. Use server-only secret configuration, never a browser bundle, repository file, `NEXT_PUBLIC_` setting, localStorage, query string, screenshot, chat, or logs.

| Variable | Required value |
| --- | --- |
| `PRIVATE_SYNC_ENABLED` | `1` only after explicit activation approval; otherwise absent or `0` |
| `PRIVATE_SYNC_APP_ORIGIN` | Exact HTTPS origin, e.g. `https://YOUR-APP.example`, no path or trailing slash |
| `PRIVATE_SYNC_GOOGLE_CLIENT_ID` | Owner-approved Google OAuth **Web application** client ID |
| `PRIVATE_SYNC_GOOGLE_CLIENT_SECRET` | Its server-side secret |
| `PRIVATE_SYNC_OWNER_SUB` | Exact Google account subject, established through a trusted verified identity source |
| `PRIVATE_SYNC_OWNER_EMAIL` | Exact owner's verified Google email (comparison is case-normalized) |
| `PRIVATE_SYNC_ENCRYPTION_KEY` | Base64 encoding of a securely generated 32-byte AES key, generated/configured by the owner through an approved secure flow |
| `UPSTASH_REDIS_REST_URL` | Approved HTTPS `*.upstash.io` database REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Approved database REST credential |
| `PRIVATE_SYNC_REDIS_PREFIX` | Optional namespace; default `weekly:private-sync` |

Do not put a token in an online JWT decoder to discover the subject. Confirm the subject through a trusted identity source or an owner-operated verification flow. Both subject and verified email are required, so possession of an email claim alone never admits a user.

Register this **exact authorized redirect URI**, substituting only the configured origin:

```text
https://YOUR-APP.example/api/private-sync?action=callback
```

Enable the Drive API in the separately approved Google project. Request only `openid`, `email`, and `https://www.googleapis.com/auth/drive.file`. This app does not request full-Drive access or `drive.appdata`. Leave deployment previews disabled; never give arbitrary preview origins access to production credentials or storage. Node 20 or newer is required. Allow enough serverless invocation duration for multiple bounded provider calls (60 seconds or more); individual provider requests time out after 12 seconds and Redis requests after 8 seconds. A timeout is safe to retry with the unchanged queued operation.

Separate apps/origins/owner/client combinations have separate derived Redis namespaces. Changing those identifiers or the namespace must not be used as an improvised recovery technique: it can orphan metadata or create a second file. AES-key rotation requires a planned decrypt/re-encrypt migration or an explicitly authorized reset. There is no in-memory or ephemeral-filesystem fallback. Lost/unavailable durable state or an invalid encryption key stops uploads.

## Authentication and session boundary

- Server-side authorization-code flow, offline access, random single-use state, PKCE S256, and nonce
- Signed RS256 ID token verification against Google's fixed HTTPS JWKS endpoint; issuer, audience, authorized party, expiration, nonce, exact owner subject/email, and `email_verified` checks
- Independent trusted Google userinfo verification using the access token in an Authorization header
- An opaque random `__Host-` cookie, `Secure; HttpOnly; SameSite=Lax; Path=/`, with no bearer OAuth tokens in JavaScript
- Authentication/session rotation after login; 30-day absolute authenticated session limit and 10-minute anonymous/OAuth state expiry
- Same-origin JSON POSTs and a session-bound `x-csrf-token` for **all** mutations, including connect and disconnect
- No wildcard CORS, body/query/error logging, raw upstream error details, or OAuth credentials in status responses
- The callback always redirects to the clean configured `/tracker.html`. A safe `authError` code in status explains failures without exposing the code/token/identity

All Redis record values, including access/refresh credentials, session/CSRF state, OAuth verifiers/nonces, and pending payloads, are AES-256-GCM encrypted with unique IVs and record-key-associated data. Session cookies are indexed by a one-way hash. Redis ciphertext CAS updates are atomic across serverless instances. Hosting/database administrators who hold both secrets and ciphertext remain a trust boundary; this is not end-to-end encryption from the host. Configure platform logging/redaction so callback authorization query codes are not captured by additional access logging or analytics.

Google's external OAuth consent screen in **Testing** normally issues refresh tokens that expire after **seven days** for this Drive scope. A fresh login will be required when they expire. Production publishing/verification and Workspace organization policy are separate setup decisions; this implementation does not change them. Google can also expire/revoke grants for other reasons. Treat `auth_required` as a reconnect/review condition.

## HTTP contract

All routes use `/api/private-sync?action=...`, no CORS exposure, and `Cache-Control: no-store`. The service worker excludes all `/api` and `/auth` routes from cache reads/writes, purges older private cache entries on activation, and refuses to cache private/no-store or redirected responses. Before any private API request, the client verifies a MessageChannel capability response from the controlling worker and the active page/API registrations; unknown/legacy workers fail closed with an update/reload message. This prevents the earlier cache-all worker from caching status or OAuth callbacks during rollout. A service-worker-capable browser must have the new active worker before connecting.

| Method/action | Input | Result |
| --- | --- | --- |
| GET `status` | Session cookie, if any | `configured`, `connected`, `csrfToken`, `enabled`, nullable `deviceId`, integer `revision`, nullable `lastSyncedAt`, nullable safe `authError`; creates an anonymous CSRF session if needed |
| POST `connect` | `{deviceId}` + CSRF | `{authorizationUrl}` for a top-level OAuth navigation |
| GET `callback` | Browser-bound single-use OAuth response | Rotated HttpOnly session and clean 303 redirect |
| POST `enable` | `{deviceId,baseRevision,operationId,payload}` + CSRF, after exact preview confirmation | Status after safely applying/reconciling the initial snapshot; enables future uploads |
| POST `upload` | Same input as enable + CSRF | Status after an acknowledged revision |
| POST `disconnect` | `{}` + CSRF | Disabled/disconnected status, expired session cookie |

`enable` and `upload` require a stable random operation ID and exact acknowledged base revision. A client must persist its operation ID, base revision, action, and exact sanitized payload **before** issuing either request. It may clear that queue only after an unambiguous acknowledgment or a specifically definitive non-application result. A new status response alone must never advance a queued operation's base revision or replace its contents.

Important error codes:

- `not_configured`, `store_unavailable`, `provider_unavailable`, `retry_later`: fail closed; retain the queue; transient failures may retry the same operation
- `auth_required`, `owner_forbidden`, `csrf_failed`, `origin_forbidden`: authenticate/review or fix setup; retain the queue
- `device_conflict`: this is not the registered writer; do not switch automatically
- `revision_conflict`, `operation_conflict`, `pending_operation`, `external_change`: stop automatic writes; preserve local data and pending operation
- `pending_disabled`: a pending operation exists but uploads are disabled and it has not yet been reconciled as accepted; keep it unchanged. A separately confirmed enable may retry the exact same operation/payload/base
- `sync_disabled`: no matching pending/applied operation exists and the submitted base equals the current revision; this particular operation was not applied. A queued operation at an older base instead gets `revision_conflict`
- `scope_review_required`: old consent does not authorize automatic v2 uploads; show a new global preview/consent without changing any pending operation
- `invalid_payload`, `invalid_request`: correct the source data/request; do not bypass validation or silently truncate

## Ordering, retry, and conflict safety

1. The server validates exact payload and device/base revision, then CAS-reserves the full pending operation in durable encrypted storage.
2. A Drive file ID is generated and persisted **before** initial creation. Retrying creation cannot create a duplicate: Google returns 409 for the reserved ID.
3. A read checks private-file metadata, content, and stable metadata ETag. For updates, the current ETag must equal the server's last accepted ETag, and the write carries `If-Match`.
4. Lost or ambiguous responses preserve the operation. An exact envelope match (`deviceId`, `revision`, `operationId`, `syncedAt`, and payload) lets a retry acknowledge an already accepted write instead of repeating it.
5. The final revision is committed through CAS. Competing operations cannot replace a reserved operation, and an old request cannot overwrite a later Drive revision.

Drive v2's explicit File `etag` is used for conditional updates; media is read through Drive v3. This choice is deliberate because v3 does not expose the v2 ETag field in its File JSON. If an ETag is unavailable or the conditional-write contract cannot be verified, the app stops rather than doing an unconditional write. Live conditional-write behavior still requires the separately approved integration test below.

An accepted operation can be acknowledged after reconnect while keeping uploads disabled. An unapplied/uncertain pending operation needs its exact saved preview and explicit enable to resume. A newly generated all-items snapshot cannot silently replace an uncertain old operation.

An external edit, sharing/move to a shared drive, deletion, missing durable state, or conflicting device/revision is **not automatically repaired**. There is no force-overwrite, automatic new-file creation, Drive-to-local merge, or reset button. Re-review/reconnect alone does not resolve an external-change block. Keep the local queue and Drive file untouched. The owner/admin must review the existing Drive version and durable pending operation, establish that old requests have finished, and approve a specific recovery/migration plan. Any adoption of external content, intentional overwrite, replacement file, namespace reset, or second device registration is outside this implementation and requires separate work/approval.

## Disconnect and limits

Disconnect disables future uploads, removes server-side OAuth credentials, invalidates authenticated sessions through a generation change, and expires the current cookie. It keeps the Drive file, registered-device/file/revision metadata, and any encrypted pending operation necessary to reconcile an ambiguous result. It does not delete local app records.

The app deliberately does not call Google's revoke endpoint: revocation can affect grants shared by other integrations of the same OAuth client. The owner can separately remove the grant in [Google Account connections](https://myaccount.google.com/connections). A Drive request already in flight when disconnect happens may finish; no transaction can atomically cancel an already-sent request across Google and Redis. Such a request cannot restore removed credentials or reactivate the session.

Safe cross-tab outbox coordination requires Web Locks in a modern secure-context browser. If that API is unavailable, sync fails closed with an update-browser message; ordinary local records and export remain usable. `wt_private_sync_v1` retains its storage key for cross-version locking but now stores version-2 category-consent/outbox metadata. `wt_private_sync_stop_v1` is a separate atomic stop marker, so a late response or another tab cannot undo an opt-out. Neither key stores OAuth/session tokens or CSRF tokens. Disconnect retains uncertain client outbox contents until explicitly reviewed recovery; it does not silently replace them with a new operation.

The client can upload while the PWA is open, after local edits, on an online event, or when it returns to the foreground. **There is no guarantee of synchronization while an iPhone is locked or the PWA is closed.** Background delivery and timing depend on iOS/browser behavior. The local queue remains the source for retries. Offline app use must continue normally.

The ordinary private My Drive JSON is intended to be readable later by the owner's separately connected Drive integration. It does not itself authorize an assistant to continuously read, monitor, or act on this data. Connector visibility, indexing delay, JSON readability, and any follow-up workflow still need separate owner-approved checks. No public sharing is needed or permitted as a workaround.

## Verification

Synthetic tests, requiring no network, accounts, credentials or resources:

```sh
node --test tests/private-sync-server.test.mjs tests/private-sync*.test.mjs
node --test tests/*.test.mjs
```

The server tests cover encrypted CAS, mandatory configuration/CSRF/origin, browser-bound one-use state, owner/device rejection, expiration/revocation, strict payload rejection, revision and operation idempotency, durable recovery after lost creation/update ACK, competing requests, external edits/deletion, disconnect/reconnect, Google ID-token signature/claim checks with synthetic keys, private file metadata, and conditional-write request construction.

Client/protocol tests cover all four categories, future additions/renames, date/timezone rollover, legacy consent/outbox preservation, mixed-cache rejection, exclusion canaries, recomputed statistics, and larger bounded history. A small DOM adapter executes the real settings module to check category counts, the single global consent checkbox, text-only exact JSON preview, and cancellation of late OAuth navigation. It is not a real-browser rendering, layout, accessibility, or iPhone test. Service-worker tests separately verify private API/auth cache exclusion and the complete offline module graph.

Before activation, a separately authorized E2E review must still verify:

1. Actual Vercel function tracing/runtime/duration, encrypted durable store access, and verified platform request-rate/abuse protection and budget/quota alerts, especially for anonymous session creation
2. Actual Google consent, owner identity, refresh behavior, and wrong-account denial
3. Private My Drive creation with the reserved ID; true v2 ETag `If-Match` refusal after an external edit; no duplicate after simulated lost response
4. iPhone home-screen PWA OAuth round trip, Secure cookie persistence, foreground/offline/online retry, reopen after lost ACK, and repeated/interrupting clicks
5. Category-wide preview; new and renamed items included; notes, detailed gym and other excluded fields absent from Drive bytes; statistics agree with the documented record-based definitions
6. Disconnect while requests are idle and in flight, existing file retention, no credential resurrection
7. Owner's Drive connector finding and reading the exact private JSON without publishing/sharing it

No live user-data or production E2E test is claimed by the mocked suite.

## Primary references

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OpenID Connect validation](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Drive pre-generated IDs and retry behavior](https://developers.google.com/workspace/drive/api/guides/create-file)
- [Drive v2 File ETag](https://developers.google.com/workspace/drive/api/reference/rest/v2/files)
- [Drive v2 private file insertion](https://developers.google.com/workspace/drive/api/reference/rest/v2/files/insert)
- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi)
