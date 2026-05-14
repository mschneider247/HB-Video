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

---

## Setup

```powershell
npm install
```

ffmpeg must be installed and on your PATH. [Download here](https://ffmpeg.org/download.html).

---

## Operation

```powershell
npm run start
```

Then open **http://localhost:3000** in your browser. Everything runs through the UI — compose monsters, render blink animations, splice clips, and approve content for posting.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture — current pipeline, known tech debt, and the path toward Unity-based fight choreography.

---

*The work continues, Doctor. It always continues.*
