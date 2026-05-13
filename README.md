# HB-Video

*Ah, Doctor. You have arrived. Good. The creatures are waiting.*

This is the video pipeline for **HabitBeast** — the gamified habit tracker where real-world consistency powers monster PvP battles. Your laboratory generates the fight scenes.

Two purposes. One pipeline:
- **In-app fight scenes** — triggered when two players clash inside HabitBeast
- **Social media content** — fight clips for TikTok and Instagram

*Come. I will show you everything.*

---

## The Monsters

Six subjects. Each with their own... temperament.

| Name | Nature |
|------|--------|
| **Frank** | Massively overweight Frankenstein's monster. Slow. Devastating. |
| **Iggs** | Tiny scrawny cyclops. Fast, erratic, completely unhinged. |
| **Murk** | Stocky swamp creature. Wide flat head. Enormous mouth. |
| **Stumbles** | Ragged zombie who cannot stop grinning. Ever. |
| **Wolf** | Muscular werewolf. Tongue out. Always. |
| **Wrapps** | Ancient mummy. Single glowing blue eye. Speaks to no one. |

Monster image assets live in `../habitBeastMonsters` — a sibling directory. Keep them close.

---

## The Laboratory

| Layer | Apparatus |
|-------|-----------|
| Language | TypeScript 5 + ts-node |
| Runtime | Node.js (Windows / PowerShell) |
| Server | Express 5.2 — port 3000 |
| Compositing | sharp (PNG layer rendering) |
| Video | ffmpeg via fluent-ffmpeg |
| Secrets | `.env` — do not let it out of the castle |

---

## Setup

```powershell
npm install
```

Create a `.env` in the project root:
```
GEMINI_API_KEY=your-key-here
```

---

## Operation

**Start the server:**
```powershell
npx ts-node server.ts
```

**Blink animation pipeline** — renders looping monster blink MP4s locally, no API required:
```powershell
npx ts-node blink.ts
```

The compositing workflow (layering backgrounds, clothing, accessories → ffmpeg → final MP4) runs entirely through the Express server endpoints.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture — current pipeline, known tech debt, and the path toward Unity-based fight choreography.

---

*The work continues, Doctor. It always continues.*
