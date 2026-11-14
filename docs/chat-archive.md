# Architecture-chat archive and scope review

Both accepted guest answers and scope-blocked refusals are durably archived when the optional server-side integration is enabled. Malformed/failed classifiers, provider failures, invalid requests and admin provider tests do not create exchanges. Classifier instructions, allowed scope, configured providers, settings and quota rules are unchanged.

## Environment boundary

- AYA Dev (`dev.askyourarchitect.org`) → NocoBase Dev (`https://dev.baarchitecture.cloud/api`).
- AYA production (`askyourarchitect.org`) → NocoBase CRM (`https://crm.baarchitecture.cloud/api`).
- Each environment uses its own `aya_architecture_chats` collection and private ingestion key. Never cross-wire environments or copy live .env/SQLite into Git.
- The dedicated runtime role `r_aya_chat_ingest` has create/view access only to this collection, not update/delete, settings or other CRM collections. Schema administration and human review use separate authorized staff sessions.

## Provision before backend release

1. Back up the target database. Create the base collection using [nocobase-chat-collection.json](nocobase-chat-collection.json). Preserve the database-enforced unique `event_id` constraint.
2. Apply each entry of [archive-review-fields.json](archive-review-fields.json) using native `fields:apply` / `nb api data-modeling fields apply --body-file <single-field.json> -e <target> -y`. The file is an array of seven additive field payloads, not a collection-create body. Use a schema administrator; do not expand ingestion privileges. Select enums require their preset colors. Read back field definitions and visible enum labels.
3. Ensure ingestion create/view permissions cover all fields below. Configure backend-only `NOCOBASE_API_URL`, `NOCOBASE_API_TOKEN` and optional `NOCOBASE_CHAT_COLLECTION` (default `aya_architecture_chats`) privately. Both URL/token unset disables archiving; a partial configuration fails startup. Credentials never belong in FE/public settings.
4. Deploy to Dev, verify both API modes through UI/API plus exact CRM readback, then promote through a Dev→main PR. Apply the same additive schema on production before its backend release. Rollback may restore the prior backend while retaining additive fields and records; do not drop audit data or clear the outbox.

| Field | Meaning |
|---|---|
| `event_id` | Unique server UUID, stable across delivery retries |
| `visitor_id` | SHA-256 browser device identifier, never raw device ID/IP |
| `question`, `answer` | Latest validated question and full answer/refusal; Markdown preserved |
| `asked_at`, `answered_at` | Original server UTC event timestamps, not delivery time |
| `provider`, `model` | Configuration used for that request's scope/answer calls |
| `outcome` | `accepted` or `blocked` |
| `scope_decision` | Actual `ALLOW`, `BLOCK_EN` or `BLOCK_VI` |
| `scope_policy_version` | `sha256:<64 hex>` of the exact classifier instruction text |
| `block_code` | `OFF_TOPIC` for blocked; empty for accepted |
| `scope_context` | JSON string of exactly the classifier's prior context: last eight messages, each content bounded to 1,600 characters |
| `review_status` | Accepted: `not_required`; blocked: `pending`; human review: `correctly_blocked` / `false_positive` |
| `review_notes` | Initially empty; staff-owned notes |

Built-in `createdAt` means remote synchronization time. New events explicitly populate every audit field. Legacy queued payloads remain unchanged and may have unknown classifier/version/context; do not invent historical decisions. Base archive records were accepted exchanges; the metadata default outcome is accepted and review is not_required. Blank legacy classifier/version/context remains unknown. No historical blocked questions can be reconstructed from an archive that did not collect them.

## Delivery, refunds and idempotency

- Before a successful answer/refusal, insert the complete event into `architecture_chat_outbox` in the same SQLite database as settings/quota. Blocked enqueue happens before refund. Local enqueue failure returns a sanitized error and refunds the one reservation exactly once, preserving prior usage.
- Blocked exchanges still cost zero consultation questions. Classification itself may incur provider usage. FE retains refusals locally but excludes blocked pairs from later AI context. Archiving/review does not automatically widen scope or change prompts.
- NocoBase delivery is asynchronous: default tick 5 seconds, at most 20 events per flush, one flight, sequential requests, 5-second header/body deadline. Remote downtime preserves the durable event without failing a successfully queued guest response. Redirects are refused; errors emit only a fixed sanitized warning.
- Each delivery queries `event_id` before create and reads back after every create outcome, including duplicates, network failures and lost acknowledgements. Remove a local event only after all immutable fields present in its original payload match; timestamp-equivalent ISO forms are accepted. Legacy payloads are compared only on fields they contained.
- Review status/notes are deliberately excluded from immutable confirmation. The worker never updates remote records and cannot overwrite a staff review. Conflicting immutable data retains the event, stops that flush batch and requires operator investigation; do not delete the queue to silence warnings.
- Pending events survive backend restarts. Disabling the archive pauses delivery without deleting the queue. No automatic expiry or destructive retry limit exists; monitor disk space during sustained outages.
- SQLite/WAL, the queue, scope context, remote archive and backups contain sensitive plaintext guest conversations. Apply access and retention controls. A crash after quota reservation can conservatively leave usage counted; the archive retries completed events, not unfinished provider calls.

## Native review UI

Use the existing **Ask Your Architect - Chat History** page (`/admin/yjqkv4v6k4k`) and native UI Builder, never DB-created flowModels. Show Scope outcome and Scope review in the table. In View details include the original question/answer and audit fields. Provide an Edit form containing only Scope review and Review notes so staff do not accidentally edit machine audit fields. Label `false_positive` as **Blocked by mistake**; `correctly_blocked` as **Correctly blocked**. Review is evidence for a later explicit policy change, not automatic training or scope expansion.

## Security and verification

Archive URLs require HTTPS without embedded credentials/query/fragment; collection names match `[A-Za-z_][A-Za-z0-9_]{0,99}`. Programmatic tests may explicitly allow exact loopback HTTP; there is no environment flag weakening production archive URL validation. `ALLOW_PRIVATE_PROVIDER` does not relax archive validation. Archive configuration is not returned by public/admin editable settings.

Run `npm test && npm run typecheck && npm run build`, deployment-probe tests, and production dependency audit. Tests use isolated databases/HTTP fixtures, covering both languages and API modes, exact metadata/context, legacy/review-safe idempotency, restart/outage/recovery, lost/false acknowledgements, immutable conflicts, enqueue failure with prior usage, streaming done ordering, exclusions, auth/security and shutdown. They do not replace live schema/provider/UI verification on Dev and production. Preserve attributable E2E rows for review.
