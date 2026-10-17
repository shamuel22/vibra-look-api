# vibralook-api

Backend for **VIBRA LOOK** — turns a feeling ("jazz on a rooftop, elegant but not overdone") into three makeup looks rendered on the person's own selfie with the **YouCam AI Makeup Virtual Try-On API** (Perfect Corp).

The API keeps the YouCam key server-side, translates the vibe into structured recipes, compiles them deterministically into whitelisted YouCam effects, validates constraints *before* spending units, and orchestrates the asynchronous renders.

> Status: Phase 2 in progress — F2.1 (YouCam client) done. See the app repo's `PLAN.md` §4 for stages and the verified YouCam spike.

## Requirements

- Node.js ≥ 22, pnpm ≥ 9
- A YouCam API key (v2.0) from the [API console](https://yce.makeupar.com/api-console/en/api-keys/)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill YOUCAM_API_KEY
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
| `pnpm test` | Unit tests (no network, no units spent) |
| `pnpm lint` | oxlint (type-aware) |
| `pnpm smoke:youcam <image.jpg> [out.jpg]` | One real render through the API client (upload → task → poll → download → delete). **Costs 1 unit.** |

## Environment

See `.env.example`. The process refuses to start if a required variable is missing or malformed; values are never logged.

## YouCam integration notes (verified)

- Auth: `Authorization: Bearer <API Key>` (v2.0).
- Private upload: `POST /s2s/v2.0/file` → presigned `PUT` → reusable `file_id` (one upload serves all variants and edits).
- Task: `POST /s2s/v2.0/task/makeup-vto` with `src_file_id`; poll `GET …/{task_id}`; success returns `data.results.url` (valid 2 h).
- `POST /s2s/v2.0/task/delete` removes the task **and its input files** — done at session end.
- 1 unit per successful task; errors cost nothing.
- Features are never altered: `skin_smooth` 0/0, `lip_color.shape = original`, `morphology` 0/0.
