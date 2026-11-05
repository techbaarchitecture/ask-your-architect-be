# BA Architecture API

Independent private repository: `hoangpham17/ask-your-architect-be`.
Frontend repository: `hoangpham17/ask-your-architect-fe`.
Clone as sibling `BE` and `FE` directories to run the frontend's optional browser integration test.

Local-first TypeScript / Express backend, Node **24+** and persistent SQLite (`node:sqlite`). Default listener: **127.0.0.1:4100**. No provider key is seeded and no live AI calls are made until an administrator supplies one.

## Run locally

```sh
cd BE
npm ci
npm run setup
npm run build
npm start
# Development alternative: npm run dev
```

`setup` generates a random admin email/password and AES-256 encryption key in **BE/.env**, mode **0600**, without printing the password. It is idempotent: rerunning does not overwrite credentials. Read the password locally in your editor, never commit/share `.env`. The admin record is seeded **once** into SQLite; changing env credentials later does not overwrite the existing account. `ENV_FILE` selects an alternate env file. Keep `.env` and database backups protected together; loss/change of `ENCRYPTION_KEY` makes saved provider keys unreadable.

Default company name is BA Architecture; company URL is intentionally blank. Sign into the frontend admin and save the actual provider/model/base URL/API key. Settings `apiKey` omitted or blank preserves the existing key. Public `configured` indicates a saved key, not proof that the provider accepts it; use admin Test Connection to verify.

## Frontend contract

All endpoints return JSON. Public reads are limited to 120 requests/minute/IP; chat JSON and SSE share 10 requests/minute/IP; admin to 60/minute/IP; login to 10 attempts/15 minutes/IP. Health is not rate limited. Chat also allows at most 2 in-flight provider jobs per IP and 8 process-wide (`CHAT_MAX_CONCURRENT_PER_IP` / `CHAT_MAX_CONCURRENT`). Rate-limit 429 responses include `Retry-After`. JSON request cap: 64 KiB.

| Endpoint | Input / result |
| --- | --- |
| `GET /api/health` | `{ok:true}` |
| `GET /api/public/config` | `{companyName,companyUrl,welcomeText,disclaimer,questionLimit,configured}` |
| `GET /api/public/usage` | `X-Device-Id` header required; `{used,limit,remaining}` |
| `POST /api/chat` | `{messages:[{role:"user"\|"assistant",content}],deviceId}`; `{reply,usage:{used,limit,remaining}}` |
| `POST /api/admin/login` | `{email,password}`; `{token}` |
| `POST /api/admin/logout` | Bearer auth; revokes the current token; `{ok:true}` |
| `GET /api/admin/settings` | Bearer auth; all settings plus `apiKeyConfigured`, masked `apiKeyHint`, never key/ciphertext |
| `PUT /api/admin/settings` | Bearer auth; full editable settings plus optional `apiKey`; returns safe settings |
| `POST /api/admin/test` | Bearer auth; `{provider,model,baseUrl,apiKey?}`; `{ok,message,model?}` |

Chat accepts `X-Device-Id` instead of body `deviceId`; if both exist they must match. Device IDs: 1–200 characters, letters/digits/`_ . : -`. Messages: 1–50, each 1–16,000 characters, last message must be user. System-role input is prohibited; the administrator's server-side system prompt is authoritative.

Default **3 questions/device**, across new chats and server restarts. A single atomic SQLite upsert reserves quota before calling the provider, so simultaneous requests cannot exceed the limit. All provider/network/parse errors refund that reservation. Exhaustion returns **429** `{error,code:"QUOTA_EXCEEDED"}`; missing provider key returns **503** `{error}`; upstream failures return sanitized **502** errors. Rate-limit 429 responses use `code:"RATE_LIMITED"`.

Editable settings: `provider`, `model`, `baseUrl`, `systemPrompt`, `temperature` (0–2), `maxTokens` (1–32768), `questionLimit` (1–10000), `welcomeText`, `companyName`, `companyUrl`, `disclaimer`, and write-only optional `apiKey`. Set provider-compatible sampling/token limits for the actual model. Connection test uses supplied draft credentials (blank/omitted key uses stored key), does **not save drafts**, does not consume device quota, and performs a real minimal provider request that may incur a small charge.

## Provider integrations

| `provider` | Example base URL | API |
| --- | --- | --- |
| `openai` / `openai-compatible` | `https://api.openai.com/v1` | `/chat/completions`, Bearer token |
| `anthropic` | `https://api.anthropic.com/v1` | `/messages`, `x-api-key` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:generateContent`, `x-goog-api-key` |

Base URL must include the API version path, not the completion endpoint. Provider calls use a 60-second deadline, 1 MiB response cap, and never follow redirects.

`openai-compatible` uses the open-source Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`) with streaming enabled. The SDK assembles SSE chunks into the final text; the FE still receives the same `{reply, usage}` JSON contract. Its custom fetch retains validated/pinned DNS, no redirects, response-size bounds, and zero automatic retries. Stream errors, including errors after partial output, are failures and refund quota. The native OpenAI, Anthropic, and Gemini integrations retain their existing JSON paths.

Automated tests use local HTTP/SSE fixtures. Separately, real-browser UI verification with the user-supplied provider passed on both localhost and the deployed frontend: admin connection test, save/reload without key disclosure, three real multi-turn guest replies retaining context, exhaustion, new-chat and reload quota retention. Real credentials remain only in ignored local config / encrypted SQLite.

## Architecture-only scope

Every guest chat passes a server-side model-assisted scope check before an answer is generated. Allowed topics cover physical architecture/design, construction/renovation, interiors, materials, building systems, sustainability, landscaping, accessibility, project budgets/schedules and building permits. Software architecture and unrelated coding, investment, recipes, politics and unrelated requests are rejected. The classifier uses bounded conversation context for short architectural follow-ups; adding an architecture keyword does not make a mixed/off-topic request valid.

Refusals return HTTP 200 with `{reply, usage, blocked:true, code:"OFF_TOPIC"}` and refund the reserved consultation question. Classifier errors/invalid decisions fail closed using the existing sanitized 502/refund path. The classifier plus answer share a 60-second deadline. Classification can incur provider usage even when the visitor's three-question allowance is not charged. Public IP rate limits still apply. The final answering system prompt includes a server-owned scope policy in addition to the administrator's studio instructions; admin connection tests remain simple provider health tests.

This is a model-assisted relevance filter, not a guarantee against every possible adversarial prompt. Keep regression examples for multilingual off-topic requests, mixed topics, role-override attempts, relevant questions and contextual follow-ups.

## Security and persistence

- Admin password is salted/scrypt hashed; password comparison is timing-safe. Random opaque sessions expire after 8 hours; only SHA-256 token hashes are persisted. Logout revokes the token immediately, including after restart.
- API keys use AES-256-GCM encryption with a random IV and authentication tag, keyed by `ENCRYPTION_KEY`. Key hints are masked only. Neither upstream raw error bodies nor credentials are exposed in responses/logs.
- SQLite stores settings, admin hash, hashed sessions, and hashed device quota counters. With the optional archive disabled (default), conversations are not stored. When enabled, successful accepted architecture question/answer events are durably queued in the same database until NocoBase confirms delivery. Protect the plaintext outbox and backups as sensitive data. Process umask is 0077; the data directory is created with mode 0700.
- Helmet headers, request IDs (`X-Request-Id`), and exact-origin CORS. Default `ALLOWED_ORIGINS=http://localhost:5178`; append the deployed frontend origin comma-separated when needed. No wildcard. No-origin requests remain available for local tools. Access logs are one JSON object per request (`requestId`, method, path without query, status, latency, IP) and never include bodies, tokens, or keys. `/api/health` is not logged.
- Do not set `TRUST_PROXY=true`. Leave it `false` for a process that clients hit directly. When nginx (or another local reverse proxy) is the **only** way to reach the listener, set `TRUST_PROXY=1` so rate limits use `CF-Connecting-IP` then `X-Forwarded-For` from that hop. Keep `HOST=127.0.0.1` (or publish the container on loopback only). The proxy must overwrite client-supplied forwarded headers; otherwise spoofed IPs bypass limits. Device IDs are never used as the rate-limit key.
- Provider URLs are admin-only. HTTPS is required by default. DNS is validated and pinned per request to stop private-address access and DNS rebinding. Loopback/private networks require explicit `ALLOW_PRIVATE_PROVIDER=true` (trusted local 9router); metadata/link-local/reserved addresses remain prohibited. Never expose a trusted private provider to untrusted admins.
- Device IDs are client-controlled: this is a persistent **device quota, not identity/account enforcement**. Clearing/changing the ID can bypass it. IP rate limits are in memory and reset on restart; quotas/sessions do not. Use authenticated users/shared rate storage before operating a public multi-instance service. Guest disconnects abort the in-flight provider call and refund the reserved question.
- A process crash after reservation may conservatively leave a question counted; graceful shutdown waits for outstanding requests. The optional archive retries completed, durably queued events, not unfinished provider requests.

## Optional NocoBase architecture-chat archive

See [archive setup and delivery guarantees](docs/chat-archive.md) before enabling backend-only `NOCOBASE_API_URL` / `NOCOBASE_API_TOKEN` (optional `NOCOBASE_CHAT_COLLECTION`, default `aya_architecture_chats`). Provision the collection with a unique `event_id` constraint and restricted list/create token first. Accepted guest questions with successful replies are durably queued before success and synchronized in the background; refusals, classifier/provider errors and admin tests are excluded. Remote outages never block the chat response. `asked_at` / `answered_at` preserve original UTC event times; NocoBase `createdAt` records sync time. No frontend/API contract change is required.

## Verification

```sh
npm test
npm run typecheck   # src, scripts, tests
npm run build
```

Tests exercise real HTTP app listeners and local provider fixtures: defaults, encrypted settings, draft provider credentials across all integrations, concurrent quota enforcement, restart persistence, refunds, login/logout, bearer format, request validation/body cap, exact CORS, rate limits, SSRF denial, upstream deadline/response cap, setup credential protection, and actual server startup/shutdown. Each vertical feature was developed by observing its failing test before implementation.

## Optional Docker

```sh
docker build -t ba-architecture-api .
docker run --rm --env-file .env -e HOST=0.0.0.0 \
  -p 127.0.0.1:4100:4100 -v ba-api-data:/app/data ba-architecture-api
```

Container runs as non-root and persists SQLite in `/app/data`. `-e HOST=0.0.0.0` deliberately overrides the local `.env` host inside the container; publishing remains loopback-only. Docker is optional; the primary verified runtime is local Node 24.
