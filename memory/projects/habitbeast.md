# HabitBeast

**Status:** Beta on Google Play
**Type:** Gamified habit tracker — mobile app (Android)
**Tagline:** Raise a monster. Level up with it. Fight other people's monsters.

## Core Concept
A habit tracker where your real-life consistency powers a monster in a PvP battle game.

## Game Mechanics
- **5 habit categories:** Exercise, Health, Clean, Creativity, Social
- **Habit tiers:** Each habit has its own tiers to level up (breadth + consistency both matter)
- **Battle Actions:** Earned by completing habits — used as ammunition in monster battles
- **PvP battles:** Challenge any other user. Both players load up Battle Actions. Battle autocompletes.
- **The loop:** Actions get used up in battle → must keep doing habits to keep winning → game pulls you back to self-improvement

## The 6 Playable Monsters
| Name | Description |
|------|-------------|
| **Frank** | Massively overweight Frankenstein's monster. Green skin, flat-top head, neck bolts, enormous jiggling belly. Slow but hits hard. |
| **Iggs** | Tiny scrawny yellow-green cyclops. Single enormous eye dominates his face. Fast, erratic, scrappy. |
| **Murk** | Stocky swamp creature with a hippo's wide flat head and enormous mouth. Brown, muddy, lumbering. |
| **Stumbles** | Thin ragged zombie in tattered clothes. Always has a massive grin no matter what. Red-toned. |
| **Wolf** | Muscular brown werewolf. Tongue permanently flopped out to one side. Strong and bouncy. |
| **Wrapps** | Classic mummy in yellowed bandages. Single glowing blue eye peering out. Ancient and mysterious. |

HB (the blue cube) is the mascot, not playable by users.

## Veo Fight Scene Feature
**Concept:** Generate AI cartoon fight videos when two monsters battle. Dual purpose — in-app feature AND social media content.

**Tech stack:**
- Google AI Studio API (Gemini API) → Veo 2
- TypeScript / Node.js script
- Project location: `C:\Users\mschn\Desktop\Code\Veo`
- Model: `veo-2.0-generate-001`
- API key stored as PowerShell env var: `$env:GEMINI_API_KEY`

**Run a fight:**
```powershell
cd C:\Users\mschn\Desktop\Code\Veo
$env:GEMINI_API_KEY = "your-key-here"
npx ts-node generate.ts frank-vs-wrapps
npx ts-node generate.ts iggs-vs-wolf
npx ts-node generate.ts murk-vs-stumbles
npx ts-node generate.ts "custom prompt"
```

**Prompt approach:**
- Keep prompts SHORT — Veo gets confused with too much direction
- Hardcode base monster descriptions per character (6 total, known designs)
- Append user clothing/accessories dynamically for personalization
- Be explicit about WHO does WHAT action (Veo can mix up attacker/defender)

**Prompt template:**
> *A short cartoon fight scene. [Monster A description], [Monster A action]. [Monster B description], [Monster B action]. [Winner] wins. Saturday morning cartoon style, colorful and bouncy.*

**Monster Veo descriptions (ready to use):**
- **Frank:** A massively overweight Frankenstein's monster with green skin, flat-top head, and neck bolts
- **Iggs:** A tiny scrawny yellow-green cyclops monster with one giant expressive eye
- **Murk:** A stocky swamp creature with a hippo's wide flat head, enormous mouth, and muddy brown skin
- **Stumbles:** A thin ragged zombie in tattered clothes who always has a massive grin plastered on his face
- **Wolf:** A muscular werewolf with shaggy brown fur and his tongue permanently flopped out to one side
- **Wrapps:** A classic mummy wrapped in yellowed bandages with a single glowing blue eye

**Results so far (March 5, 2026):**
- ✅ Veo 3.1 tested in Gemini UI — worked, charming result, but confusing/too detailed prompt
- ✅ Simpler prompt tested in Gemini UI — much better
- ✅ TypeScript/Node script built and running locally
- ✅ GCP billing enabled
- ⏳ First API run in progress (frank-vs-wrapps)
- 🔜 Next: tweak prompt so winner isn't reversed, tighten who does what action

**Known issues to fix in next prompt iteration:**
- Veo sometimes reverses who fires the water cannon (attacker vs defender confusion)
- Both monsters ended up holding hot dogs simultaneously — need to clarify "Frank ALONE eats a hot dog"
- Wrapps' glowing blue eye doesn't render (minor)

## Origin Story (for marketing copy)
Michael built it because existing habit apps felt boring, sterile, or expensive. He loves games and storytelling and wanted to combine self-improvement with both.

## Key Marketing Angles
- "Your consistency becomes a weapon"
- The PvP loop that forces you back to real habits
- Not just a streak counter — actual consequence and reward
- Free / not expensive (unlike competitors)

## Demo Video
- Original splashy demo reel created in a previous session (in Claude Shared Folder on Desktop)

## Social Media Launch Log
### Posts completed (March 4, 2026 — Day 1, 10 posts total)
- ✅ **r/SideProject** — "I built HabitBeast because every habit app I tried was either boring, sterile, or expensive — so I made one where you raise a monster and fight other people's monsters"
- ✅ **r/gamification** — Design-thinking angle, focused on the habit/game loop mechanic

### Posts drafted but not yet posted
- r/androidapps
- r/getdisciplined
- r/productivity

### Subreddits researched & recommended
| Subreddit | Priority | Notes |
|-----------|----------|-------|
| r/SideProject | ✅ Done | Maker community |
| r/gamification | ✅ Done | Design-thinking angle |
| r/androidapps | Next | Google Play audience, beta testers |
| r/getdisciplined | Next | Core user base |
| r/productivity | Next | Broad reach |
| r/selfimprovement | Later | Large, habit-focused |
| r/incremental_games | Later | Love RPG progression loops |
| r/habitica | ❌ Skip | Competitor's community — bad idea |

## Competitors
- **Habitica** — most direct competitor, also gamified, but older/established
- General habit apps described as "boring, sterile, or expensive"
