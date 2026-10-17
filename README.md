# vibralook-api

Backend for **VIBRA LOOK** — turns a feeling ("jazz on a rooftop, elegant but not overdone") into three makeup looks rendered on the person's own selfie with the **YouCam AI Makeup Virtual Try-On API** (Perfect Corp).

The API keeps the YouCam key server-side, translates the vibe into structured recipes, compiles them deterministically into whitelisted YouCam effects, validates constraints *before* spending units, and orchestrates the asynchronous renders.

> Status: Phase 2 in progress — F2.1 (YouCam client) and F2.2 (shared contracts + look compiler) done. See the app repo's `PLAN.md` §4 for stages and the verified YouCam spike.

## Requirements

- Node.js ≥ 22, pnpm ≥ 9
- A YouCam API key (v2.0) from the [API console](https://yce.makeupar.com/api-console/en/api-keys/)
- A DeepSeek API key (vibe translation, from F2.3)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill YOUCAM_API_KEY (and DEEPSEEK_API_KEY)
pnpm build
pnpm start             # listens on $PORT (default 3000)
curl localhost:3000/health
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm build` | Compile to `dist/` |
| `pnpm start` | Run the compiled server (reads `.env` if present) |
| `pnpm start:dev` | Watch mode |
| `pnpm test` | Contract sync check + unit tests (no network, no units spent) |
| `pnpm contracts:sync` | Copy the app's domain model (`../src/domain`) into `src/contracts/domain/` |
| `pnpm lint` | oxlint (type-aware) |
| `pnpm smoke:youcam <image.jpg> [outDir] [variants]` | Renders the sample looks (every finish) through the real pipeline: compile → one upload → tasks → download → delete. **Costs 1 unit per look (3).** |

## Environment

See `.env.example`. The process refuses to start if a required variable is missing or malformed; values are never logged.

## YouCam integration notes (verified)

- Auth: `Authorization: Bearer <API Key>` (v2.0).
- Private upload: `POST /s2s/v2.0/file` → presigned `PUT` → reusable `file_id` (one upload serves all variants and edits).
- Task: `POST /s2s/v2.0/task/makeup-vto` with `src_file_id`; poll `GET …/{task_id}`; success returns `data.results.url` (valid 2 h).
- `POST /s2s/v2.0/task/delete` removes the task **and its input files** — done at session end.
- 1 unit per successful task; errors cost nothing.
- Features are never altered: `skin_smooth` 0/0, `lip_color.shape = original`, `morphology` 0/0.

## Shared contracts

`src/contracts/domain/` is a generated copy of the app's pure domain model (types, shade library, constraint rules, recipe ids). Edit it **in the app repo** and run `pnpm contracts:sync`; `pnpm test` fails if the copy is stale (the check is skipped when the app repo is not next to the API, e.g. on the server). `src/contracts/wire.ts` holds the zod schemas for untrusted input and a compile-time assertion that they match the domain types.

## Look compiler

`compileLook(recipe, { constraints, kit })` → whitelisted YouCam effects, deterministically:

1. **Validate** (`looks/look.validator.ts`): shape (strict, unknown fields rejected), shade library and zone, finish per zone, at least one zone, recipe id, the person's constraints and declared kit (the app's own rules). Any problem → `LookRejectedError`; nothing is sent and no unit is spent.
2. **Map**: intensity 1–5 → `colorIntensity` 25/40/55/70/85; finishes → textures (eyes matte / satin = low shimmer / metallic; cheeks matte / satin glow / luminous shimmer; lips matte / satin / gloss). One lid wash (`1color1`) for eyes, `1color1` blush.
3. **Gate** (`looks/whitelist.ts`): the output must match the exact allowed effect shapes (always `skin_smooth` 0/0, original lip line, no plumping).

`YoucamClient.startMakeup` only accepts the branded `CompiledEffects` type, so hand-built effects cannot spend units.
