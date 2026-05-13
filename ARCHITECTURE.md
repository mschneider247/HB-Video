# HB-Video — Architecture Notes

> **Project rename:** Was "Veo". Renamed to `HB-Video` to reflect the broader video pipeline purpose beyond any single AI model.

## What This Is

A TypeScript/Node.js toolchain for generating monster fight videos for **HabitBeast** (indie Android gamified habit tracker with PvP battles). Two output channels:
1. **Social media marketing content** — fight clips for TikTok/Instagram
2. **In-app fight scenes** — eventually triggered by PvP battles inside HabitBeast

---

## Current Stack

| Layer | Tech |
|-------|------|
| Language | TypeScript 5.0 + ts-node |
| Runtime | Node.js on Windows (PowerShell) |
| Web server | Express 5.2 (port 3000) |
| Image processing | sharp (PNG compositing) |
| Video processing | ffmpeg via fluent-ffmpeg |
| Secrets | `.env` (API keys) |
| Build output | `dist/` (CommonJS) |

> **Note:** The original Google Veo 2 integration (`generate.ts`, polling logic in `server.ts`) is effectively dead weight — Veo 2 has been deprecated and was prohibitively expensive (~$0.35/sec). It should be removed in a cleanup pass. The local sprite-based blink system (`blink.ts`) and the Express server's compositing/ffmpeg pipeline remain valid.

---

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Central Express API (~3,600 lines). 17 endpoints: compositing, filtering, splicing, approval workflow, cost tracking. Some endpoints still call removed Veo 2 — need audit. |
| `generate.ts` | **Deprecated.** Was CLI for Veo 2 fight generation. To be removed. |
| `blink.ts` | Local sprite-swap blink animation system (~1,800 lines). Renders monster blink loops via ffmpeg without any AI API. Keep. |
| `generation-log.json` | Historical API cost log from Veo 2 era. Archive only. |
| `memory/projects/habitbeast.md` | HabitBeast game mechanics, monster roster, prompt engineering notes. |

---

## Local Animation Pipeline (What Still Works)

```
Eye state sprites (open/partial/closed per monster)
        ↓
  Blink state machine (ported from HabitBeast React app)
        ↓
  ffmpeg composite → looping MP4
```

**Asset compositing path:**
```
PNG layers (background + monster clothing/accessories)
        ↓
  sharp composite → rendered frame
        ↓
  ffmpeg: prepend intro card + apply filter + append end card
        ↓
  Approve → GoodToGo/
```

---

## Monster Roster

6 base monsters: **Frank, Iggs, Murk, Stumbles, Wrapps, Brady**. Each has:
- Multiple eye states (open, partial, closed)
- Configurable clothing, capes, mouths, mustaches
- Big vs. small size groups (affects compositing math)

Monster image assets live at `../habitBeastMonsters` (sibling directory).

---

## Known Redundancy & Tech Debt

- Monster constants (names, folders, sizes) duplicated across all 3 TS files — needs `constants.ts`
- PNG layer compositing logic duplicated in `generate.ts` and `server.ts`
- No TypeScript interfaces for API request/response bodies (heavy use of `any`)
- `generation-log.json` grows unbounded — archive it
- Hard path to `../habitBeast/public` — breaks if HabitBeast repo isn't co-located
- `dist/` build artifacts tracked in repo (should be `.gitignore`d)
- `.env` with plaintext API key — confirm `.gitignore` entry

---

## Future Direction: Unity Integration

### Vision
Migrate from Node.js to a **Unity-based animation pipeline** for deterministic, reusable fight choreography:

1. **Monster models** (rigged 2D sprites or 3D models) animated inside Unity — no AI API dependency for common sequences
2. **Firebase backend** (already used by HabitBeast) as the bridge: Unity → Firebase → HabitBeast app
3. **Short animations** generated on-demand per PvP battle result, delivered back to the app as video URLs via Firebase Storage

### Integration Shape (TBD)
```
HabitBeast app (Android)
        ↓  battle result event
  Firebase Cloud Function
        ↓  triggers
  Unity animation renderer
        ↓  outputs MP4
  Firebase Storage
        ↓  URL back to app
  HabitBeast in-app video playback
```

### What Should Survive the Migration
- Monster roster data and descriptions → shared config / Firebase document
- Blink state machine logic → port to C# or keep as reference
- Approval workflow concept (curated vs. auto-generated)
- Asset compositing knowledge (clothing layers, size groups)

### What Unity Unlocks Over Current Approach
- Deterministic, scriptable fight choreography (not prompt-based lottery)
- Reuse of HabitBeast's own monster assets directly (rigged vs. flat PNG)
- No per-video API cost for common animations (idle, blink, win/lose)
- Optional AI generation (e.g. future Veo successor) reserved for hero moments only

---

## Open Questions

- [ ] Will fight animations be pre-rendered (per outcome) or generated on-demand?
- [ ] Do monsters need rigged 3D models, or is sprite-based Unity sufficient?
- [ ] Who triggers generation — client (Unity standalone) or server (Firebase Function)?
- [ ] How does video get back to the app — Firebase Storage URL, bundled asset, or streaming?
- [ ] Is there a latency budget? (on-demand vs. pre-rendered per battle outcome)
- [ ] Should the Express server evolve into a Firebase Cloud Function, or be replaced entirely?

---

## Immediate Cleanup (Before Unity Work Starts)

1. Delete `generate.ts` (Veo 2 — deprecated)
2. Audit `server.ts` — remove all Veo 2 endpoint handlers
3. Extract `constants.ts` — monster roster, folder names, size groups
4. Add `.gitignore` entries: `dist/`, `.env`, `node_modules/`
5. Archive old test videos out of root folder
6. Archive `generation-log.json` (historical only)
