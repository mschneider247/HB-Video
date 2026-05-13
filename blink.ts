// ----------------------------------------------------------------
// blink.ts — local sprite-swap renderer for monster blink loops
//
// Bypasses the Veo-2 API: renders three reference frames per monster
// (open / partial / closed eyes), then concatenates them per a
// deterministic state machine ported from Habit Beast's MonsterAvatar.
// Output is a clean N-second loop. Stack 8 of these into a 3×3 Brady
// Bunch grid (center cell = title card) for a montage clip.
//
// Why local instead of Veo-2? For "monster stands there blinking" the
// state machine is the actual desired behavior. AI generation is
// unnecessary, expensive, and inconsistent — just play the sprites.
//
// Usage:
//   npm run blink one <monster> [mood] [bgColor] [outPath]
//   npm run blink grid [outPath]
// ----------------------------------------------------------------

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import sharp from "sharp";

// ----------------------------------------------------------------
// Constants — paths and monster taxonomy (kept independent of generate.ts
// so this module can run standalone)
// ----------------------------------------------------------------
const MONSTERS_DIR = path.join(__dirname, "..", "habitBeast", "public");

const BIG_MONSTERS   = ["frank", "wolf", "murk", "biggs"] as const;
const SMALL_MONSTERS = ["stumbles", "iggs", "wrapps", "entsy"] as const;
type BigMonster   = typeof BIG_MONSTERS[number];
type SmallMonster = typeof SMALL_MONSTERS[number];
type Monster      = BigMonster | SmallMonster;
// EyeState — full set ported from HabitBeast/src/constants/monsters.ts.
// "openWide" / "partialLeft" / "partialRight" are richer variants picked at
// each phase transition (see resolveEyeState). "openUp" is the eye-roll state,
// triggered midway through the alternate window for sad/upset moods.
type EyeState     = "open" | "openWide" | "partial" | "partialLeft" | "partialRight" | "closed" | "openUp";
type BasePhase    = "open" | "partial";
type Mood         = "happy" | "okay" | "excited" | "sad" | "upset";

// All seven eye states — handy for "render every reference frame" loops.
const EYE_STATES: readonly EyeState[] =
  ["open", "openWide", "partial", "partialLeft", "partialRight", "closed", "openUp"] as const;

const EYE_FOLDER: Record<Monster, string> = {
  frank: "Frank", wolf: "Wolf", murk: "Murk", biggs: "Biggs",
  stumbles: "Stumbles", iggs: "Iggs", wrapps: "Wrapps", entsy: "Entsy",
};

const isBig = (m: string): m is BigMonster =>
  (BIG_MONSTERS as readonly string[]).includes(m);

function sizeFor(m: Monster): "Big" | "Small" {
  return isBig(m) ? "Big" : "Small";
}

// ----------------------------------------------------------------
// Blink state machine — ported from MonsterAvatar.tsx
// (habitBeast/src/components/monster/MonsterAvatar.tsx)
//
// Two independent timers:
//   1. Blink timer — schedules a 140 ms eye-closed pulse on a randomized interval
//   2. Phase timer — alternates the resting eye between "open" and "partial"
//
// Mood (mouth selection) drives both:
//   - Heavy-lidded moods (sad, upset) blink less frequently and dwell on partial
//   - Excited moods spend most of the time wide open with brief partial flicks
//   - Symmetric moods (okay, happy) split open/partial roughly evenly
// ----------------------------------------------------------------
const BLINK_DURATION = 0.14; // seconds — matches HB's 140 ms

// Halved from the HabitBeast app values so video clips feel livelier — monsters
// blink more often and switch eye state faster than they do in the real-time UI.
const BLINK_INTERVAL = {
  // happy / okay / excited
  normal: { min: 1.25, max: 2.75 },
  // sad / upset
  heavy:  { min: 2.5,  max: 4.5  },
};

const HEAVY_MOODS: ReadonlySet<Mood> = new Set<Mood>(["sad", "upset"]);

// Mood ladder — used by mouth-drift to step the mood up or down by 1 over time.
// Order goes saddest → happiest. Drift never jumps two steps at once.
const MOOD_LADDER: readonly Mood[] = ["upset", "sad", "okay", "happy", "excited"] as const;
const moodIndex = (m: Mood) => MOOD_LADDER.indexOf(m);
const clampMoodIdx = (i: number) => Math.max(0, Math.min(MOOD_LADDER.length - 1, i));

// Per-mood eye phase config — derived from MonsterAvatar.tsx EYE_PHASE_CONFIG
// but with all dwell times halved for short-form video. Each mood has a
// dominant phase (eyes mostly there) and an alternate phase (brief other-state
// flick). For sad/upset, partial is dominant — they look heavy-lidded.
//
//   dominantMin/Max  = how long the dominant phase lasts before flicking
//   alternateMin/Max = how long the alternate phase lasts before returning
const EYE_PHASE_CONFIG: Record<Mood, {
  dominant:        BasePhase;
  alternate:       BasePhase;
  dominantMin:     number; dominantMax:     number;
  alternateMin:    number; alternateMax:    number;
}> = {
  //              dom         alt           domMin domMax altMin altMax
  okay:    { dominant: "open",    alternate: "partial", dominantMin: 0.9,  dominantMax: 2.0,  alternateMin: 0.9,  alternateMax: 2.0  },
  happy:   { dominant: "open",    alternate: "partial", dominantMin: 1.8,  dominantMax: 4.0,  alternateMin: 1.8,  alternateMax: 4.0  },
  excited: { dominant: "open",    alternate: "partial", dominantMin: 7.2,  dominantMax: 16.0, alternateMin: 0.3,  alternateMax: 0.6  },
  // sad/upset are heavy-lidded — partial dominates
  sad:     { dominant: "partial", alternate: "open",    dominantMin: 3.6,  dominantMax: 8.0,  alternateMin: 0.3,  alternateMax: 0.6  },
  upset:   { dominant: "partial", alternate: "open",    dominantMin: 2.5,  dominantMax: 5.0,  alternateMin: 0.45, alternateMax: 0.75 },
};

// Maps a base phase (open/partial) to a richer variant based on the current mood.
// Called on every phase transition so each visit re-rolls the look. Mirrors
// resolveEyeState in MonsterAvatar.tsx but with boosted variant probabilities so
// short video clips show more of the rich eye states rather than plain open/partial.
//   open    + excited → 70% openWide
//   open    + happy   → 40% openWide
//   open    + okay    → 15% openWide        ← new — rare surprise look
//   partial + (any except excited) → 80% partialLeft/Right (random side)
//   excited never shows partial as dominant, so no directional variant there.
function resolveEyeState(base: BasePhase, mood: Mood, rng: () => number): EyeState {
  if (base === "open") {
    const r = rng();
    if (mood === "excited" && r < 0.70) return "openWide";
    if (mood === "happy"   && r < 0.40) return "openWide";
    if (mood === "okay"    && r < 0.15) return "openWide";
    return "open";
  }
  if (mood === "excited") return "partial";
  if (rng() < 0.80) return rng() < 0.5 ? "partialLeft" : "partialRight";
  return "partial";
}

// ----------------------------------------------------------------
// Seeded RNG — keeps clip rendering deterministic so regenerating a
// "frank/happy/yellow" clip produces the same blink pattern every time
// ----------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  // FNV-1a
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ----------------------------------------------------------------
// Timeline generation
// Output is a list of {state, duration} blocks summing to exactly totalSec,
// guaranteed to end on "open" so the loop stitches cleanly.
// ----------------------------------------------------------------
// A block is a (mood, eye state) tuple held for `duration` seconds. Mood is
// included so the renderer can swap mouths over time when mood drift fires.
export type Block = { state: EyeState; mood: Mood; duration: number };

export function generateTimeline(
  startMood: Mood,
  totalSec: number,
  seed: number,
  opts: {
    tailOpenMin?: number;
    forceEyeRollAt?: number;
    forceEyeRollDur?: number;
    /** 0..1 — chance per phase boundary that mood shifts +/-1 step. Default 0.25. */
    moodDriftChance?: number;
  } = {},
): Block[] {
  const rng = mulberry32(seed);
  let mood: Mood = startMood;
  let cfg = EYE_PHASE_CONFIG[mood];
  let blinkRange = HEAVY_MOODS.has(mood) ? BLINK_INTERVAL.heavy : BLINK_INTERVAL.normal;
  let isRollMood = mood === "sad" || mood === "upset";
  const tailOpenMin = opts.tailOpenMin ?? 0.5;
  const forceRollAt = opts.forceEyeRollAt;
  const forceRollDur = opts.forceEyeRollDur ?? 1.4;
  const driftChance = opts.moodDriftChance ?? 0.25;

  const pickIn = (r: { min: number; max: number }) => r.min + rng() * (r.max - r.min);

  // Try to drift the current mood by +/- 1 step on the ladder. ~half of drifts
  // step up, ~half step down. Uses the seeded rng so renders stay deterministic.
  const tryDriftMood = () => {
    if (rng() >= driftChance) return;
    const idx = moodIndex(mood);
    const dir = rng() < 0.5 ? -1 : +1;
    const next = MOOD_LADDER[clampMoodIdx(idx + dir)];
    if (next === mood) return;
    mood = next;
    cfg = EYE_PHASE_CONFIG[mood];
    blinkRange = HEAVY_MOODS.has(mood) ? BLINK_INTERVAL.heavy : BLINK_INTERVAL.normal;
    isRollMood = mood === "sad" || mood === "upset";
  };

  const blocks: Block[] = [];
  let t = 0;

  // Track dominant vs alternate phases (mirrors MonsterAvatar.tsx phase machine).
  // Always start in dominant — for sad/upset that means "partial", which keeps
  // the looped clip stitching cleanly (we still force tail-on-"open" below).
  let inDominant = true;
  let phaseEye: EyeState = resolveEyeState(cfg.dominant, mood, rng);
  let phaseEnd = pickIn({ min: cfg.dominantMin, max: cfg.dominantMax });

  // Eye-roll scheduling — sad/upset get an `openUp` flick midway through each
  // alternate window. Set to absolute time t when the next roll should fire.
  let eyeRollAt: number | null = null;
  let inEyeRoll = false;

  let nextBlinkAt = pickIn(blinkRange);

  const push = (state: EyeState, dur: number) => {
    if (dur <= 1e-6) return;
    const last = blocks[blocks.length - 1];
    if (last && last.state === state && last.mood === mood) last.duration += dur;
    else blocks.push({ state, mood, duration: dur });
    t += dur;
  };

  // Optional forced eye-roll (used by behavior cascades — see GridCell.behavior).
  // Ignored if it would land outside the timeline.
  let forcedRollPending = forceRollAt !== undefined && forceRollAt < totalSec;

  while (t < totalSec) {
    const candidates: number[] = [phaseEnd, nextBlinkAt, totalSec];
    if (eyeRollAt !== null && !inEyeRoll) candidates.push(eyeRollAt);
    if (forcedRollPending && forceRollAt! > t) candidates.push(forceRollAt!);
    const stopAt = Math.min(...candidates);

    if (stopAt === totalSec) {
      push(phaseEye, totalSec - t);
      break;
    }

    if (forcedRollPending && stopAt === forceRollAt) {
      // Caller-driven eye-roll: flip to openUp for forceRollDur, then resume.
      push(phaseEye, forceRollAt! - t);
      const dur = Math.min(forceRollDur, totalSec - t);
      push("openUp", dur);
      forcedRollPending = false;
      // Don't disturb the natural phase machine — phaseEnd may now be in the past.
      // If so, end the phase immediately on the next iteration.
      continue;
    }

    if (stopAt === nextBlinkAt) {
      push(phaseEye, nextBlinkAt - t);
      push("closed", BLINK_DURATION);
      nextBlinkAt = t + pickIn(blinkRange);
      continue;
    }

    if (eyeRollAt !== null && stopAt === eyeRollAt) {
      // Natural eye-roll for sad/upset — flip the eye to openUp until the
      // alternate phase ends. Don't reschedule; the next alternate window
      // will set eyeRollAt again.
      push(phaseEye, eyeRollAt - t);
      phaseEye = "openUp";
      inEyeRoll = true;
      eyeRollAt = null;
      continue;
    }

    // Phase end — close out current dwell, possibly drift mood, then start the
    // next phase with refreshed config and a fresh variant pick.
    push(phaseEye, phaseEnd - t);
    inDominant = !inDominant;
    inEyeRoll = false;
    tryDriftMood();
    const min = inDominant ? cfg.dominantMin : cfg.alternateMin;
    const max = inDominant ? cfg.dominantMax : cfg.alternateMax;
    const phaseDur = pickIn({ min, max });
    phaseEnd = t + phaseDur;
    const basePhase = inDominant ? cfg.dominant : cfg.alternate;
    phaseEye = resolveEyeState(basePhase, mood, rng);

    // Schedule eye-roll midway through the alternate window for sad/upset.
    if (!inDominant && isRollMood) {
      eyeRollAt = t + phaseDur / 2;
    } else {
      eyeRollAt = null;
    }
  }

  // Trim any rounding overshoot
  let total = blocks.reduce((s, b) => s + b.duration, 0);
  if (total > totalSec) {
    let acc = 0;
    const trimmed: Block[] = [];
    for (const b of blocks) {
      if (acc + b.duration <= totalSec) {
        trimmed.push(b);
        acc += b.duration;
      } else {
        const remaining = totalSec - acc;
        if (remaining > 1e-6) trimmed.push({ state: b.state, mood: b.mood, duration: remaining });
        break;
      }
    }
    blocks.length = 0;
    blocks.push(...trimmed);
  }

  // Force tail to end on "open" with at least tailOpenMin seconds of open eye.
  // Loop cleanliness depends on this: the next iteration starts on dominant,
  // and the dominant for excited/happy/okay is "open". For sad/upset we still
  // want a clean "open" handoff to keep the looped clip stitching cleanly.
  total = blocks.reduce((s, b) => s + b.duration, 0);
  let last = blocks[blocks.length - 1];

  // Step 1: ensure the last block is labeled "open".
  if (last.state !== "open") {
    if (last.duration > tailOpenMin) {
      last.duration -= tailOpenMin;
      blocks.push({ state: "open", mood: last.mood, duration: tailOpenMin });
    } else {
      last.state = "open";
    }
  }

  // Step 2: if the (possibly relabeled) tail and the prior block are both
  // "open" with the same mood, merge them so the borrow logic sees one tall
  // block. We don't merge across mood changes — that would erase a mouth swap.
  while (blocks.length >= 2 &&
         blocks[blocks.length - 1].state === "open" &&
         blocks[blocks.length - 2].state === "open" &&
         blocks[blocks.length - 1].mood === blocks[blocks.length - 2].mood) {
    const tail = blocks.pop()!;
    blocks[blocks.length - 1].duration += tail.duration;
  }

  // Step 3: top up the tail by borrowing from earlier blocks until it's
  // at least tailOpenMin. We walk backwards leaving each prior block with
  // at least 0.1s so we don't crush a meaningful state to nothing.
  last = blocks[blocks.length - 1];
  if (last.state === "open" && last.duration < tailOpenMin) {
    let i = blocks.length - 2;
    while (i >= 0 && last.duration < tailOpenMin) {
      const prev = blocks[i];
      const need = tailOpenMin - last.duration;
      const sparable = Math.max(0, prev.duration - 0.1);
      const take = Math.min(need, sparable);
      if (take <= 0) break;
      prev.duration -= take;
      last.duration += take;
      i--;
    }
  }

  return blocks;
}

// ----------------------------------------------------------------
// Frame compositor — builds a single PNG frame for a given eye state.
// Three states per (monster, mood, bgColor, clothing) tuple are enough
// to render an entire blink loop via concat.
// ----------------------------------------------------------------
function hexToRgb(hex: string): { r: number; g: number; b: number; alpha: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 26, g: 26, b: 36, alpha: 1 }; // dark fallback
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

interface FrameOpts {
  monster: Monster;
  mood: Mood;
  eyeState: EyeState;
  bgColor: string;
  /** Optional image background, relative to MONSTERS_DIR. Examples:
   *   "Background/aquarium.png", "laboratory.png".
   *  When set, the image fills the canvas BEFORE the monster is composited.
   *  bgColor still seeds the canvas underneath in case the image has alpha. */
  backgroundImage?: string;
  clothing?: string[];     // filenames in {Big|Small}/, e.g. "redCowboyHat.png"
  bottom?: string;         // filename in Bottom/
  /** Cape name (no suffix), e.g. "blackCape". Pulls Paired/<cape>Bottom.png +
   *  Paired/<cape>Top.png from the size-matched folder. Bottom layers behind
   *  the monster body, Top renders above the eyes (alongside other clothing). */
  cape?: string;
  /** Mustache style id, e.g. "founder" / "greenStash" / "hairy". Pulls a
   *  mood-aware overlay from {size}/Mouths/ (founderHappy, greenStashSad, etc.). */
  mustache?: string;
  /** Lip-style id, e.g. "pretty" / "red". When unset, the renderer uses the
   *  default mouth (`Mouths/<mood>.png`). When set, it composites the matching
   *  styled variant (`Mouths/<style><MoodCap>.png` — e.g. prettyHappy.png). */
  mouthStyle?: string;
  fartFrame?: number;      // 1..8 — overlays Fart/fart{N}.png behind the monster body
  width: number;
  height: number;
}

// Where the 8 fart cloud PNGs live. Mirrors HabitBeast/public/Fart/fart1..8.png.
const FART_DIR = path.join(MONSTERS_DIR, "Fart");
const FART_FRAME_COUNT = 8;
const fartFramePath = (n: number) => path.join(FART_DIR, `fart${n}.png`);

// Cape paths — the Paired folder lives inside Big/ and Small/.
const capeBottomPath = (size: "Big" | "Small", cape: string) =>
  path.join(MONSTERS_DIR, size, "Paired", `${cape}Bottom.png`);
const capeTopPath = (size: "Big" | "Small", cape: string) =>
  path.join(MONSTERS_DIR, size, "Paired", `${cape}Top.png`);

// Mood-aware overlay paths. As of the recent HabitBeast consolidation, both
// mustaches and lip styles live in {size}/Mouths/ — each style ships 5 mood
// variants like prettyHappy.png, founderSad.png, etc. The default (unstyled)
// mouth is simply <mood>.png in the same folder.
const capMood = (mood: Mood) => mood.charAt(0).toUpperCase() + mood.slice(1);
const mouthPath = (size: "Big" | "Small", mood: Mood, mouthStyle?: string) => {
  const file = mouthStyle ? `${mouthStyle}${capMood(mood)}.png` : `${mood}.png`;
  return path.join(MONSTERS_DIR, size, "Mouths", file);
};
const mustachePath = (size: "Big" | "Small", style: string, mood: Mood) =>
  path.join(MONSTERS_DIR, size, "Mouths", `${style}${capMood(mood)}.png`);

// Beards live alongside regular clothing in {size}/<name>Beard.png. We detect
// them by filename so the caller can keep using clothing: string[] without a
// separate field — and so the renderer can place them at the right z-depth.
const isBeardFile = (f: string) => /Beard\.png$/i.test(f);

// Bucket clothing by slot so composeFrame can place each at the right z-depth.
// Same suffix conventions as server.ts's clothingSlot helper.
type ClothingBucket = "hat" | "chest" | "pants" | "shoes" | "beard" | "other";
function clothingBucket(filename: string): ClothingBucket {
  const name = filename.replace(/\.png$/i, "");
  if (/Beard$/i.test(name))                             return "beard";
  if (/(CowboyHat|WizardHat|Hat|Cap)$/i.test(name))     return "hat";
  if (/(Vest|Sash|Tee|Shirt|Tank)$/i.test(name))        return "chest";
  if (/(Pants|Bottoms|Trunks)$/i.test(name))            return "pants";
  if (/(Kicks|Shoes|Boots|Slippas)$/i.test(name))       return "shoes";
  return "other";
}

async function composeFrame(opts: FrameOpts): Promise<Buffer> {
  const { monster, mood, eyeState, bgColor, backgroundImage, clothing = [], bottom, cape, mustache, mouthStyle, fartFrame, width, height } = opts;
  const size = sizeFor(monster);

  // Bucket clothing so each piece lands at the right z-depth. Pants/shoes/chest
  // are body-region items that should sit UNDER face accessories (beard, cape
  // collar). Hats and unmatched "other" items render on top of everything.
  const byBucket: Record<ClothingBucket, string[]> = { hat: [], chest: [], pants: [], shoes: [], beard: [], other: [] };
  for (const c of clothing) byBucket[clothingBucket(c)].push(c);

  // Layer order (bottom → top), mirroring MonsterAvatar.tsx:
  //
  //   fart cloud → cape bottom → bottom slot → monster body
  //     → pants → shoes → chest                       (body-region clothing)
  //     → mouth (default or styled) → mustache → eyes   (face stack)
  //     → cape top → beard → hat → other              (above-face accessories)
  //
  // Beard sits ABOVE cape top so beards drape over the cape collar. Hats still
  // render on top so cowboy hats / caps cover the head cleanly.
  const layers: string[] = [];
  if (fartFrame !== undefined) layers.push(fartFramePath(fartFrame));
  if (cape)   layers.push(capeBottomPath(size, cape));
  if (bottom) layers.push(path.join(MONSTERS_DIR, "Bottom", bottom));
  layers.push(path.join(MONSTERS_DIR, `${monster}.png`));
  for (const c of byBucket.pants) layers.push(path.join(MONSTERS_DIR, size, c));
  for (const c of byBucket.shoes) layers.push(path.join(MONSTERS_DIR, size, c));
  for (const c of byBucket.chest) layers.push(path.join(MONSTERS_DIR, size, c));
  layers.push(mouthPath(size, mood, mouthStyle));
  if (mustache) layers.push(mustachePath(size, mustache, mood));
  layers.push(path.join(MONSTERS_DIR, size, "Eyes", EYE_FOLDER[monster], `${eyeState}.png`));
  if (cape) layers.push(capeTopPath(size, cape));
  for (const b of byBucket.beard) layers.push(path.join(MONSTERS_DIR, size, b));
  for (const c of byBucket.hat)   layers.push(path.join(MONSTERS_DIR, size, c));
  for (const c of byBucket.other) layers.push(path.join(MONSTERS_DIR, size, c));

  for (const l of layers) {
    if (!fs.existsSync(l)) throw new Error(`Layer not found: ${l}`);
  }

  // Determine source canvas size from the largest layer (mirrors compositeLayers
  // in generate.ts) — ensures nothing gets cropped at the source step.
  const metas = await Promise.all(layers.map((l) => sharp(l).metadata()));
  const sw = Math.max(...metas.map((m) => m.width  ?? 0));
  const sh = Math.max(...metas.map((m) => m.height ?? 0));

  // Composite everything onto a transparent source canvas
  const overlayBufs = await Promise.all(layers.map((l) =>
    sharp(l)
      .resize(sw, sh, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
  ));
  const monsterBuf = await sharp({
    create: { width: sw, height: sh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(overlayBufs.map((input) => ({ input })))
    .png()
    .toBuffer();

  // Fit monster onto the target canvas with "contain" centering. Rest of the
  // canvas shows the bgColor — that's how each cell gets its own color.
  const scale = Math.min(width / sw, height / sh);
  const tw = Math.max(1, Math.round(sw * scale));
  const th = Math.max(1, Math.round(sh * scale));
  const offsetX = Math.floor((width - tw) / 2);
  const offsetY = Math.floor((height - th) / 2);

  const resized = await sharp(monsterBuf).resize(tw, th).png().toBuffer();

  // Build the final canvas: optional image background fills the whole frame
  // first, then the composed monster sits on top centered. bgColor still seeds
  // the canvas in case the image has transparency or isn't aspect-perfect.
  const finalComposites: sharp.OverlayOptions[] = [];
  if (backgroundImage) {
    const bgPath = path.join(MONSTERS_DIR, backgroundImage);
    if (fs.existsSync(bgPath)) {
      const bgBuf = await sharp(bgPath)
        .resize(width, height, { fit: "cover" })
        .png()
        .toBuffer();
      finalComposites.push({ input: bgBuf, left: 0, top: 0 });
    }
  }
  finalComposites.push({ input: resized, left: offsetX, top: offsetY });

  return await sharp({
    create: { width, height, channels: 4, background: hexToRgb(bgColor) },
  })
    .composite(finalComposites)
    .png()
    .toBuffer();
}

// ----------------------------------------------------------------
// Single-clip renderer
// ----------------------------------------------------------------
export interface BlinkClipOpts {
  monster: Monster;
  mood?: Mood;             // default: "happy"
  bgColor?: string;        // default: "#FFE566" (warm yellow)
  clothing?: string[];
  bottom?: string;
  cape?: string;           // e.g. "blackCape" — pairs Top + Bottom from {size}/Paired/
  mustache?: string;       // e.g. "founder" / "greenStash" / "hairy" — mood-driven overlay
  mouthStyle?: string;     // e.g. "pretty" / "red" — mood-driven styled lips
  /** Image background relative to MONSTERS_DIR (e.g. "Background/aquarium.png"). */
  backgroundImage?: string;
  durationSec?: number;    // default: 8
  fps?: number;            // default: 24
  width?: number;          // default: 1080
  height?: number;         // default: 1080
  seed?: number | string;  // default: hash of (monster, mood, bgColor, durationSec)
  /** Force an eye-roll (openUp) at this absolute time within the clip. */
  forceEyeRollAt?: number;
  /** Duration of the forced eye-roll in seconds. Default: 1.4 */
  forceEyeRollDur?: number;
  outputPath: string;
}

export async function renderBlinkClip(opts: BlinkClipOpts): Promise<string> {
  const {
    monster,
    mood = "happy",
    bgColor = "#FFE566",
    clothing,
    bottom,
    cape,
    mustache,
    mouthStyle,
    backgroundImage,
    durationSec = 8,
    fps = 24,
    width = 1080,
    height = 1080,
    seed = `${monster}-${mood}-${bgColor}-${durationSec}`,
    forceEyeRollAt,
    forceEyeRollDur,
    outputPath,
  } = opts;

  ensureFfmpeg();

  const seedNum = typeof seed === "number" ? seed : hashSeed(seed);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `blink-${monster}-`));

  try {
    // 1. Generate the blink timeline first so we know which (mood, eye) tuples
    //    actually appear. With mood drift on, the timeline may use multiple moods.
    const timeline = generateTimeline(mood, durationSec, seedNum, { forceEyeRollAt, forceEyeRollDur });

    // 2. Render exactly the unique (mood, eyeState) tuples we'll need.
    const tupleKey = (b: Block) => `${b.mood}_${b.state}`;
    const framePaths: Record<string, string> = {};
    for (const block of timeline) {
      const k = tupleKey(block);
      if (framePaths[k]) continue;
      const buf = await composeFrame({
        monster, mood: block.mood, eyeState: block.state, bgColor,
        clothing, bottom, cape, mustache, mouthStyle, backgroundImage, width, height,
      });
      const p = path.join(tmpDir, `${k}.png`);
      fs.writeFileSync(p, buf);
      framePaths[k] = p;
    }

    // 3. Write an ffmpeg concat list
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const lines = ["ffconcat version 1.0"];
    for (const block of timeline) {
      lines.push(`file '${fwd(framePaths[tupleKey(block)])}'`);
      lines.push(`duration ${block.duration.toFixed(3)}`);
    }
    // ffmpeg's concat demuxer ignores `duration` on the last image unless the file
    // is repeated — so repeat it without a duration directive.
    lines.push(`file '${fwd(framePaths[tupleKey(timeline[timeline.length - 1])])}'`);

    const listPath = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(listPath, lines.join("\n"), "utf-8");

    // 3. Encode. -vsync vfr respects per-image durations; the fps filter
    // resamples to a constant fps for a clean H.264 stream.
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execSync(
      [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", `"${listPath}"`,
        "-vsync", "vfr",
        "-vf", `fps=${fps},format=yuv420p`,
        "-c:v", "libx264",
        "-t", String(durationSec),
        `"${outputPath}"`,
      ].join(" "),
      { stdio: "pipe" },
    );

    console.log(`✅  ${monster}/${mood} on ${bgColor} → ${path.resolve(outputPath)}`);
    return outputPath;
  } finally {
    // Cleanup tmp frames
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------
// Fart sequence — 1:1 port of MonsterAvatar.tsx runFartSequence.
// Choreography (durations in seconds):
//
//   strain         okay/partialLeft       1.0
//   strain         okay/partialRight      0.7
//   strain         okay/partialLeft       0.7
//   strain         okay/partialRight      0.7   ← sfx fires here in HB
//   relief begin   happy/closed           0.2
//   cloud frame 1  happy/closed + fart1   0.2
//   cloud frame 2  happy/closed + fart2   0.15
//   cloud frame 3  happy/closed + fart3   0.15
//   cloud frame 4  happy/closed + fart4   0.1
//   cloud frame 5  happy/closed + fart5   0.1
//   cloud frame 6  happy/closed + fart6   0.1
//   cloud frame 7  happy/closed + fart7   0.1
//   cloud frame 8  happy/closed + fart8   0.2
//   relief finale  excited/openWide       2.0
// ----------------------------------------------------------------
type FartBlock = {
  eyeState: EyeState;
  mood: Mood;
  fartFrame?: number;   // 1..8
  duration: number;
};

export const FART_TIMELINE: FartBlock[] = [
  { mood: "okay",    eyeState: "partialLeft",  duration: 1.0 },
  { mood: "okay",    eyeState: "partialRight", duration: 0.7 },
  { mood: "okay",    eyeState: "partialLeft",  duration: 0.7 },
  { mood: "okay",    eyeState: "partialRight", duration: 0.7 },
  { mood: "happy",   eyeState: "closed",       duration: 0.2 },
  { mood: "happy",   eyeState: "closed", fartFrame: 1, duration: 0.2  },
  { mood: "happy",   eyeState: "closed", fartFrame: 2, duration: 0.15 },
  { mood: "happy",   eyeState: "closed", fartFrame: 3, duration: 0.15 },
  { mood: "happy",   eyeState: "closed", fartFrame: 4, duration: 0.1  },
  { mood: "happy",   eyeState: "closed", fartFrame: 5, duration: 0.1  },
  { mood: "happy",   eyeState: "closed", fartFrame: 6, duration: 0.1  },
  { mood: "happy",   eyeState: "closed", fartFrame: 7, duration: 0.1  },
  { mood: "happy",   eyeState: "closed", fartFrame: 8, duration: 0.2  },
  { mood: "excited", eyeState: "openWide",     duration: 2.0 },
];

export const FART_DURATION_SEC = FART_TIMELINE.reduce((s, b) => s + b.duration, 0);

export interface FartClipOpts {
  monster: Monster;
  bgColor?: string;        // default: "#FFE566"
  clothing?: string[];
  bottom?: string;
  cape?: string;
  mustache?: string;
  mouthStyle?: string;
  backgroundImage?: string;
  fps?: number;            // default: 24
  width?: number;          // default: 1080
  height?: number;         // default: 1080
  /** Optional pre-roll seconds of plain "open/happy" before the fart starts. Default: 0. */
  preRollSec?: number;
  /** Optional post-roll seconds of plain "open/happy" after the relief finale. Default: 0. */
  postRollSec?: number;
  outputPath: string;
}

/**
 * Render a single monster doing the full HabitBeast fart sequence.
 * Total duration = preRollSec + FART_DURATION_SEC (~6.4s) + postRollSec.
 */
export async function renderFartClip(opts: FartClipOpts): Promise<string> {
  const {
    monster,
    bgColor = "#FFE566",
    clothing,
    bottom,
    cape,
    mustache,
    mouthStyle,
    backgroundImage,
    fps = 24,
    width = 1080,
    height = 1080,
    preRollSec = 0,
    postRollSec = 0,
    outputPath,
  } = opts;

  ensureFfmpeg();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fart-${monster}-`));

  try {
    // The full set of unique (mood, eyeState, fartFrame) tuples used by the
    // sequence — render one PNG per unique tuple, then concat.
    const tupleKey = (b: FartBlock) => `${b.mood}_${b.eyeState}_${b.fartFrame ?? "none"}`;

    // Build the full block list (with optional pre/post roll)
    const fullTimeline: FartBlock[] = [];
    if (preRollSec > 0)  fullTimeline.push({ mood: "happy",   eyeState: "open",     duration: preRollSec });
    fullTimeline.push(...FART_TIMELINE);
    if (postRollSec > 0) fullTimeline.push({ mood: "happy",   eyeState: "open",     duration: postRollSec });

    // Render unique frames once, cache by tuple key.
    const cache: Record<string, string> = {};
    for (const block of fullTimeline) {
      const key = tupleKey(block);
      if (cache[key]) continue;
      const buf = await composeFrame({
        monster, mood: block.mood, eyeState: block.eyeState, bgColor,
        clothing, bottom, cape, mustache, mouthStyle, backgroundImage, fartFrame: block.fartFrame, width, height,
      });
      const p = path.join(tmpDir, `${key}.png`);
      fs.writeFileSync(p, buf);
      cache[key] = p;
    }

    // ffmpeg concat list — same pattern as renderBlinkClip
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const lines = ["ffconcat version 1.0"];
    for (const block of fullTimeline) {
      lines.push(`file '${fwd(cache[tupleKey(block)])}'`);
      lines.push(`duration ${block.duration.toFixed(3)}`);
    }
    // Repeat last image without duration directive (ffmpeg quirk)
    const last = fullTimeline[fullTimeline.length - 1];
    lines.push(`file '${fwd(cache[tupleKey(last)])}'`);

    const listPath = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(listPath, lines.join("\n"), "utf-8");

    const totalSec = fullTimeline.reduce((s, b) => s + b.duration, 0);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execSync(
      [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", `"${listPath}"`,
        "-vsync", "vfr",
        "-vf", `fps=${fps},format=yuv420p`,
        "-c:v", "libx264",
        "-t", String(totalSec),
        `"${outputPath}"`,
      ].join(" "),
      { stdio: "pipe" },
    );

    console.log(`💨  ${monster} fart sequence (${totalSec.toFixed(1)}s) → ${path.resolve(outputPath)}`);
    return outputPath;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------
// Brady Bunch grid — 3×3 layout, center cell is a title card
//
//   cells[0]  cells[1]  cells[2]
//   cells[3]  TITLE     cells[4]
//   cells[5]  cells[6]  cells[7]
// ----------------------------------------------------------------
export interface GridCell {
  monster: Monster;
  mood?: Mood;
  bgColor?: string;
  clothing?: string[];
  bottom?: string;
  cape?: string;
  mustache?: string;
  mouthStyle?: string;
  /** Behavior beat to play during the main loop. Stagger these across cells for a cascade. */
  behavior?: "fart" | "eyeRoll";
  /** When (seconds into the main loop) the behavior fires. Defaults vary per behavior. */
  behaviorAt?: number;
}

export interface BradyBunchOpts {
  cells: GridCell[];        // exactly 8 — order is row-major skipping the title cell:
                            //   [0] [1] [2]
                            //   [3] TITLE [4]
                            //   [5] [6] [7]
  titleText?: string;       // default: "HabitBeast"
  titleSubtext?: string;    // default: tagline
  titleBgColor?: string;    // default: "#1a1a24"
  titleColor?: string;      // default: "#FFFFFF"

  // Center-slide intro phases — each monster pops into the center cell, holds
  // briefly, then slides to its assigned grid position. Repeat for all 8.
  /** Seconds each monster holds in the center cell before sliding. Default: 0.4 */
  centerHoldSec?: number;
  /** Seconds the center-to-cell slide takes. Default: 0.4 */
  slideSec?: number;
  /** Seconds the grid is fully filled before the title pops in. Default: 0.25 */
  gridSettleSec?: number;
  /** Seconds the title scales in. Default: 0.55 */
  titlePopSec?: number;

  /** Duration of the main loop AFTER intro + title. Default: 10 */
  loopSec?: number;
  /** Backward-compat: sets loopSec if provided. */
  durationSec?: number;

  fps?: number;             // default: 24
  cellSize?: number;        // default: 360 → grid is 1080×1080
  outputPath: string;
}

/**
 * Brady Bunch montage with a center-slide intro:
 *   1. Each monster pops into the center cell (where the title eventually
 *      lives), holds briefly, then slides to its assigned grid position.
 *      Repeat for all 8 cells.
 *   2. After all 8 are seated, the title card pops into the center.
 *   3. The main loop runs — each cell blinks normally, with mood drift and
 *      optional behavior beats (fart, eye-roll) per GridCell.behavior.
 *
 * Frame-by-frame composition (sharp + ffmpeg). The cache is keyed by
 * `(mood, eyeState)` tuples — only the combos the timelines actually use are
 * rendered, which keeps it light even with mood drift.
 */
export async function renderBradyBunch(opts: BradyBunchOpts): Promise<string> {
  const {
    cells,
    titleText = "HabitBeast",
    titleSubtext = "every habit makes a monster",
    titleBgColor = "#1a1a24",
    titleColor = "#FFFFFF",
    centerHoldSec = 0.4,
    slideSec = 0.4,
    gridSettleSec = 0.25,
    titlePopSec = 0.55,
    loopSec: loopSecOpt,
    durationSec,
    fps = 24,
    cellSize = 360,
    outputPath,
  } = opts;

  const loopSec = loopSecOpt ?? durationSec ?? 10;

  if (cells.length !== 8) {
    throw new Error(`Brady Bunch expects exactly 8 cells (got ${cells.length}); the center cell is the title card.`);
  }
  ensureFfmpeg();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `brady-`));
  const canvasSize = cellSize * 3;

  try {
    // ── 1. Build per-cell timelines and lazily render reference frames ──
    // Cache is keyed by `${mood}_${eye}` so mood-drift naturally adds entries.
    // We only render frames at cellSize — the new center-slide intro keeps
    // monsters at cellSize the whole time (no fullscreen variant needed).
    type CellRender = {
      cell: GridCell;
      cellFrames: Record<string, string>;       // key: `${mood}_${eye}`
      timeline: Block[];                         // for the main loop
      fart?: { startSec: number; cellByKey: Record<string, string> };
    };

    const renders: CellRender[] = [];
    for (let i = 0; i < 8; i++) {
      const cell = cells[i];
      const mood = cell.mood ?? "happy";
      const bgColor = cell.bgColor ?? "#FFE566";
      const seed = hashSeed(`brady-cell${i}-${cell.monster}-${mood}-${bgColor}`);

      const cellFrames: Record<string, string> = {};

      const ensureCellFrame = async (m: Mood, s: EyeState) => {
        const k = `${m}_${s}`;
        if (cellFrames[k]) return;
        const buf = await composeFrame({
          monster: cell.monster, mood: m, eyeState: s, bgColor,
          clothing: cell.clothing, bottom: cell.bottom, cape: cell.cape, mustache: cell.mustache, mouthStyle: cell.mouthStyle,
          width: cellSize, height: cellSize,
        });
        const p = path.join(tmpDir, `c${i}_${k}.png`);
        fs.writeFileSync(p, buf);
        cellFrames[k] = p;
      };

      // Always render the start mood × open at minimum — needed for the intro
      // hold (we don't sample the timeline during intro, just show "open").
      await ensureCellFrame(mood, "open");

      // Timeline for the main loop. eyeRoll → forced openUp at behaviorAt.
      const eyeRollAt = cell.behavior === "eyeRoll" ? (cell.behaviorAt ?? loopSec / 2) : undefined;
      const timeline = generateTimeline(mood, loopSec, seed, { forceEyeRollAt: eyeRollAt });

      // Render every (mood, eye) tuple the timeline actually uses.
      for (const block of timeline) await ensureCellFrame(block.mood, block.state);

      let fart: CellRender["fart"] | undefined;
      if (cell.behavior === "fart") {
        const startSec = cell.behaviorAt ?? Math.max(0.5, (loopSec - FART_DURATION_SEC) / 2);
        const cellByKey: Record<string, string> = {};
        for (const block of FART_TIMELINE) {
          const k = `${block.mood}_${block.eyeState}_${block.fartFrame ?? "none"}`;
          if (cellByKey[k]) continue;
          const buf = await composeFrame({
            monster: cell.monster, mood: block.mood, eyeState: block.eyeState,
            bgColor, clothing: cell.clothing, bottom: cell.bottom, cape: cell.cape, mustache: cell.mustache, mouthStyle: cell.mouthStyle,
            fartFrame: block.fartFrame, width: cellSize, height: cellSize,
          });
          const p = path.join(tmpDir, `c${i}_fart_${k}.png`);
          fs.writeFileSync(p, buf);
          cellByKey[k] = p;
        }
        fart = { startSec, cellByKey };
      }

      renders.push({ cell, cellFrames, timeline, fart });
    }

    // ── 2. Title card ──
    const titleSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${cellSize}" height="${cellSize}">
        <rect width="100%" height="100%" fill="${titleBgColor}"/>
        <text x="50%" y="48%" text-anchor="middle"
              font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(cellSize * 0.13)}"
              font-weight="700" fill="${titleColor}">${escapeXml(titleText)}</text>
        <text x="50%" y="62%" text-anchor="middle"
              font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(cellSize * 0.045)}"
              font-weight="400" fill="${titleColor}" opacity="0.7">${escapeXml(titleSubtext)}</text>
      </svg>
    `.trim();
    const titlePngPath = path.join(tmpDir, "title.png");
    fs.writeFileSync(titlePngPath, await sharp(Buffer.from(titleSvg)).png().toBuffer());

    // ── 3. Master timeline ──
    const perMonsterIntroSec = centerHoldSec + slideSec;
    const introTotalSec = 8 * perMonsterIntroSec;
    const titleStart    = introTotalSec + gridSettleSec;
    const loopStart     = titleStart + titlePopSec;
    const totalSec      = loopStart + loopSec;

    // Cell positions (top-left corners) in row-major order, skipping center title cell.
    const cellPositions = [
      { x: 0,             y: 0 },             // 0 top-left
      { x: cellSize,      y: 0 },             // 1 top-mid
      { x: 2 * cellSize,  y: 0 },             // 2 top-right
      { x: 0,             y: cellSize },      // 3 mid-left
      { x: 2 * cellSize,  y: cellSize },      // 4 mid-right
      { x: 0,             y: 2 * cellSize },  // 5 bot-left
      { x: cellSize,      y: 2 * cellSize },  // 6 bot-mid
      { x: 2 * cellSize,  y: 2 * cellSize },  // 7 bot-right
    ];
    const titlePos = { x: cellSize, y: cellSize };

    // Sample helpers — eyeStateAt also returns the mood at that time so we can
    // pick the right (mood, eye) reference frame.
    const sampleAt = (timeline: Block[], localT: number): { state: EyeState; mood: Mood } => {
      let acc = 0;
      for (const b of timeline) {
        if (localT < acc + b.duration) return { state: b.state, mood: b.mood };
        acc += b.duration;
      }
      const last = timeline[timeline.length - 1];
      return { state: last.state, mood: last.mood };
    };
    const easeInOutCubic = (x: number) =>
      x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const easeOutBack = (x: number) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    };

    // Cell intro state machine — center-hold, then slide to assigned grid cell.
    type CellState =
      | { phase: "hidden" }
      | { phase: "centerHold"; localT: number }
      | { phase: "sliding";    localT: number; progress: number }
      | { phase: "settled";    localT: number };

    const cellStateAt = (i: number, t: number): CellState => {
      const start    = i * perMonsterIntroSec;
      const holdEnd  = start + centerHoldSec;
      const slideEnd = holdEnd + slideSec;
      if (t < start)    return { phase: "hidden" };
      if (t < holdEnd)  return { phase: "centerHold", localT: t - start };
      if (t < slideEnd) return { phase: "sliding",    localT: t - start, progress: easeInOutCubic((t - holdEnd) / slideSec) };
      return { phase: "settled", localT: t - start };
    };

    // ── 4. Render every output frame ──
    const totalFrames = Math.max(1, Math.ceil(totalSec * fps));
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });

    const bgRgb = hexToRgb(titleBgColor);

    // While a monster is in the centerHold or sliding phase we just show its
    // dominant "open" frame — keeps the cache lean and the intro readable.
    const introFrameOf = (r: { cell: GridCell; cellFrames: Record<string, string> }) => {
      const introMood = r.cell.mood ?? "happy";
      return r.cellFrames[`${introMood}_open`];
    };

    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;

      type Layer = { input: Buffer | string; left: number; top: number };
      const layers: Layer[] = [];

      // Pass 1: settled cells + cells whose intro hasn't started — drawn behind
      // any active intro monster so the slide always reads cleanly.
      for (let i = 0; i < 8; i++) {
        const r = renders[i];
        const cs = cellStateAt(i, t);
        if (cs.phase !== "settled") continue;

        // Loop only starts at `loopStart`. Before then (during gridSettle + titlePop),
        // settled cells just sit calmly with the cell's start mood/open eye.
        if (t < loopStart) {
          layers.push({ input: introFrameOf(r), left: cellPositions[i].x, top: cellPositions[i].y });
          continue;
        }

        // Loop phase — apply fart override if applicable
        const loopT = t - loopStart;
        if (r.fart) {
          const fartLocal = loopT - r.fart.startSec;
          if (fartLocal >= 0 && fartLocal < FART_DURATION_SEC) {
            let acc = 0;
            for (const block of FART_TIMELINE) {
              if (fartLocal < acc + block.duration) {
                const k = `${block.mood}_${block.eyeState}_${block.fartFrame ?? "none"}`;
                layers.push({ input: r.fart.cellByKey[k], left: cellPositions[i].x, top: cellPositions[i].y });
                break;
              }
              acc += block.duration;
            }
            continue;
          }
        }

        const sample = sampleAt(r.timeline, loopT);
        layers.push({
          input: r.cellFrames[`${sample.mood}_${sample.state}`],
          left: cellPositions[i].x, top: cellPositions[i].y,
        });
      }

      // Pass 2: the cell currently being introduced (centerHold or sliding) —
      // drawn on top so its motion is always clear.
      for (let i = 0; i < 8; i++) {
        const r = renders[i];
        const cs = cellStateAt(i, t);

        if (cs.phase === "centerHold") {
          layers.push({ input: introFrameOf(r), left: titlePos.x, top: titlePos.y });
        } else if (cs.phase === "sliding") {
          const p = cs.progress;
          const x = Math.round(titlePos.x + (cellPositions[i].x - titlePos.x) * p);
          const y = Math.round(titlePos.y + (cellPositions[i].y - titlePos.y) * p);
          layers.push({ input: introFrameOf(r), left: x, top: y });
        }
      }

      // Title card — pop animation (scale up with overshoot)
      if (t >= titleStart) {
        const popLocalT = t - titleStart;
        if (popLocalT < titlePopSec) {
          const p = easeOutBack(Math.min(1, popLocalT / titlePopSec));
          const scaled = Math.max(1, Math.round(cellSize * p));
          const offsetX = titlePos.x + Math.round((cellSize - scaled) / 2);
          const offsetY = titlePos.y + Math.round((cellSize - scaled) / 2);
          const buf = await sharp(titlePngPath).resize(scaled, scaled).png().toBuffer();
          layers.push({ input: buf, left: offsetX, top: offsetY });
        } else {
          layers.push({ input: titlePngPath, left: titlePos.x, top: titlePos.y });
        }
      }

      // Composite
      const frameBuf = await sharp({
        create: { width: canvasSize, height: canvasSize, channels: 4, background: bgRgb },
      })
        .composite(layers)
        .png()
        .toBuffer();

      const framePath = path.join(framesDir, `f${String(f).padStart(5, "0")}.png`);
      fs.writeFileSync(framePath, frameBuf);
    }

    // ── 5. Encode frames → mp4 ──
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const fwd = (p: string) => p.replace(/\\/g, "/");
    execSync(
      [
        "ffmpeg", "-y",
        "-framerate", String(fps),
        "-i", `"${fwd(path.join(framesDir, "f%05d.png"))}"`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        `"${outputPath}"`,
      ].join(" "),
      { stdio: "pipe" },
    );

    console.log(`✅  Brady Bunch (cinematic intro, ${totalSec.toFixed(1)}s) → ${path.resolve(outputPath)}`);
    return outputPath;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------
// Lineup Pan — 8 monsters stacked horizontally, camera does
// "zoom out (overview) → zoom in & pan across → zoom out (overview)"
//
// Rendering strategy: pre-render each monster's 7 cell-state PNGs at the
// pan-zoom cell size, then for each output frame compute the camera viewport
// (scale + x offset) and crop/composite the visible portion of the strip.
// ----------------------------------------------------------------
export interface LineupPanOpts {
  cells: GridCell[];        // exactly 8
  /** Output viewport (default 1920×1080). */
  width?: number;
  height?: number;
  /** Height of each cell when zoomed-in. Default: matches output height. */
  cellSize?: number;
  /** Seconds the wide overview holds at start + end. Default: 1.4 */
  overviewSec?: number;
  /** Seconds the camera spends panning across all 8 zoomed-in. Default: 8.0 */
  panSec?: number;
  /** Seconds the zoom-in / zoom-out transitions take. Default: 1.0 each */
  zoomSec?: number;
  fps?: number;             // default: 24
  bgColor?: string;         // default: black, matches the title bg
  outputPath: string;
}

export async function renderLineupPan(opts: LineupPanOpts): Promise<string> {
  const {
    cells,
    width = 1920,
    height = 1080,
    cellSize: cellSizeOpt,
    overviewSec = 1.4,
    panSec = 8.0,
    zoomSec = 1.0,
    fps = 24,
    bgColor = "#0e0e14",
    outputPath,
  } = opts;
  if (cells.length !== 8) {
    throw new Error(`Lineup Pan expects exactly 8 cells (got ${cells.length}).`);
  }
  ensureFfmpeg();

  const cellSize = cellSizeOpt ?? height; // square cells matching output height
  const stripW = cellSize * 8;
  const stripH = cellSize;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `lineup-`));

  try {
    // 1. Per-cell timelines + lazy frame cache keyed by (mood, eye)
    type CellRender = {
      cell: GridCell;
      cellFrames: Record<string, string>;     // key: `${mood}_${eye}`
      timeline: Block[];
      fart?: { startSec: number; cellByKey: Record<string, string> };
    };
    const totalSec = overviewSec * 2 + zoomSec * 2 + panSec;
    const loopSec = totalSec; // each cell's loop runs the full master duration

    const renders: CellRender[] = [];
    for (let i = 0; i < 8; i++) {
      const cell = cells[i];
      const mood = cell.mood ?? "happy";
      const bg   = cell.bgColor ?? "#FFE566";
      const seed = hashSeed(`lineup-${i}-${cell.monster}-${mood}-${bg}`);
      const cellFrames: Record<string, string> = {};

      const ensureCellFrame = async (m: Mood, s: EyeState) => {
        const k = `${m}_${s}`;
        if (cellFrames[k]) return;
        const buf = await composeFrame({
          monster: cell.monster, mood: m, eyeState: s, bgColor: bg,
          clothing: cell.clothing, bottom: cell.bottom, cape: cell.cape, mustache: cell.mustache, mouthStyle: cell.mouthStyle,
          width: cellSize, height: cellSize,
        });
        const p = path.join(tmpDir, `c${i}_${k}.png`);
        fs.writeFileSync(p, buf);
        cellFrames[k] = p;
      };

      const eyeRollAt = cell.behavior === "eyeRoll" ? (cell.behaviorAt ?? loopSec / 2) : undefined;
      const timeline = generateTimeline(mood, loopSec, seed, { forceEyeRollAt: eyeRollAt });

      // Render every (mood, eye) combo the timeline actually uses.
      for (const block of timeline) await ensureCellFrame(block.mood, block.state);

      let fart: CellRender["fart"] | undefined;
      if (cell.behavior === "fart") {
        const startSec = cell.behaviorAt ?? Math.max(0.5, (loopSec - FART_DURATION_SEC) / 2);
        const cellByKey: Record<string, string> = {};
        for (const block of FART_TIMELINE) {
          const k = `${block.mood}_${block.eyeState}_${block.fartFrame ?? "none"}`;
          if (cellByKey[k]) continue;
          const buf = await composeFrame({
            monster: cell.monster, mood: block.mood, eyeState: block.eyeState,
            bgColor: bg, clothing: cell.clothing, bottom: cell.bottom, cape: cell.cape, mustache: cell.mustache, mouthStyle: cell.mouthStyle,
            fartFrame: block.fartFrame, width: cellSize, height: cellSize,
          });
          const p = path.join(tmpDir, `c${i}_fart_${k}.png`);
          fs.writeFileSync(p, buf);
          cellByKey[k] = p;
        }
        fart = { startSec, cellByKey };
      }
      renders.push({ cell, cellFrames, timeline, fart });
    }

    // 2. Camera math — scale + x offset over time
    // Phase A (overview hold): t in [0, overviewSec) — strip fits inside viewport
    // Phase B (zoom in):       t in [overviewSec, overviewSec+zoomSec) — scale grows from fitScale to 1.0
    // Phase C (pan):           t in [overviewSec+zoomSec, overviewSec+zoomSec+panSec) — scale=1, x sweeps left→right
    // Phase D (zoom out):      t in [..., +zoomSec) — scale shrinks back to fitScale
    // Phase E (overview hold): t in [..., +overviewSec)

    // fitScale: how much we shrink the strip so it fits horizontally in the viewport
    const fitScale = width / stripW; // e.g. 1920/8640 = 0.222
    const zoomedScale = height / stripH; // e.g. 1080/1080 = 1.0 — fills viewport vertically

    const phaseA_end = overviewSec;
    const phaseB_end = phaseA_end + zoomSec;
    const phaseC_end = phaseB_end + panSec;
    const phaseD_end = phaseC_end + zoomSec;
    const phaseE_end = phaseD_end + overviewSec;

    const ease = (x: number) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

    // The pan range — when zoomed in, x_offset spans 0 → (stripW * zoomedScale - width)
    const panRange = stripW * zoomedScale - width;

    type Camera = { scale: number; xOffset: number };
    const cameraAt = (t: number): Camera => {
      if (t < phaseA_end) return { scale: fitScale, xOffset: 0 };
      if (t < phaseB_end) {
        const p = ease((t - phaseA_end) / zoomSec);
        const scale = fitScale + (zoomedScale - fitScale) * p;
        // xOffset: hold focus on cell 0 as we zoom in
        const xOffset = 0 * p; // already at 0
        return { scale, xOffset };
      }
      if (t < phaseC_end) {
        const p = ease((t - phaseB_end) / panSec);
        return { scale: zoomedScale, xOffset: p * panRange };
      }
      if (t < phaseD_end) {
        const p = ease((t - phaseC_end) / zoomSec);
        const scale = zoomedScale + (fitScale - zoomedScale) * p;
        // xOffset shrinks toward 0 as we zoom out (centered overview)
        const targetX = 0;
        const xOffset = panRange + (targetX - panRange) * p;
        return { scale, xOffset };
      }
      // Phase E
      return { scale: fitScale, xOffset: 0 };
    };

    // Sampling — returns both eye state and mood so we can index the
    // (mood, eye) frame cache correctly when mood drift is active.
    const sampleAt = (timeline: Block[], localT: number): { state: EyeState; mood: Mood } => {
      let acc = 0;
      for (const b of timeline) {
        if (localT < acc + b.duration) return { state: b.state, mood: b.mood };
        acc += b.duration;
      }
      const last = timeline[timeline.length - 1];
      return { state: last.state, mood: last.mood };
    };

    // 3. Render frames
    const totalFrames = Math.max(1, Math.ceil(phaseE_end * fps));
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const bgRgb = hexToRgb(bgColor);

    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      const cam = cameraAt(t);

      // For each cell, figure out what frame to use and where it sits in the
      // virtual strip. The strip is laid out at cellSize × cellSize per cell.
      type Layer = { input: Buffer | string; left: number; top: number };
      const layers: Layer[] = [];

      // Render each cell's current frame at scaled size, positioned by camera
      const scaledCellSize = Math.max(1, Math.round(cellSize * cam.scale));
      const scaledStripH   = Math.max(1, Math.round(stripH * cam.scale));
      const verticalOffset = Math.round((height - scaledStripH) / 2); // center vertically

      for (let i = 0; i < 8; i++) {
        const r = renders[i];

        // Per-cell frame source
        let framePath: string;
        if (r.fart) {
          const fartLocal = t - r.fart.startSec;
          if (fartLocal >= 0 && fartLocal < FART_DURATION_SEC) {
            let acc = 0; let chosen = "";
            for (const block of FART_TIMELINE) {
              if (fartLocal < acc + block.duration) {
                chosen = `${block.mood}_${block.eyeState}_${block.fartFrame ?? "none"}`;
                break;
              }
              acc += block.duration;
            }
            framePath = r.fart.cellByKey[chosen];
          } else {
            const s = sampleAt(r.timeline, t);
            framePath = r.cellFrames[`${s.mood}_${s.state}`];
          }
        } else {
          const s = sampleAt(r.timeline, t);
          framePath = r.cellFrames[`${s.mood}_${s.state}`];
        }

        // Where this cell sits in the (scaled) strip:
        const cellLeftInStrip = i * cellSize * cam.scale;
        const cellLeftOnCanvas = Math.round(cellLeftInStrip - cam.xOffset);
        const cellTopOnCanvas = verticalOffset;

        // Skip if entirely off-canvas
        if (cellLeftOnCanvas + scaledCellSize <= 0 || cellLeftOnCanvas >= width) continue;

        const buf = await sharp(framePath).resize(scaledCellSize, scaledCellSize).png().toBuffer();
        layers.push({ input: buf, left: cellLeftOnCanvas, top: cellTopOnCanvas });
      }

      const frameBuf = await sharp({
        create: { width, height, channels: 4, background: bgRgb },
      })
        .composite(layers)
        .png()
        .toBuffer();

      fs.writeFileSync(path.join(framesDir, `f${String(f).padStart(5, "0")}.png`), frameBuf);
    }

    // 4. Encode
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const fwd = (p: string) => p.replace(/\\/g, "/");
    execSync(
      [
        "ffmpeg", "-y",
        "-framerate", String(fps),
        "-i", `"${fwd(path.join(framesDir, "f%05d.png"))}"`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        `"${outputPath}"`,
      ].join(" "),
      { stdio: "pipe" },
    );

    console.log(`🎥  Lineup Pan (${phaseE_end.toFixed(1)}s) → ${path.resolve(outputPath)}`);
    return outputPath;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ensureFfmpeg() {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "ffmpeg not found on PATH. Install ffmpeg (https://ffmpeg.org) and try again.",
    );
  }
}

// ----------------------------------------------------------------
// Default Brady Bunch preset — varied moods + colors across all 8 monsters,
// plus a choreographed behavior cascade timed across the main loop:
//   t=1.2s  Wolf (excited)    eye-roll        ← cheeky reaction
//   t=2.6s  Biggs (happy)     eye-roll        ← deadpan beat
//   t=3.8s  Wrapps (upset)    fart starts     ← ~6.4s sequence
//   t=6.5s  Iggs  (okay)      eye-roll        ← while Wrapps is mid-fart
//   t=8.5s  Entsy (excited)   fart starts     ← finale
// Stumbles (sad) and Murk (okay) get the natural sad/upset eye-roll passes.
// Default loopSec defaults to 12 so the cascade lands cleanly.
// ----------------------------------------------------------------
export const DEFAULT_GRID: GridCell[] = [
  // Top row
  { monster: "frank",    mood: "happy",   bgColor: "#FFE566" },                                 // 0 — warm yellow, calm
  { monster: "wolf",     mood: "excited", bgColor: "#FF6B6B", behavior: "eyeRoll", behaviorAt: 1.2 }, // 1 — coral
  { monster: "iggs",     mood: "okay",    bgColor: "#87CEEB", behavior: "eyeRoll", behaviorAt: 6.5 }, // 2 — sky
  // Middle row (center = TITLE)
  { monster: "stumbles", mood: "sad",     bgColor: "#C8A4FF" },                                 // 3 — lavender (natural eye-roll)
  { monster: "wrapps",   mood: "upset",   bgColor: "#FFB877", behavior: "fart",    behaviorAt: 3.8 }, // 4 — peach
  // Bottom row
  { monster: "biggs",    mood: "happy",   bgColor: "#00CC44", behavior: "eyeRoll", behaviorAt: 2.6 }, // 5 — green
  { monster: "murk",     mood: "okay",    bgColor: "#3399FF" },                                 // 6 — blue
  { monster: "entsy",    mood: "excited", bgColor: "#FFF8E7", behavior: "fart",    behaviorAt: 8.5 }, // 7 — cream
];

// Default lineup preset — same cast in a different order, lighter behavior
// load (camera passes too quickly for the long fart sequence to land cleanly).
export const DEFAULT_LINEUP: GridCell[] = [
  { monster: "frank",    mood: "happy",   bgColor: "#FFE566" },
  { monster: "wolf",     mood: "excited", bgColor: "#FF6B6B", behavior: "eyeRoll", behaviorAt: 2.0 },
  { monster: "wrapps",   mood: "upset",   bgColor: "#FFB877" },
  { monster: "stumbles", mood: "sad",     bgColor: "#C8A4FF" },
  { monster: "biggs",    mood: "happy",   bgColor: "#00CC44", behavior: "eyeRoll", behaviorAt: 6.0 },
  { monster: "murk",     mood: "okay",    bgColor: "#3399FF" },
  { monster: "iggs",     mood: "okay",    bgColor: "#87CEEB" },
  { monster: "entsy",    mood: "excited", bgColor: "#FFF8E7" },
];

// ----------------------------------------------------------------
// CLI
// ----------------------------------------------------------------
async function main() {
  const [, , cmd, ...args] = process.argv;

  if (cmd === "one") {
    const monster = args[0] as Monster;
    if (!monster || !EYE_FOLDER[monster]) {
      console.error(`Usage: npm run blink one <monster> [mood] [bgColor] [outPath]`);
      console.error(`  monster: ${[...BIG_MONSTERS, ...SMALL_MONSTERS].join(", ")}`);
      process.exit(1);
    }
    const mood = (args[1] as Mood) || "happy";
    const bgColor = args[2] || "#FFE566";
    const out = args[3] || path.join("blink-output", `${monster}_${mood}_${Date.now()}.mp4`);
    await renderBlinkClip({ monster, mood, bgColor, outputPath: out });
  } else if (cmd === "fart") {
    const monster = args[0] as Monster;
    if (!monster || !EYE_FOLDER[monster]) {
      console.error("Usage: npm run blink fart <monster> [bgColor] [outPath]");
      console.error("  monster: " + [...BIG_MONSTERS, ...SMALL_MONSTERS].join(", "));
      process.exit(1);
    }
    const bgColor = args[1] || "#FFE566";
    const out = args[2] || path.join("blink-output", monster + "_fart_" + Date.now() + ".mp4");
    await renderFartClip({ monster, bgColor, preRollSec: 0.5, postRollSec: 0.5, outputPath: out });
  } else if (cmd === "grid") {
    const out = args[0] || path.join("blink-output", "brady_" + Date.now() + ".mp4");
    await renderBradyBunch({ cells: DEFAULT_GRID, outputPath: out });
  } else if (cmd === "lineup") {
    const out = args[0] || path.join("blink-output", "lineup_" + Date.now() + ".mp4");
    await renderLineupPan({ cells: DEFAULT_LINEUP, outputPath: out });
  } else {
    console.log([
      "Usage:",
      "  npm run blink one    <monster> [mood] [bgColor] [outPath]   -- single blinking loop",
      "  npm run blink fart   <monster> [bgColor] [outPath]           -- full fart sequence (~7s)",
      "  npm run blink grid   [outPath]                               -- Brady Bunch with cinematic intro",
      "  npm run blink lineup [outPath]                               -- 8-monster horizontal pan",
      "",
      "Monsters: " + [...BIG_MONSTERS, ...SMALL_MONSTERS].join(", "),
      "Moods:    happy, okay, excited, sad, upset",
    ].join("\n"));
    process.exit(cmd ? 1 : 0);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("X", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
