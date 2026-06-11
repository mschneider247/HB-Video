import { Router } from "express";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import sharp from "sharp";
import { MONSTERS_DIR, OUTPUT_DIR } from "../config";
import { BIG_MONSTERS, SMALL_MONSTERS } from "../constants";
import { composeFrame, Monster, Mood, EyeState } from "../blink";
import { aspectRatioDims } from "../utils/composite";

const router = Router();

const ALL_MONSTERS: string[] = [...BIG_MONSTERS, ...SMALL_MONSTERS];
const MOODS: Mood[] = ["happy", "okay", "excited", "sad", "upset"];
const EYE_STATES_VISUAL: EyeState[] = ["open", "openWide", "partial", "partialLeft", "partialRight"];

const FLAT_COLORS = [
  "#FFFFFF", "#FFF8E7", "#D0D0D0", "#87CEEB", "#00CC44",
  "#FFE566", "#FF6B6B", "#3399FF", "#C8A4FF", "#FFB877",
];

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

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Exponentially accelerating frame schedule — starts slow (~0.55s), ends fast (~0.05s).
// Uses progress^1.5 for a gentle build that goes frantic near the end.
function generateTempoSchedule(totalSec: number): number[] {
  const maxInterval = 0.55;
  const minInterval = 0.05;
  const durations: number[] = [];
  let t = 0;
  while (t < totalSec - 0.001) {
    const progress = t / totalSec;
    const interval = maxInterval * Math.pow(minInterval / maxInterval, Math.pow(progress, 1.5));
    const dur = Math.min(interval, totalSec - t);
    if (dur < 0.001) break;
    durations.push(dur);
    t += dur;
  }
  return durations;
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}

// Returns the x,y center of the text at localT seconds into this text's display window.
function getTextPos(
  text: string, style: 1 | 2 | 3, localT: number,
  totalDur: number, W: number, H: number, fontSize: number,
): { x: number; y: number } {
  const estW = text.length * fontSize * 0.58;
  const inDur = 0.28;
  const outDur = 0.28;
  const holdEnd = totalDur - outDur;

  if (style === 1) {
    // Slide in from right → hold center-left third → slide out left
    const cy = Math.round(H * 0.35);
    let cx: number;
    if (localT < inDur) {
      cx = W + estW / 2 - (W + estW / 2 - W / 2) * easeOut(localT / inDur);
    } else if (localT < holdEnd) {
      cx = W / 2;
    } else {
      cx = W / 2 - (W + estW / 2) * easeOut((localT - holdEnd) / outDur);
    }
    return { x: Math.round(cx), y: cy };
  } else if (style === 2) {
    // Drop from top → hold center → drop out bottom
    const cx = Math.round(W / 2);
    let cy: number;
    if (localT < inDur) {
      cy = -fontSize + (H / 2 + fontSize) * easeOut(localT / inDur);
    } else if (localT < holdEnd) {
      cy = H / 2;
    } else {
      cy = H / 2 + H * easeOut((localT - holdEnd) / outDur);
    }
    return { x: cx, y: Math.round(cy) };
  } else {
    // Style 3: sweep up from bottom-left → stays at lower third
    const targetY = H * 0.72;
    let cx: number, cy: number;
    if (localT < inDur) {
      const p = easeOut(localT / inDur);
      cx = -estW / 2 + (W / 2 + estW / 2) * p;
      cy = H + fontSize - (H + fontSize - targetY) * p;
    } else {
      cx = W / 2;
      cy = targetY;
    }
    return { x: Math.round(cx), y: Math.round(cy) };
  }
}

function makeSvgTextBuffer(
  text: string, style: 1 | 2 | 3, localT: number,
  totalDur: number, W: number, H: number, fontSize: number,
): Buffer {
  const { x, y } = getTextPos(text, style, localT, totalDur, W, H, fontSize);
  const strokeW = Math.max(3, Math.round(fontSize * 0.07));
  const fill = style === 3 ? "#FFE566" : "white";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <text x="${x}" y="${y}"
      font-family="Impact, Arial Black, sans-serif"
      font-size="${fontSize}" font-weight="900"
      fill="${fill}" stroke="black" stroke-width="${strokeW}"
      paint-order="stroke" text-anchor="middle" dominant-baseline="central"
    >${escapeXml(text)}</text>
  </svg>`;
  return Buffer.from(svg);
}

interface TempoCombo {
  monster: Monster;
  mood: Mood;
  eyeState: EyeState;
  bgColor: string;
  backgroundImage?: string;
  clothing: string[];
}

router.post("/api/tempo-reel", async (req, res) => {
  const {
    duration: durationIn = 9,
    texts = ["", "", ""],
    aspectRatio = "9:16",
    seed: seedIn,
  } = req.body as {
    duration?: number;
    texts?: string[];
    aspectRatio?: string;
    seed?: number;
  };

  const duration = Math.max(7, Math.min(11, Number(durationIn)));
  const fps = 24;

  const [width, height] = aspectRatio === "1:1" ? [1080, 1080] : aspectRatioDims(aspectRatio);

  const seed = typeof seedIn === "number" ? seedIn : Date.now();
  const rng = mulberry32(seed);

  const validMonsters = ALL_MONSTERS.filter(m =>
    fs.existsSync(path.join(MONSTERS_DIR, `${m}.png`))
  ) as Monster[];

  if (validMonsters.length === 0) {
    res.status(500).json({ error: "No monsters found in " + MONSTERS_DIR });
    return;
  }

  function loadClothing(size: "Big" | "Small"): string[] {
    const dir = path.join(MONSTERS_DIR, size);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f =>
      f.endsWith(".png") && !f.endsWith("Bottom.png") && !f.endsWith("Top.png")
    );
  }
  const bigClothing   = loadClothing("Big");
  const smallClothing = loadClothing("Small");

  const bgFolder = path.join(MONSTERS_DIR, "Background");
  const bgImages = fs.existsSync(bgFolder)
    ? fs.readdirSync(bgFolder).filter(f => f.endsWith(".png")).map(f => "Background/" + f)
    : [];

  function isBig(m: Monster): boolean {
    return (BIG_MONSTERS as string[]).includes(m);
  }

  function makeCombo(): TempoCombo {
    const monster = pick(validMonsters, rng);
    const mood = pick(MOODS, rng);
    const eyeState = pick(EYE_STATES_VISUAL, rng);
    let bgColor = pick(FLAT_COLORS, rng);
    let backgroundImage: string | undefined;
    if (bgImages.length > 0 && rng() < 0.3) {
      backgroundImage = pick(bgImages, rng);
      bgColor = "#1a1a24";
    }
    const sizeClothing = isBig(monster) ? bigClothing : smallClothing;
    const clothing: string[] = [];
    if (sizeClothing.length > 0 && rng() < 0.65) {
      clothing.push(pick(sizeClothing, rng));
    }
    return { monster, mood, eyeState, bgColor, backgroundImage, clothing };
  }

  const frameDurations = generateTempoSchedule(duration);
  const combos: TempoCombo[] = frameDurations.map(() => makeCombo());

  // Cache key: everything that affects the rendered pixel output
  const comboKey = (c: TempoCombo) =>
    `${c.monster}|${c.mood}|${c.eyeState}|${c.bgColor}|${c.backgroundImage ?? ""}|${c.clothing.join(",")}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-"));

  try {
    // Render unique combos
    const comboCache = new Map<string, Buffer>();
    for (const combo of combos) {
      const k = comboKey(combo);
      if (comboCache.has(k)) continue;
      const buf = await composeFrame({
        monster: combo.monster,
        mood: combo.mood,
        eyeState: combo.eyeState,
        bgColor: combo.bgColor,
        backgroundImage: combo.backgroundImage,
        clothing: combo.clothing,
        width,
        height,
      });
      comboCache.set(k, buf);
    }

    // Text animation definitions (filtered to non-empty text)
    const textDefs: Array<{ text: string; style: 1 | 2 | 3; startT: number; dur: number }> = [
      { text: String(texts[0] ?? ""), style: 1 as const, startT: duration * 0.20, dur: Math.min(2.0, duration * 0.80) },
      { text: String(texts[1] ?? ""), style: 2 as const, startT: duration * 0.52, dur: Math.min(2.0, duration * 0.48) },
      { text: String(texts[2] ?? ""), style: 3 as const, startT: duration * 0.78, dur: duration * 0.22 },
    ].filter(a => a.text.trim().length > 0);

    // Font sizes: text 3 is the climax — slightly bigger
    const fontSize: Record<1 | 2 | 3, number> = {
      1: Math.round(width * 0.10),
      2: Math.round(width * 0.10),
      3: Math.round(width * 0.13),
    };

    // Build frame → combo index map
    const totalFrames = Math.ceil(duration * fps);
    const comboAtFrame: number[] = new Array(totalFrames);
    let t = 0, ci = 0;
    for (let f = 0; f < totalFrames; f++) {
      const ft = f / fps;
      while (ci < combos.length - 1 && ft >= t + frameDurations[ci]) {
        t += frameDurations[ci];
        ci++;
      }
      comboAtFrame[f] = ci;
    }

    // Render each output frame
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });

    for (let f = 0; f < totalFrames; f++) {
      const ft = f / fps;
      const comboBuf = comboCache.get(comboKey(combos[comboAtFrame[f]]))!;

      const activeTexts = textDefs.filter(a => ft >= a.startT && ft < a.startT + a.dur);
      if (activeTexts.length === 0) {
        fs.writeFileSync(path.join(framesDir, `f${String(f).padStart(5, "0")}.png`), comboBuf);
      } else {
        const overlays: sharp.OverlayOptions[] = [];
        for (const td of activeTexts) {
          const localT = ft - td.startT;
          const svgBuf = makeSvgTextBuffer(td.text, td.style, localT, td.dur, width, height, fontSize[td.style]);
          overlays.push({ input: await sharp(svgBuf).png().toBuffer() });
        }
        const frameBuf = await sharp(comboBuf).composite(overlays).png().toBuffer();
        fs.writeFileSync(path.join(framesDir, `f${String(f).padStart(5, "0")}.png`), frameBuf);
      }
    }

    // Encode
    const outputFilename = `habitbeast_tempo_${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    const fwd = (p: string) => p.replace(/\\/g, "/");

    execSync(
      [
        "ffmpeg", "-y",
        "-framerate", String(fps),
        "-i", `"${fwd(path.join(framesDir, "f%05d.png"))}"`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-t", String(duration),
        `"${fwd(outputPath)}"`,
      ].join(" "),
      { stdio: "pipe" },
    );

    console.log(`⚡ Tempo Reel (${duration}s, ${combos.length} combos) → ${outputPath}`);
    res.json({ success: true, file: outputFilename });
  } catch (err: any) {
    console.error("❌ tempo-reel error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

export default router;
