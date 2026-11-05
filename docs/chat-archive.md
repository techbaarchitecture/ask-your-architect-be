# Optional architecture-chat archive (NocoBase Dev)

The backend can archive **only accepted guest architecture questions with a fully successful AI reply**. Refusals, malformed/failed classifiers, provider failures, invalid requests, and admin provider tests are excluded. Existing scope enforcement, quota limits, authentication and provider SDK behavior are unchanged.

## Deployment target and collection management

The configured environment is **NocoBase Dev**, `https://dev.baarchitecture.cloud`; UAT, Production and local NocoBase are not modified. The secret-free [collection manifest](nocobase-chat-collection.json) reproduces the new schema. Apply it with an authorized schema administrator, not the runtime archive token.

The runtime service has dedicated role `r_aya_chat_ingest` with only collection-scoped create/view permissions (NocoBase `view` covers list/read). Anonymous access is denied; its key cannot read Leads, Contracts, Q&A or Users. Credentials remain in the protected backend environment, never this repository.

In the native NocoBase UI: **Settings → Data sources → Main → Configure → Collections → Ask Your Architect — Chat History → Configure fields**. The direct collections route is `/admin/settings/data-source-manager/main/collections?type=main`. No CRM menus, pages, flowModels or existing workflows are changed. A separate staff table page can be configured with the native UI Builder when requested.

## Setup

1. Create the NocoBase Dev collection `aya_architecture_chats` before enabling the integration. Add these writable fields:

   | Field         | Type / meaning                                                                                            |
   | ------------- | --------------------------------------------------------------------------------------------------------- |
   | `event_id`    | String, required, **unique database constraint/index**; server UUID v4                                    |
   | `visitor_id`  | String; existing server SHA-256 hash of the device ID, not the raw ID                                     |
   | `question`    | Long text; latest validated user message only, not conversation history                                   |
   | `answer`      | Long text; complete markdown response, no truncation                                                      |
   | `asked_at`    | Date/time; UTC ISO timestamp when the backend receives the chat request, before classification/generation |
   | `answered_at` | Date/time; UTC ISO timestamp after successful answer generation                                           |
   | `provider`    | String; provider selected for that request                                                                |
   | `model`       | String; model selected for that request                                                                   |

   Keep NocoBase's built-in `createdAt`: it is the **remote synchronization time**, not the original question or answer time. Delayed/retried synchronization must not replace `asked_at` / `answered_at`.

2. Create a backend-only API token restricted to **list and create** on this collection, including reading/filtering `event_id` and writing the listed fields. A unique remote `event_id` constraint is required for idempotency under concurrent workers or uncertain acknowledgements. A UI-only duplicate check is not sufficient.

3. Privately add both settings to the backend environment (never the frontend, public settings, source code, shell output or chat):

   ```dotenv
   NOCOBASE_API_URL=https://dev.baarchitecture.cloud/api
   NOCOBASE_API_TOKEN=<privately supplied API token>
   # Optional; this is the default:
   NOCOBASE_CHAT_COLLECTION=aya_architecture_chats
   ```

   Leave **both URL and token unset/empty** to keep archiving disabled. A partial configuration fails startup with a sanitized error. Collection alone does not enable archiving. The `.env.example` entries are commented out so fresh setup remains opt-in. Production credentials are managed privately by the operator; automated tests use isolated databases and fixtures.

4. After provisioning/configuration, build and restart the backend through the normal operator workflow. Submit a real accepted architecture question and verify the corresponding remote row using `event_id`, original UTC timestamps and full markdown. Separately check refusal/admin-test exclusion. Remote provisioning, real credentials and live UI verification are intentionally separate operator tasks.

## Delivery and recovery

- Before returning a successful guest reply, the backend synchronously inserts the complete event into `architecture_chat_outbox` in the **same SQLite database** as settings/quota. Failure of this durable local write cannot produce an unarchived success; it follows the sanitized 502/refund path.
- The chat handler never awaits NocoBase. A single-flight background worker checks the queue every **5 seconds**, processing at most **20 events per flush**, sequentially. Its timer is unreferenced and is stopped by `createApp.close()`; shutdown also aborts an active HTTP request before closing SQLite. Closing is repeatable.
- Each HTTP request has a **5-second deadline covering headers and response body**. Redirects are refused. HTTP/network/auth/schema errors retain queued data, log only a fixed sanitized warning, and retry on a later tick. A failing event ends that batch, preventing an outage from generating a burst of requests. No question, answer, token or remote URL is logged.
- Every attempt first calls `GET /aya_architecture_chats:list?filter={"event_id":{"$eq":"<uuid>"}}&pageSize=1` (URL-encoded query). An existing exact `event_id` means the event is already delivered. Otherwise it sends the event JSON to `POST /aya_architecture_chats:create`.
- After **every** create outcome, including duplicate/conflict, network failure, or unclear success, the worker queries the same ID again. It removes the local event **only after a remote read confirms that exact ID**. An unconfirmed create stays queued. A restart retries the original UUID/payload, rather than making a new event. Do not delete pending rows to clear warnings.
- Queue contents persist across restarts. Disabling archiving preserves an existing queue but pauses its delivery; enabling it again resumes delivery. There is no automatic expiration or destructive retry limit. During a sustained outage, monitor local disk usage and fix the remote access/schema issue.
- The outbox contains plaintext accepted questions and answers until acknowledged; protect SQLite, WAL files and backups as sensitive data. Existing encrypted provider-key handling is unchanged. Successfully synchronized events are removed from the outbox but remain in NocoBase (and may remain in backups/SQLite free pages). Apply the intended access controls and retention policy to both systems.

## Configuration boundaries

Archive settings are server-only and never returned through public config or admin editable settings. The URL must be HTTPS with no credentials, query or fragment. The collection must match `[A-Za-z_][A-Za-z0-9_]{0,99}`. HTTP is allowed only for exact loopback hosts in explicitly opted-in **programmatic test options** (`allowLoopbackHttp`); there is no environment flag enabling archive HTTP. `ALLOW_PRIVATE_PROVIDER` does not relax archive validation.

Programmatic `createApp({ archive: ... })` options also support bounded test overrides: `intervalMs` (10–300000), `timeoutMs` (10–30000), and `batchSize` (1–100). `runtime.flushArchive()` allows deterministic operator/test flushing without changing the public HTTP API. Tests default to no archive; archive tests use isolated databases and loopback fixtures, not NocoBase Dev.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

The archive tests cover exact fields, UUID/device hashing, latest question/full markdown, timestamp boundaries, exclusions, nonblocking outage behavior, durable restart/recovery, preexisting IDs, duplicate/conflict and lost/unknown acknowledgements, false success, failed local enqueue, bounded single-flight batches, automatic timer delivery, headers/body deadlines, redirect refusal, sanitized logs, app/worker shutdown safety, and opt-in server environment wiring/validation.
