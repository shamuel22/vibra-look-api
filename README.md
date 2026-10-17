# vibralook-api

Backend for **VIBRA LOOK** — turns a feeling ("jazz on a rooftop, elegant but not overdone") into three makeup looks rendered on the person's own selfie with the **YouCam AI Makeup Virtual Try-On API** (Perfect Corp).

The language model **interprets**; deterministic code **decides** what reaches YouCam:

```
selfie ──► checked, kept in memory ──► private upload to YouCam with the first render (once per session)
vibe ────► DeepSeek (forced tool, per-request schema) ──► validation ──► 1 retry ──► editorial fallback
recipe ──► validator (constraints, kit, shade library) ──► compiler ──► whitelist gate ──► YouCam task
                                                                                      └► poll ──► stream image to the app
```

- The YouCam and DeepSeek keys live only on the server and are never logged.
- A look that breaks a rule is rejected **before** any unit is spent.
- Features are never altered: `skin_smooth` 0/0, original lip line, no plumping.
- No database: sessions are in memory and expire. The selfie only reaches YouCam together with a task, so closing a session (or its expiry, or shutdown) deletes the tasks **and** the uploaded photo; failed deletions are retried. Images are streamed from YouCam to the app with the session token; the API never publishes them on open URLs.

## Requirements

- Node.js ≥ 22 and pnpm (`corepack enable` picks the pinned version)
- A YouCam API key (v2.0) from the [API console](https://yce.makeupar.com/api-console/en/api-keys/)
- A DeepSeek API key (optional: without it, every translation uses the labelled editorial recipes)

## Run

```bash
pnpm install
cp .env.example .env      # fill YOUCAM_API_KEY and DEEPSEEK_API_KEY
pnpm build
pnpm start                # listens on $PORT (default 3000)
curl localhost:3000/health
```

## Environment

| Variable | Default | |
| --- | --- | --- |
| `YOUCAM_API_KEY` | — (required) | YouCam v2.0 API key |
| `YOUCAM_BASE_URL` | `https://yce-api-01.makeupar.com` | |
| `DEEPSEEK_API_KEY` | — | Vibe translation; without it, editorial recipes only |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic-compatible endpoint |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek-V4.1-Flash |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` behind nginx so the port is not reachable directly |
| `SESSION_TTL_MINUTES` | `30` | Idle lifetime (hard cap 100 min) |
| `MAX_RENDERS_PER_SESSION` | `12` | YouCam tasks per session (3 looks + edits + retries) |
| `MAX_SESSIONS` | `200` | Concurrent sessions in memory |
| `DAILY_RENDER_LIMIT` | `300` | YouCam tasks per UTC day, all sessions (resets on restart) |
| `DAILY_LLM_LIMIT` | `3000` | Model calls per UTC day; beyond it translations use editorial recipes |
| `TRUST_PROXY` | `0` | Set `1` behind nginx so rate limits see client IPs |

The process refuses to start if a required variable is missing or malformed; values are never printed.

## HTTP API

All routes except `POST /v1/sessions` require `Authorization: Bearer <token>`. Errors use one envelope:

```json
{ "error": { "code": "look_rejected", "message": "…", "retriable": false, "details": [ … ] } }
```

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /v1/sessions` | — | `{ sessionId, token, expiresAt }` |
| `PUT /v1/sessions/:id/selfie` | raw `image/jpeg` or `image/png`, ≤ 8 MB, sides 400–1919 px (read only after auth) | `{ status: "valid" }` · 422/413/415 `invalid_image` with `details.issue` (`tooSmall`, `unsupported`) · 409 `selfie_exists` |
| `POST /v1/sessions/:id/looks` | `{ intent, constraints, kit, locale }` | `{ variants: LookRecipe[3] }` (whisper, balance, statement; `origin` `model` or `editorial`) |
| `POST /v1/sessions/:id/describe` | `{ recipe, intent, constraints, kit, locale }` | `{ tagline, explanation, steps }` for an edited recipe |
| `POST /v1/sessions/:id/renders` | `{ recipe, constraints, kit }` | 202 `{ recipeId, status }` · 422 `look_rejected` · 429 `limit` |
| `GET /v1/sessions/:id/renders/:recipeId` | — | `{ recipeId, status: pending\|processing\|success\|error, error?: { code, retriable } }` |
| `GET /v1/sessions/:id/renders/:recipeId/image` | — | `image/jpeg` (streamed from YouCam, `no-store`) |
| `DELETE /v1/sessions/:id` | — | 204; YouCam tasks and the uploaded selfie are deleted |
| `GET /health` | — | `{ status: "ok" }` (never calls YouCam) |

Render error codes: `noFace` (no usable face — new photo), `provider`, `timeout`, `network`, `limit`. A render of the same recipe in the same session is started once and reused (cache key: selfie + recipe id, a 53-bit hash of the render fields). `looks` and `describe` need the selfie first and are capped per session (6 translations, 40 text rewrites); the model is cancelled if the app disconnects. Rate limits per client IP: 20 sessions / 10 min, 10 translations / min, 30 renders / min, 300 requests / min overall.

The `LookRecipe`, `Kit`, `Constraint` and `UserIntent` shapes are the app's own domain types (see *Shared contracts*).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm build` / `pnpm start` | Compile to `dist/` / run it (reads `.env` if present) |
| `pnpm start:dev` | Watch mode |
| `pnpm test` | Contract sync check + unit tests (no network, no units spent) |
| `pnpm lint` / `pnpm typecheck` | oxlint (type-aware) / tsc |
| `pnpm contracts:sync` | Copy the app's domain model (`../src/domain`) into `src/contracts/domain/` |
| `pnpm try:translate ["vibe"] [es\|en]` | Real translation with the model (no YouCam units); without a vibe, the brief's three examples |
| `pnpm smoke:youcam <image.jpg> [outDir] [variants]` | Renders the sample looks (every finish) through the real pipeline. **Costs 1 unit per look.** |

## Deploy (VPS)

```bash
# on the server, as a non-root user, in /opt/vibralook-api
git clone https://github.com/shamuel22/vibra-look-api.git /opt/vibralook-api
cd /opt/vibralook-api
corepack enable && pnpm install --frozen-lockfile
cp .env.example .env && chmod 600 .env   # fill the keys, HOST=127.0.0.1, TRUST_PROXY=1
pnpm build

sudo cp deploy/vibralook-api.service /etc/systemd/system/   # adjust User / paths
sudo systemctl daemon-reload && sudo systemctl enable --now vibralook-api

sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/vibralook-api   # set your domain
sudo ln -s /etc/nginx/sites-available/vibralook-api /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.example.com && sudo systemctl reload nginx
curl https://api.example.com/health
```

PM2 alternative: `pm2 start ecosystem.config.cjs && pm2 save`. Run **one** process (sessions live in memory). Update: `git pull && pnpm install --frozen-lockfile && pnpm build && sudo systemctl restart vibralook-api` (a restart ends active sessions; the app reopens one transparently).

Then build the app with `EXPO_PUBLIC_API_URL=https://api.example.com` (HTTPS is required by release builds).

## Operations

- Logs: one line per request (`POST /v1/sessions/:id/looks 200 6012ms`) without ids, tokens, bodies or IPs; model calls log latency and token counts, never prompts or answers.
- On start the API logs the remaining YouCam units and warns below 50. Each successful render costs 1 unit; a typical session uses 4–6.
- `DAILY_RENDER_LIMIT`, `MAX_RENDERS_PER_SESSION` and `DAILY_LLM_LIMIT` protect the balances; raise them deliberately. Counters live in memory and reset on restart.
- Shutdown (SIGTERM) closes every session: in-flight task creations are awaited (≤ 15 s) and all tasks deleted.

## Shared contracts

`src/contracts/domain/` is a generated copy of the app's pure domain model (types, shade library, constraint rules, recipe ids). Edit it **in the app repo** and run `pnpm contracts:sync`; `pnpm test` fails if the copy is stale (the check is skipped when the app repo is not next to the API, e.g. on the server). `src/contracts/wire.ts` holds the zod schemas for untrusted input and a compile-time assertion that they match the domain types.

## Vibe translation

`translation/` — DeepSeek through its Anthropic-compatible Messages API with the official Anthropic SDK (`baseURL` = `DEEPSEEK_BASE_URL`). The output is forced through a tool whose JSON Schema is built **per request** from the person's constraints and kit (only allowed shades, finishes and maximum intensities). Thinking is disabled because DeepSeek rejects a forced tool choice in thinking mode. The answer is checked again (kit finishes, one step per zone, no other products, no percentages or intensity numbers, distinct looks, growing intensity); one retry carries the problems back to the model; then labelled editorial recipes (`origin: "editorial"`) take over. `describe` rewrites the text of an edited recipe the same way, falling back to deterministic template text.

## Look compiler

`compileLook(recipe, { constraints, kit })` → whitelisted YouCam effects, deterministically:

1. **Validate** (`looks/look.validator.ts`): shape (strict, unknown fields rejected), shade library and zone, finish per zone, at least one zone, recipe id, the person's constraints and declared kit (the app's own rules). Any problem → `LookRejectedError`; nothing is sent and no unit is spent.
2. **Map**: intensity 1–5 → `colorIntensity` 25/40/55/70/85; finishes → textures (eyes matte / satin = low shimmer / metallic; cheeks matte / satin glow / luminous shimmer; lips matte / satin / gloss). One lid wash (`1color1`) for eyes, `1color1` blush.
3. **Gate** (`looks/whitelist.ts`): the output must match the exact allowed effect shapes (always `skin_smooth` 0/0, original lip line, no plumping).

`YoucamClient.startMakeup` only accepts the branded `CompiledEffects` type, so hand-built effects cannot spend units.

## YouCam integration notes (verified)

- Auth: `Authorization: Bearer <API Key>` (v2.0).
- Private upload: `POST /s2s/v2.0/file` → presigned `PUT` → reusable `file_id` (one upload serves all variants and edits).
- Task: `POST /s2s/v2.0/task/makeup-vto` with `src_file_id`; poll `GET …/{task_id}`; success returns `data.results.url` (valid 2 h).
- `POST /s2s/v2.0/task/delete` removes the task **and its input files** — done at session end.
- 1 unit per successful task; errors cost nothing. Tasks of one account run roughly one at a time (~6 s each).
