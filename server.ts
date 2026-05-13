import express from "express";
import * as path from "path";
import * as fs from "fs";
import { GoogleGenAI } from "@google/genai";
import * as https from "https";
import * as http from "http";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { execSync } from "child_process";
import dotenv from 'dotenv';
import { renderBlinkClip, renderBradyBunch, renderFartClip, renderLineupPan, GridCell } from "./blink";
dotenv.config();

// Find ffmpeg — check PATH, then common Windows install locations
function findFfmpeg(): string | null {
  const candidates = [
    "ffmpeg",
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe`,
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
  ];
  for (const cmd of candidates) {
    try {
      execSync(`"${cmd}" -version`, { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  return null;
}

const FFMPEG_PATH = findFfmpeg();
if (FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(FFMPEG_PATH);
  console.log(`✅ ffmpeg found: ${FFMPEG_PATH}`);
} else {
  console.warn("⚠️  ffmpeg not found — text burning disabled. Install from https://ffmpeg.org/download.html and add to PATH.");
}

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = 3000;
const MONSTERS_DIR = path.join(__dirname, "..", "habitBeast", "public");
const VEO_DIR = __dirname;
const GOOD_TO_GO_DIR = path.join(VEO_DIR, "GoodToGo");
const SCREENSHOTS_INPUT_DIR = path.join(VEO_DIR, "Screenshots");
// Composed/ holds rendered monster frames produced from the canvas composer
// in Splice mode. Treated like a screenshot source for splicing.
const COMPOSED_DIR = path.join(VEO_DIR, "Composed");

// Ensure required subdirs exist
for (const dir of [GOOD_TO_GO_DIR, SCREENSHOTS_INPUT_DIR, COMPOSED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function aspectRatioDims(ar: string): [number, number] {
  if (ar === "1:1")  return [720, 720];
  if (ar === "16:9") return [1280, 720];
  return [720, 1280]; // 9:16 default
}

const MODEL = "veo-2.0-generate-001";
const POLL_INTERVAL_MS = 10_000;
const COST_PER_SECOND = 0.35; // Veo 2 cost per second — update if pricing changes
const LOG_PATH = path.join(VEO_DIR, "generation-log.json");

function logGeneration(durationSeconds: number, file: string) {
  const cost = +(durationSeconds * COST_PER_SECOND).toFixed(4);
  let log: any[] = [];
  if (fs.existsSync(LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8")); } catch {}
  }
  log.push({ timestamp: new Date().toISOString(), durationSeconds, cost, file });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  return cost;
}

function getCostStats() {
  if (!fs.existsSync(LOG_PATH)) return { today: 0, total: 0, runs: 0 };
  try {
    const log: any[] = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    const todayEntries = log.filter(e => e.timestamp.startsWith(today));
    return {
      today: +todayEntries.reduce((s, e) => s + e.cost, 0).toFixed(4),
      total: +log.reduce((s, e) => s + e.cost, 0).toFixed(4),
      runs: log.length,
      todayRuns: todayEntries.length,
    };
  } catch { return { today: 0, total: 0, runs: 0, todayRuns: 0 }; }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌  GEMINI_API_KEY not set. Run: $env:GEMINI_API_KEY = 'your-key'");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ----------------------------------------------------------------
// Size groups
// ----------------------------------------------------------------
const BIG_MONSTERS   = ["frank", "wolf", "murk", "biggs"];
const SMALL_MONSTERS = ["stumbles", "iggs", "wrapps", "entsy"];

// ----------------------------------------------------------------
// Styles
// ----------------------------------------------------------------
const STYLES: Record<string, string> = {
  "Dark Gothic":       "Dark, moody cartoon style. Rich shadows, slightly gothic atmosphere. Think Courage the Cowardly Dog meets Cartoon Network's darker era. Expressive characters, dramatic lighting.",
  "Game Cinematic":    "Stylized 2D game cinematic. Dark fantasy palette, punchy contrast, cel-shaded. Dramatic but comedic.",
  "Saturday Morning":  "Saturday morning cartoon style, bouncy and charming. Bright colors, soft lighting.",
  "Rubber Hose":       "1930s rubber hose cartoon animation. Black and white with splashes of sickly green. Creepy but charming, bouncy movement.",
  "Monster Movie":     "Classic monster movie aesthetic rendered as 2D animation. Moody lighting, deep shadows, slight film grain. Comedic timing.",
  "Graphic Novel":     "Flat 2D graphic novel style. Bold outlines, limited dark palette, dramatic shadow shapes.",
};

// ----------------------------------------------------------------
// Serve static assets from public folder
// ----------------------------------------------------------------
app.use("/assets", express.static(MONSTERS_DIR));

// Serve generated videos from the Veo project folder
app.use("/videos", express.static(VEO_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");
  }
}));

// Serve approved videos and input screenshots
app.use("/goodtogo", express.static(GOOD_TO_GO_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");
  }
}));
app.use("/screenshots", express.static(SCREENSHOTS_INPUT_DIR));
app.use("/composed", express.static(COMPOSED_DIR));

// ----------------------------------------------------------------
// API: cost stats
// ----------------------------------------------------------------
app.get("/api/costs", (_req, res) => {
  res.json({ costPerSecond: COST_PER_SECOND, ...getCostStats() });
});

// ----------------------------------------------------------------
// API: get available assets
// ----------------------------------------------------------------
app.get("/api/assets", (_req, res) => {
  // Backgrounds — two sources:
  //   1. Legacy root-level files (background.png, laboratory.png) — single
  //      backdrops that shipped before the Background/ subfolder existed.
  //   2. public/Background/ — new home for all backdrops going forward
  //      (aquarium.png, playground.png, urban.png, etc.). Returned as
  //      "Background/<file>" so the /assets static route resolves them.
  const rootBgs = ["background.png", "laboratory.png"]
    .filter(f => fs.existsSync(path.join(MONSTERS_DIR, f)));
  const bgFolder = path.join(MONSTERS_DIR, "Background");
  const folderBgs = fs.existsSync(bgFolder)
    ? fs.readdirSync(bgFolder).filter(f => f.endsWith(".png")).sort().map(f => "Background/" + f)
    : [];
  const backgrounds = [...rootBgs, ...folderBgs];

  const monsters = ["frank", "iggs", "murk", "stumbles", "wolf", "wrapps", "biggs", "entsy"]
    .filter(m => fs.existsSync(path.join(MONSTERS_DIR, `${m}.png`)));

  // Lab assistant is a selectable character too
  const labAssistantFile = "lab-assistant.png";
  if (fs.existsSync(path.join(MONSTERS_DIR, labAssistantFile))) {
    monsters.push("lab-assistant");
  }

  const bigClothing   = fs.readdirSync(path.join(MONSTERS_DIR, "Big")).filter(f => f.endsWith(".png"));
  const smallClothing = fs.readdirSync(path.join(MONSTERS_DIR, "Small")).filter(f => f.endsWith(".png"));
  const bottomItems   = fs.readdirSync(path.join(MONSTERS_DIR, "Bottom")).filter(f => f.endsWith(".png"));

  // Capes — paired top + bottom PNGs in {Big|Small}/Paired/. Each cape ships
  // as <name>Top.png and <name>Bottom.png; we only enumerate names that have
  // BOTH halves present so the renderer is guaranteed a complete pair.
  function loadCapes(size: "Big" | "Small"): string[] {
    const dir = path.join(MONSTERS_DIR, size, "Paired");
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    const tops = new Set(files.filter(f => /Top\.png$/i.test(f)).map(f => f.replace(/Top\.png$/i, "")));
    const bots = new Set(files.filter(f => /Bottom\.png$/i.test(f)).map(f => f.replace(/Bottom\.png$/i, "")));
    return [...tops].filter(name => bots.has(name)).sort();
  }
  const bigCapes   = loadCapes("Big");
  const smallCapes = loadCapes("Small");

  // Mood-aware overlays in {size}/Mouths/ — the folder holds 5 base mood files
  // (happy.png, sad.png, etc.) PLUS variant-style files prefixed by their style
  // id (prettyHappy.png, founderSad.png, etc.). We split those into:
  //   - mustaches: style ids known to be mustaches (founder, greenStash, hairy)
  //   - mouthStyles: every other prefix that has all 5 mood variants
  const MOOD_CAPS = ["Happy", "Sad", "Okay", "Excited", "Upset"];
  const KNOWN_MUSTACHE_STYLES = new Set(["founder", "greenStash", "hairy"]);
  function loadMouthAndMustacheStyles(size: "Big" | "Small"): { mustaches: string[]; mouthStyles: string[] } {
    const dir = path.join(MONSTERS_DIR, size, "Mouths");
    if (!fs.existsSync(dir)) return { mustaches: [], mouthStyles: [] };
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".png"));
    const prefixes = new Set<string>();
    for (const f of files) {
      const name = f.replace(/\.png$/i, "");
      for (const cap of MOOD_CAPS) {
        if (name.endsWith(cap) && name.length > cap.length) {
          prefixes.add(name.slice(0, -cap.length));
          break;
        }
      }
    }
    const complete = [...prefixes].filter(p => MOOD_CAPS.every(c => files.includes(`${p}${c}.png`)));
    return {
      mustaches:   complete.filter(p =>  KNOWN_MUSTACHE_STYLES.has(p)).sort(),
      mouthStyles: complete.filter(p => !KNOWN_MUSTACHE_STYLES.has(p)).sort(),
    };
  }
  const bigOverlays   = loadMouthAndMustacheStyles("Big");
  const smallOverlays = loadMouthAndMustacheStyles("Small");
  const bigMustaches   = bigOverlays.mustaches;
  const smallMustaches = smallOverlays.mustaches;
  const bigMouthStyles   = bigOverlays.mouthStyles;
  const smallMouthStyles = smallOverlays.mouthStyles;

  // Mouth layers — monsters ship mouthless; these are composited on top of the monster body.
  // Filenames double as mood labels (excited, happy, okay, sad, upset).
  const bigMouthsDir   = path.join(MONSTERS_DIR, "Big",   "Mouths");
  const smallMouthsDir = path.join(MONSTERS_DIR, "Small", "Mouths");
  const bigMouths   = fs.existsSync(bigMouthsDir)   ? fs.readdirSync(bigMouthsDir).filter(f   => f.endsWith(".png")) : [];
  const smallMouths = fs.existsSync(smallMouthsDir) ? fs.readdirSync(smallMouthsDir).filter(f => f.endsWith(".png")) : [];

  // Eye layers — per-monster, three-state (open/partial/closed), matching Habit Beast's
  // blink state machine. Folder naming is PascalCase (e.g. Big/Eyes/Frank/) while monster
  // body filenames are lowercase (frank.png), so we map explicitly.
  const EYE_FOLDER: Record<string, string> = {
    frank: "Frank", wolf: "Wolf", murk: "Murk", biggs: "Biggs",
    stumbles: "Stumbles", iggs: "Iggs", wrapps: "Wrapps", entsy: "Entsy",
  };
  function loadEyesFor(size: "Big" | "Small", monster: string): string[] {
    const folder = EYE_FOLDER[monster];
    if (!folder) return [];
    const dir = path.join(MONSTERS_DIR, size, "Eyes", folder);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith(".png"));
  }
  // Returns { frank: ["open.png", "partial.png", "closed.png"], ... }
  const bigEyes:   Record<string, string[]> = {};
  const smallEyes: Record<string, string[]> = {};
  for (const m of BIG_MONSTERS)   bigEyes[m]   = loadEyesFor("Big",   m);
  for (const m of SMALL_MONSTERS) smallEyes[m] = loadEyesFor("Small", m);

  const flatColors = [
    { label: "White",   color: "#FFFFFF" },
    { label: "Cream",   color: "#FFF8E7" },
    { label: "Grey",    color: "#D0D0D0" },
    { label: "Sky",     color: "#87CEEB" },
    { label: "Green",   color: "#00CC44" },
    { label: "Yellow",  color: "#FFE566" },
    { label: "Coral",   color: "#FF6B6B" },
    { label: "Blue",    color: "#3399FF" },
    { label: "Lavender",color: "#C8A4FF" },
    { label: "Peach",   color: "#FFB877" },
  ];

  res.json({
    backgrounds,
    monsters,
    bigClothing,
    smallClothing,
    bigCapes,
    smallCapes,
    bigMustaches,
    smallMustaches,
    bigMouthStyles,
    smallMouthStyles,
    bottomItems,
    bigMouths,
    smallMouths,
    bigEyes,
    smallEyes,
    bigMonsters: BIG_MONSTERS,
    smallMonsters: SMALL_MONSTERS,
    styles: Object.keys(STYLES),
    flatColors,
  });
});

// ----------------------------------------------------------------
// API: list screenshots available for appending
// ----------------------------------------------------------------
app.get("/api/screenshots", (_req, res) => {
  const files = fs.existsSync(SCREENSHOTS_INPUT_DIR)
    ? fs.readdirSync(SCREENSHOTS_INPUT_DIR).filter(f => /\.(png|jpe?g)$/i.test(f))
    : [];
  res.json({ screenshots: files });
});

// ----------------------------------------------------------------
// API: list composed frames available for splicing
// ----------------------------------------------------------------
app.get("/api/composed", (_req, res) => {
  const files = fs.existsSync(COMPOSED_DIR)
    ? fs.readdirSync(COMPOSED_DIR).filter(f => /\.(png|jpe?g)$/i.test(f)).sort().reverse()
    : [];
  res.json({ composed: files });
});

// ----------------------------------------------------------------
// API: list approved videos in GoodToGo/
// ----------------------------------------------------------------
app.get("/api/goodtogo", (_req, res) => {
  const files = fs.existsSync(GOOD_TO_GO_DIR)
    ? fs.readdirSync(GOOD_TO_GO_DIR).filter(f => /\.mp4$/i.test(f)).sort().reverse()
    : [];
  res.json({ files });
});

// ----------------------------------------------------------------
// API: approve generated video → move to GoodToGo/
// ----------------------------------------------------------------
app.post("/api/approve", (req, res) => {
  const { file } = req.body;
  if (!file) { res.status(400).json({ error: "No file specified." }); return; }
  const src  = path.join(VEO_DIR, file);
  const dest = path.join(GOOD_TO_GO_DIR, file);
  if (!fs.existsSync(src)) { res.status(404).json({ error: "File not found: " + src }); return; }
  try {
    // Use copy+delete instead of rename — avoids Windows file-lock issues when video is streaming
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
    console.log(`✅ Approved: ${file} → GoodToGo/`);
    res.json({ success: true, file });
  } catch (err: any) {
    console.error("❌ Approve failed:", err.message);
    res.status(500).json({ error: "Failed to move file: " + err.message });
  }
});

// ----------------------------------------------------------------
// API: reject generated video → delete it
// ----------------------------------------------------------------
app.post("/api/reject", (req, res) => {
  const { file } = req.body;
  if (!file) { res.status(400).json({ error: "No file specified." }); return; }
  const filePath = path.join(VEO_DIR, file);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  console.log(`🗑️  Rejected: ${file}`);
  res.json({ success: true });
});

// ----------------------------------------------------------------
// API: append / intersperse screenshots (Ken Burns + fade) with approved video
// ----------------------------------------------------------------
app.post("/api/append-screenshots", async (req, res) => {
  const { file, screenshots, transitionStyle = "punch", mode = "end" } = req.body;
  if (!file || !screenshots?.length) {
    res.status(400).json({ error: "file and screenshots array are required." });
    return;
  }
  if (!FFMPEG_PATH) {
    res.status(500).json({ error: "ffmpeg not found — cannot process screenshots." });
    return;
  }

  const inputPath = path.join(GOOD_TO_GO_DIR, file);
  if (!fs.existsSync(inputPath)) {
    res.status(404).json({ error: "Approved video not found in GoodToGo/." });
    return;
  }

  try {
    const { w: vW, h: vH } = probeVideoDimensions(inputPath);
    console.log(`📐 Video dimensions: ${vW}×${vH}`);

    // Build a screenshot clip for each image
    const ts = Date.now();
    const clipPaths: string[] = [];
    for (let i = 0; i < screenshots.length; i++) {
      const screenshotPath = path.join(SCREENSHOTS_INPUT_DIR, screenshots[i]);
      if (!fs.existsSync(screenshotPath)) {
        throw new Error(`Screenshot not found: ${screenshots[i]}`);
      }
      const clipPath = path.join(VEO_DIR, `_sc_${ts}_${i}.mp4`);
      console.log(`🖼️  Creating clip ${i + 1}/${screenshots.length}: ${screenshots[i]} [${transitionStyle}]`);
      await createScreenshotClip(screenshotPath, clipPath, vW, vH, 4, transitionStyle as ZoomStyle);
      clipPaths.push(clipPath);
    }

    if (mode === "interspersed") {
      // Split the Veo video into N equal segments and interleave with screenshot clips
      const duration = probeVideoDuration(inputPath);
      const n = screenshots.length;
      const segDur = duration / n;
      console.log(`✂️  Splitting ${duration.toFixed(2)}s video into ${n} segments of ~${segDur.toFixed(2)}s each...`);

      const segPaths: string[] = [];
      for (let i = 0; i < n; i++) {
        const segPath = path.join(VEO_DIR, `_seg_${ts}_${i}.mp4`);
        const ss = (i * segDur).toFixed(3);
        const t  = segDur.toFixed(3);
        execSync(
          `"${FFMPEG_PATH}" -i "${inputPath}" -ss ${ss} -t ${t} -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 "${segPath}" -y`,
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        segPaths.push(segPath);
      }

      // Interleave: seg0, ss0, seg1, ss1, …, segN-1, ssN-1
      const allClips: string[] = [];
      for (let i = 0; i < n; i++) {
        allClips.push(segPaths[i]);
        allClips.push(clipPaths[i]);
      }

      const outputName = file.replace(/\.mp4$/i, "_interspersed.mp4");
      const outputPath = path.join(GOOD_TO_GO_DIR, outputName);
      console.log(`🎬 Concatenating ${allClips.length} clips (interspersed)...`);
      await concatClips(allClips, outputPath);

      for (const p of [...clipPaths, ...segPaths]) { try { fs.unlinkSync(p); } catch {} }

      console.log(`✅ Interspersed video: ${outputName}`);
      res.json({ success: true, file: outputName });
    } else {
      // Default: append all screenshots to the end
      const outputName = file.replace(/\.mp4$/i, "_final.mp4");
      const outputPath = path.join(GOOD_TO_GO_DIR, outputName);
      console.log(`🎬 Concatenating ${1 + clipPaths.length} clips (end)...`);
      await concatClips([inputPath, ...clipPaths], outputPath);

      for (const p of clipPaths) { try { fs.unlinkSync(p); } catch {} }

      console.log(`✅ Final video: ${outputName}`);
      res.json({ success: true, file: outputName });
    }
  } catch (err: any) {
    console.error("❌ append-screenshots error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: prepend an intro (image from Screenshots/ or video from GoodToGo/)
// ----------------------------------------------------------------
app.post("/api/prepend-intro", async (req, res) => {
  const { file, introFile, introSource, transitionStyle = "ken-burns", introDuration = 4 } = req.body;
  // introSource: "screenshot" (image) | "goodtogo" (video)
  if (!file || !introFile || !introSource) {
    res.status(400).json({ error: "file, introFile, and introSource are required." });
    return;
  }
  if (!FFMPEG_PATH) {
    res.status(500).json({ error: "ffmpeg not found — cannot prepend intro." });
    return;
  }

  const mainPath = path.join(GOOD_TO_GO_DIR, file);
  if (!fs.existsSync(mainPath)) {
    res.status(404).json({ error: "Approved video not found in GoodToGo/." });
    return;
  }

  let introClipPath: string;
  let createdTempClip = false;
  const ts = Date.now();

  try {
    const { w: vW, h: vH } = probeVideoDimensions(mainPath);

    if (introSource === "screenshot") {
      const imagePath = path.join(SCREENSHOTS_INPUT_DIR, introFile);
      if (!fs.existsSync(imagePath)) {
        res.status(404).json({ error: `Intro image not found: ${introFile}` });
        return;
      }
      introClipPath = path.join(VEO_DIR, `_intro_${ts}.mp4`);
      console.log(`🎬 Creating intro clip from image: ${introFile} [${transitionStyle}]`);
      await createScreenshotClip(imagePath, introClipPath, vW, vH, introDuration, transitionStyle as ZoomStyle);
      createdTempClip = true;
    } else {
      // Use a GoodToGo video directly as intro
      introClipPath = path.join(GOOD_TO_GO_DIR, introFile);
      if (!fs.existsSync(introClipPath)) {
        res.status(404).json({ error: `Intro video not found: ${introFile}` });
        return;
      }
    }

    const outputName = file.replace(/\.mp4$/i, "_with_intro.mp4");
    const outputPath = path.join(GOOD_TO_GO_DIR, outputName);
    console.log(`🎬 Prepending intro to ${file}...`);
    await concatClips([introClipPath, mainPath], outputPath);

    if (createdTempClip) { try { fs.unlinkSync(introClipPath); } catch {} }

    console.log(`✅ With intro: ${outputName}`);
    res.json({ success: true, file: outputName });
  } catch (err: any) {
    if (createdTempClip && introClipPath!) { try { fs.unlinkSync(introClipPath!); } catch {} }
    console.error("❌ prepend-intro error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: splice — bypass Veo entirely, build a video from screenshots + GoodToGo clips
// ----------------------------------------------------------------
// Body: { items: Array<{type: "image"|"video", file, style?, duration?}>, aspectRatio?: "9:16"|"16:9" }
// Images are sourced from Screenshots/, videos from GoodToGo/. Output is saved to
// GoodToGo/ so it can be reused as an intro for further splices.
app.post("/api/splice", async (req, res) => {
  const { items, aspectRatio = "9:16", transitionSeconds = 0.5 } = req.body as {
    items?: Array<{
      type: "image" | "video";
      file: string;
      style?: ZoomStyle;
      duration?: number;
      source?: "screenshot" | "composed"; // image items only; default "screenshot"
      filter?: ClipFilter;                // per-clip colour effect
      transition?: TransitionKind;        // out-transition into the next clip
    }>;
    aspectRatio?: string;
    transitionSeconds?: number;
  };
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array is required." });
    return;
  }
  if (!FFMPEG_PATH) {
    res.status(500).json({ error: "ffmpeg not found — cannot splice." });
    return;
  }

  // Determine target dimensions: probe the first video item, else fall back to aspect ratio.
  let vW = 720, vH = 1280;
  const firstVideo = items.find(it => it.type === "video");
  if (firstVideo) {
    const probePath = path.join(GOOD_TO_GO_DIR, firstVideo.file);
    if (fs.existsSync(probePath)) {
      const dims = probeVideoDimensions(probePath);
      vW = dims.w; vH = dims.h;
    }
  } else {
    // No video reference — use aspectRatio
    if (aspectRatio === "16:9") { vW = 1280; vH = 720; }
    else                        { vW = 720;  vH = 1280; } // default 9:16
  }
  console.log(`✂️  Splice target dimensions: ${vW}×${vH}`);

  const ts = Date.now();
  const tempClips: string[] = [];
  const orderedClipPaths: string[] = [];
  const clipDurations: number[] = [];

  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let producedPath: string;
      let producedDuration: number;

      if (it.type === "image") {
        const sourceDir = it.source === "composed" ? COMPOSED_DIR : SCREENSHOTS_INPUT_DIR;
        const src = path.join(sourceDir, it.file);
        if (!fs.existsSync(src)) throw new Error(`Image not found: ${it.file} (source=${it.source || "screenshot"})`);
        const clipPath = path.join(VEO_DIR, `_splice_${ts}_${i}.mp4`);
        const dur   = typeof it.duration === "number" && it.duration > 0 ? it.duration : 4;
        const style = (it.style as ZoomStyle) || "punch";
        console.log(`🖼️  [${i + 1}/${items.length}] Image clip [${it.source || "screenshot"}]: ${it.file} [${style}, ${dur}s]`);
        await createScreenshotClip(src, clipPath, vW, vH, dur, style);
        tempClips.push(clipPath);
        producedPath = clipPath;
        producedDuration = dur;
      } else if (it.type === "video") {
        const src = path.join(GOOD_TO_GO_DIR, it.file);
        if (!fs.existsSync(src)) throw new Error(`Video not found: ${it.file}`);
        const dims = probeVideoDimensions(src);
        const probedDur = probeVideoDuration(src);
        if (dims.w !== vW || dims.h !== vH) {
          const normPath = path.join(VEO_DIR, `_splice_${ts}_${i}_norm.mp4`);
          console.log(`🎞️  [${i + 1}/${items.length}] Video clip (resizing ${dims.w}×${dims.h} → ${vW}×${vH}): ${it.file}`);
          const cmd = `"${FFMPEG_PATH}" -i "${src}" -vf "scale=${vW}:${vH}:force_original_aspect_ratio=decrease,pad=${vW}:${vH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 -an "${normPath}" -y`;
          execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
          tempClips.push(normPath);
          producedPath = normPath;
        } else {
          console.log(`🎞️  [${i + 1}/${items.length}] Video clip: ${it.file}`);
          producedPath = src;
        }
        producedDuration = probedDur;
      } else {
        throw new Error(`Unknown item type: ${(it as any).type}`);
      }

      // Apply per-clip filter (re-encode pass) if requested.
      const filter = (it.filter || "none") as ClipFilter;
      if (filter !== "none" && FILTER_VF[filter]) {
        const filteredPath = path.join(VEO_DIR, `_splice_${ts}_${i}_fx.mp4`);
        console.log(`🎨 Applying filter [${filter}] to clip ${i + 1}`);
        await applyClipFilter(producedPath, filteredPath, filter);
        tempClips.push(filteredPath);
        producedPath = filteredPath;
      }

      orderedClipPaths.push(producedPath);
      clipDurations.push(producedDuration);
    }

    const outputName = `splice_${ts}.mp4`;
    const outputPath = path.join(GOOD_TO_GO_DIR, outputName);

    // Build the per-junction transition list (length = items.length - 1).
    const transitions: TransitionKind[] = [];
    for (let i = 0; i < items.length - 1; i++) {
      transitions.push((items[i].transition || "cut") as TransitionKind);
    }
    const hasNamedTransition = transitions.some(t => t !== "cut");

    if (hasNamedTransition) {
      console.log(`✂️  Crossfade-concatenating ${orderedClipPaths.length} clips with transitions [${transitions.join(", ")}] → ${outputName}`);
      await concatClipsWithTransitions(orderedClipPaths, transitions, clipDurations, outputPath, transitionSeconds);
    } else {
      console.log(`✂️  Concatenating ${orderedClipPaths.length} clips → ${outputName}`);
      await concatClips(orderedClipPaths, outputPath);
    }

    // Clean up temp clips
    for (const p of tempClips) { try { fs.unlinkSync(p); } catch {} }

    console.log(`✅ Spliced: ${outputName}`);
    res.json({ success: true, file: outputName, count: orderedClipPaths.length });
  } catch (err: any) {
    for (const p of tempClips) { try { fs.unlinkSync(p); } catch {} }
    console.error("❌ splice error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: generate video
// ----------------------------------------------------------------
// Composite a layer stack into base64 PNG bytes. Handles "flat:#RRGGBB" base layers
// for solid-color backgrounds. All other layers resolve against MONSTERS_DIR.
async function compositeLayersToBase64(layers: string[], aspectRatio: string): Promise<string> {
  if (!layers || layers.length === 0) throw new Error("No layers provided.");
  const [baseLayer, ...restLayers] = layers;
  const resolvedRest = restLayers.map((l) => path.join(MONSTERS_DIR, l));
  for (const l of resolvedRest) {
    if (!fs.existsSync(l)) throw new Error(`Layer not found: ${l}`);
  }
  let image: ReturnType<typeof sharp>;
  if (baseLayer.startsWith("flat:")) {
    const [w, h] = aspectRatioDims(aspectRatio);
    const [r, g, b] = hexToRgb(baseLayer.slice(5));
    image = sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } });
  } else {
    const resolvedBase = path.join(MONSTERS_DIR, baseLayer);
    if (!fs.existsSync(resolvedBase)) throw new Error(`Layer not found: ${resolvedBase}`);
    image = sharp(resolvedBase);
  }
  if (resolvedRest.length > 0) image = image.composite(resolvedRest.map((l) => ({ input: l })));
  const buffer = await image.png().toBuffer();
  return buffer.toString("base64");
}

// ----------------------------------------------------------------
// API: compose-frame — render a layer stack to a PNG file in Composed/
// for use as an image clip in the splice timeline.
// ----------------------------------------------------------------
app.post("/api/compose-frame", async (req, res) => {
  const { layers, aspectRatio = "9:16", label } = req.body as {
    layers?: string[]; aspectRatio?: string; label?: string;
  };
  if (!Array.isArray(layers) || layers.length === 0) {
    res.status(400).json({ error: "layers array is required." });
    return;
  }
  try {
    const b64 = await compositeLayersToBase64(layers, aspectRatio);
    const ts = Date.now();
    const safeLabel = (label || "frame").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "frame";
    const filename = `composed_${safeLabel}_${ts}.png`;
    const outPath = path.join(COMPOSED_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    console.log(`🖼️  Composed frame saved: ${filename}`);
    res.json({ success: true, file: filename });
  } catch (err: any) {
    console.error("❌ compose-frame error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/generate", async (req, res) => {
  const { layers, lastFrameLayers, behavior, style, overlayText, subText, aspectRatio = "9:16", durationSeconds = 8, textMode = "burn" } = req.body;

  if (!layers || layers.length === 0) {
    res.status(400).json({ error: "No layers provided." });
    return;
  }

  const styleText = STYLES[style] || STYLES["Dark Gothic"];
  const hasTransition = Array.isArray(lastFrameLayers) && lastFrameLayers.length > 0;

  // textMode "veo" — include text in prompt and let Veo render it dynamically
  // textMode "burn" — keep prompt clean, burn text post-generation via ffmpeg
  let textInPrompt = "";
  if ((textMode === "veo" || textMode === "both") && overlayText?.trim()) {
    textInPrompt = ` Include large bold text overlay reading "${overlayText.trim()}" rendered dynamically in the scene.`;
    if (textMode === "veo" && subText?.trim()) {
      textInPrompt += ` Also include smaller subtitle text reading "${subText.trim()}".`;
    }
  } else if (textMode === "veo" && subText?.trim()) {
    textInPrompt = ` Include smaller subtitle text reading "${subText.trim()}" rendered dynamically in the scene.`;
  }

  // Default behavior: transition phrasing when a second frame is set and the user
  // hasn't written their own behavior text. Otherwise, the existing idle default.
  const defaultBehavior = hasTransition
    ? "The character smoothly transforms from the first frame into the last frame, a clean expressive transition."
    : "The character stands center frame facing the camera, makes a small expressive gesture.";
  const prompt = `Animate this character. ${behavior || defaultBehavior}${textInPrompt} ${styleText}`;

  console.log(`\n🎬 Generating video...`);
  console.log(`📝 Prompt: ${prompt}`);
  console.log(`🖼️  Layers: ${layers.join(", ")}`);
  if (hasTransition) console.log(`🎞️  Last-frame layers: ${lastFrameLayers.join(", ")}`);

  try {
    const imageBytes = await compositeLayersToBase64(layers as string[], aspectRatio);
    const lastFrameBytes = hasTransition
      ? await compositeLayersToBase64(lastFrameLayers as string[], aspectRatio)
      : null;

    // Submit to Veo. If lastFrame is rejected by the model, fall back to first-frame-only.
    const baseRequest = {
      model: MODEL,
      prompt,
      image: { imageBytes, mimeType: "image/png" },
    } as const;
    const baseConfig = { aspectRatio, numberOfVideos: 1, durationSeconds } as any;

    let operation;
    try {
      const config = lastFrameBytes
        ? { ...baseConfig, lastFrame: { imageBytes: lastFrameBytes, mimeType: "image/png" } }
        : baseConfig;
      operation = await ai.models.generateVideos({ ...baseRequest, config });
    } catch (err: any) {
      if (lastFrameBytes) {
        console.warn(`⚠️  lastFrame rejected by model (${err?.message ?? err}). Retrying without transition frame...`);
        operation = await ai.models.generateVideos({ ...baseRequest, config: baseConfig });
      } else {
        throw err;
      }
    }

    // Poll
    while (!operation.done) {
      await sleep(POLL_INTERVAL_MS);
      operation = await ai.operations.getVideosOperation({ operation });
    }

    if (operation.error) throw new Error(`Veo error: ${JSON.stringify(operation.error)}`);

    const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!videoUri) throw new Error("No video URI in response.");

    // Download
    const ts = Date.now();
    const rawName = `habitbeast_raw_${ts}.mp4`;
    const outputName = `habitbeast_${ts}.mp4`;
    const rawPath = path.join(VEO_DIR, rawName);
    const outputPath = path.join(VEO_DIR, outputName);
    await downloadFile(`${videoUri}&key=${GEMINI_API_KEY}`, rawPath);

    // Burn text overlays with ffmpeg if mode is "burn" and ffmpeg available
    const hasText = overlayText?.trim() || subText?.trim();
    // burn mode: burn both; both mode: burn subtitle only; veo mode: no burning
    const burnMain = textMode === "burn" ? (overlayText?.trim() || "") : "";
    const burnSub  = (textMode === "burn" || textMode === "both") ? (subText?.trim() || "") : "";
    const shouldBurn = (burnMain || burnSub) && FFMPEG_PATH;

    if (shouldBurn) {
      console.log("🔤 Burning text overlays...");
      await burnText(rawPath, outputPath, burnMain, burnSub);
      fs.unlinkSync(rawPath);
    } else {
      fs.renameSync(rawPath, outputPath);
      if ((textMode === "burn" || textMode === "both") && hasText && !FFMPEG_PATH)
        console.warn("⚠️  Skipped text burning — ffmpeg not found.");
    }

    console.log(`✅ Saved: ${outputPath}`);
    const cost = logGeneration(durationSeconds, outputName);
    const stats = getCostStats();
    const textSkipped = (textMode === "burn" || textMode === "both") && hasText && !FFMPEG_PATH;
    res.json({ success: true, file: outputName, textSkipped, textMode, cost, todayCost: stats.today, totalCost: stats.total });

  } catch (err: any) {
    console.error("❌", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: blink — local sprite-swap renderer (no Veo cost).
// Accepts the same kind of layer payload as /api/generate but runs the
// state machine in blink.ts to produce an N-second blinking-monster loop.
// Bypasses the Veo API entirely; output appears in the same /videos/ space
// so the existing approve/reject/screenshot flow works unchanged.
// ----------------------------------------------------------------
const BLINK_MONSTERS = new Set([
  ...BIG_MONSTERS, ...SMALL_MONSTERS,
]);
const BLINK_MOODS = new Set(["happy", "okay", "excited", "sad", "upset"]);

app.post("/api/blink", async (req, res) => {
  const {
    monster,
    mood = "happy",
    bgColor = "#1a1a24",
    backgroundImage,
    clothing = [],
    bottom,
    cape,
    mustache,
    mouthStyle,
    durationSec = 8,
    aspectRatio = "1:1",
  } = req.body as {
    monster?: string;
    mood?: string;
    bgColor?: string;
    backgroundImage?: string | null;
    clothing?: string[];
    bottom?: string | null;
    cape?: string | null;
    mustache?: string | null;
    mouthStyle?: string | null;
    durationSec?: number;
    aspectRatio?: string;
  };

  if (!monster || !BLINK_MONSTERS.has(monster)) {
    res.status(400).json({
      error: `Blink mode requires one of the 8 standard monsters (got "${monster}"). Lab Assistant is not supported.`,
    });
    return;
  }
  const safeMood = BLINK_MOODS.has(mood) ? mood : "happy";
  const dur = Math.max(2, Math.min(20, Number(durationSec) || 8));

  // Aspect-ratio → pixel dims. Square loops render at 1080×1080 for crispness;
  // portrait/landscape use the standard 720×1280 / 1280×720 from aspectRatioDims().
  const [w, h] = aspectRatio === "1:1" ? [1080, 1080] : aspectRatioDims(aspectRatio);

  const ts = Date.now();
  const outputName = `habitbeast_blink_${monster}_${safeMood}_${ts}.mp4`;
  const outputPath = path.join(VEO_DIR, outputName);

  console.log(`\n🔁 Rendering blink loop (no Veo cost)`);
  console.log(`   monster=${monster} mood=${safeMood} bg=${bgColor} dur=${dur}s ${w}×${h}`);

  try {
    await renderBlinkClip({
      monster: monster as any, // validated against BLINK_MONSTERS above
      mood: safeMood as any,
      bgColor,
      backgroundImage: backgroundImage || undefined,
      clothing: Array.isArray(clothing) ? clothing : [],
      bottom: bottom || undefined,
      cape:   cape   || undefined,
      mustache:   mustache   || undefined,
      mouthStyle: mouthStyle || undefined,
      durationSec: dur,
      width: w,
      height: h,
      outputPath,
    });
    console.log(`✅ Saved: ${outputPath}`);
    // Log it as a $0 generation so the cost log stays a complete history of rendered clips
    logGeneration(0, outputName);
    const stats = getCostStats();
    res.json({
      success: true,
      file: outputName,
      cost: 0,
      todayCost: stats.today,
      totalCost: stats.total,
    });
  } catch (err: any) {
    console.error("❌ blink error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: render a 3×3 Brady Bunch montage. The center cell is always a
// title card; the 8 surrounding cells are blink loops the user composed
// in the UI. Each cell carries its own monster + mood + bgColor + clothing,
// so the user can vary mood/outfit per cell.
// ----------------------------------------------------------------
app.post("/api/blink-grid", async (req, res) => {
  const {
    cells,
    titleText,
    titleSubtext,
    titleBgColor,
    titleColor,
    durationSec = 8,
  } = req.body as {
    cells?: any[];
    titleText?: string;
    titleSubtext?: string;
    titleBgColor?: string;
    titleColor?: string;
    durationSec?: number;
  };

  if (!Array.isArray(cells) || cells.length !== 8) {
    res.status(400).json({
      error: `Brady Bunch requires exactly 8 cells (got ${Array.isArray(cells) ? cells.length : "none"}). The center cell is the title card.`,
    });
    return;
  }
  for (let i = 0; i < 8; i++) {
    const c = cells[i];
    if (!c || !c.monster || !BLINK_MONSTERS.has(c.monster)) {
      res.status(400).json({
        error: `Cell ${i + 1} is missing a valid monster (got "${c?.monster}"). Lab Assistant is not supported.`,
      });
      return;
    }
  }

  const dur = Math.max(2, Math.min(20, Number(durationSec) || 8));

  const safeCells: GridCell[] = cells.map((c) => ({
    monster: c.monster,
    mood: BLINK_MOODS.has(c.mood) ? c.mood : "happy",
    bgColor: typeof c.bgColor === "string" ? c.bgColor : "#1a1a24",
    clothing: Array.isArray(c.clothing) ? c.clothing : [],
    bottom: c.bottom || undefined,
    cape:   c.cape   || undefined,
    mustache:   c.mustache   || undefined,
    mouthStyle: c.mouthStyle || undefined,
  }));

  const ts = Date.now();
  const outputName = `habitbeast_brady_${ts}.mp4`;
  const outputPath = path.join(VEO_DIR, outputName);

  console.log(`\n🎬 Rendering Brady Bunch grid (no Veo cost)`);
  console.log(`   8 cells × ${dur}s — title="${titleText || "HabitBeast"}"`);

  try {
    await renderBradyBunch({
      cells: safeCells,
      titleText: titleText || undefined,
      titleSubtext: titleSubtext || undefined,
      titleBgColor: titleBgColor || undefined,
      titleColor: titleColor || undefined,
      durationSec: dur,
      outputPath,
    });
    console.log(`✅ Saved: ${outputPath}`);
    logGeneration(0, outputName);
    const stats = getCostStats();
    res.json({
      success: true,
      file: outputName,
      cost: 0,
      todayCost: stats.today,
      totalCost: stats.total,
    });
  } catch (err: any) {
    console.error("❌ brady error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: render a fart sequence (~7s) for one monster. Mirrors /api/blink
// payload (monster + bgColor + clothing) but mood is fixed by the
// fart choreography itself.
// ----------------------------------------------------------------
app.post("/api/blink-fart", async (req, res) => {
  const {
    monster,
    bgColor = "#1a1a24",
    backgroundImage,
    clothing = [],
    bottom,
    cape,
    mustache,
    mouthStyle,
    aspectRatio = "1:1",
  } = req.body as {
    monster?: string;
    bgColor?: string;
    backgroundImage?: string | null;
    clothing?: string[];
    bottom?: string | null;
    cape?: string | null;
    mustache?: string | null;
    mouthStyle?: string | null;
    aspectRatio?: string;
  };

  if (!monster || !BLINK_MONSTERS.has(monster)) {
    res.status(400).json({
      error: `Fart mode requires one of the 8 standard monsters (got "${monster}"). Lab Assistant is not supported.`,
    });
    return;
  }

  const [w, h] = aspectRatio === "1:1" ? [1080, 1080] : aspectRatioDims(aspectRatio);
  const ts = Date.now();
  const outputName = `habitbeast_fart_${monster}_${ts}.mp4`;
  const outputPath = path.join(VEO_DIR, outputName);

  console.log(`\n💨 Rendering fart sequence (no Veo cost)`);
  console.log(`   monster=${monster} bg=${bgColor} ${w}×${h}`);

  try {
    await renderFartClip({
      monster: monster as any,
      bgColor,
      backgroundImage: backgroundImage || undefined,
      clothing: Array.isArray(clothing) ? clothing : [],
      bottom: bottom || undefined,
      cape:   cape   || undefined,
      mustache:   mustache   || undefined,
      mouthStyle: mouthStyle || undefined,
      preRollSec: 0.5,
      postRollSec: 0.5,
      width: w,
      height: h,
      outputPath,
    });
    console.log(`✅ Saved: ${outputPath}`);
    logGeneration(0, outputName);
    const stats = getCostStats();
    res.json({
      success: true,
      file: outputName,
      cost: 0,
      todayCost: stats.today,
      totalCost: stats.total,
    });
  } catch (err: any) {
    console.error("❌ fart error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// API: render a Lineup Pan — 8 monsters horizontally with a zoom-in,
// pan-across, zoom-out camera move. Same per-cell payload as Brady Bunch
// (monster + mood + bgColor + clothing per cell), but order matters here:
// cells[0] is leftmost, cells[7] is rightmost on the strip.
// ----------------------------------------------------------------
app.post("/api/blink-lineup", async (req, res) => {
  const {
    cells,
    width = 1920,
    height = 1080,
    overviewSec,
    panSec,
    zoomSec,
  } = req.body as {
    cells?: any[];
    width?: number;
    height?: number;
    overviewSec?: number;
    panSec?: number;
    zoomSec?: number;
  };

  if (!Array.isArray(cells) || cells.length !== 8) {
    res.status(400).json({
      error: `Lineup Pan requires exactly 8 cells (got ${Array.isArray(cells) ? cells.length : "none"}).`,
    });
    return;
  }
  for (let i = 0; i < 8; i++) {
    const c = cells[i];
    if (!c || !c.monster || !BLINK_MONSTERS.has(c.monster)) {
      res.status(400).json({
        error: `Cell ${i + 1} is missing a valid monster (got "${c?.monster}"). Lab Assistant is not supported.`,
      });
      return;
    }
  }

  const safeCells: GridCell[] = cells.map((c) => ({
    monster: c.monster,
    mood: BLINK_MOODS.has(c.mood) ? c.mood : "happy",
    bgColor: typeof c.bgColor === "string" ? c.bgColor : "#1a1a24",
    clothing: Array.isArray(c.clothing) ? c.clothing : [],
    bottom: c.bottom || undefined,
    cape:   c.cape   || undefined,
    mustache:   c.mustache   || undefined,
    mouthStyle: c.mouthStyle || undefined,
  }));

  const ts = Date.now();
  const outputName = `habitbeast_lineup_${ts}.mp4`;
  const outputPath = path.join(VEO_DIR, outputName);

  console.log(`\n🎥 Rendering Lineup Pan (no Veo cost)`);
  console.log(`   8 cells, ${width}×${height}`);

  try {
    await renderLineupPan({
      cells: safeCells,
      width: Number(width)  || 1920,
      height: Number(height) || 1080,
      overviewSec,
      panSec,
      zoomSec,
      outputPath,
    });
    console.log(`✅ Saved: ${outputPath}`);
    logGeneration(0, outputName);
    const stats = getCostStats();
    res.json({
      success: true,
      file: outputName,
      cost: 0,
      todayCost: stats.today,
      totalCost: stats.total,
    });
  } catch (err: any) {
    console.error("❌ lineup error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// Serve the UI
// ----------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send(UI_HTML);
});

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function burnText(inputPath: string, outputPath: string, mainText: string, subText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Escape single quotes for ffmpeg drawtext filter
    const esc = (s: string) => s.replace(/'/g, "\u2019").replace(/:/g, "\\:");

    const filters: string[] = [];

    if (mainText) {
      filters.push(
        `drawtext=text='${esc(mainText)}':` +
        `fontsize=56:fontcolor=white:x=(w-text_w)/2:y=h*0.72:` +
        `shadowx=3:shadowy=3:shadowcolor=black@0.8:` +
        `box=1:boxcolor=black@0.35:boxborderw=12`
      );
    }

    if (subText) {
      // Subtext fades in after 1.5s
      filters.push(
        `drawtext=text='${esc(subText)}':` +
        `fontsize=32:fontcolor=white@0.9:x=(w-text_w)/2:y=h*0.82:` +
        `shadowx=2:shadowy=2:shadowcolor=black@0.8:` +
        `enable='gte(t,1.5)'`
      );
    }

    ffmpeg(inputPath)
      .videoFilters(filters)
      .outputOptions(["-c:a copy"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const fetchUrl = (currentUrl: string) => {
      const client = currentUrl.startsWith("https") ? https : http;
      client.get(currentUrl, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          fetchUrl(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    fetchUrl(url);
  });
}

// ----------------------------------------------------------------
// ffmpeg helpers: screenshot clips + concat
// ----------------------------------------------------------------

function probeVideoDimensions(filePath: string): { w: number; h: number } {
  try {
    const probePath = FFMPEG_PATH
      ? FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1")
      : "ffprobe";
    const result = execSync(
      `"${probePath}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const [w, h] = result.split(",").map(Number);
    if (w && h) return { w, h };
  } catch { /* fall through */ }
  return { w: 720, h: 1280 }; // 9:16 portrait fallback
}

function probeVideoDuration(filePath: string): number {
  try {
    const probePath = FFMPEG_PATH
      ? FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1")
      : "ffprobe";
    const result = execSync(
      `"${probePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const d = parseFloat(result);
    if (d > 0) return d;
  } catch { /* fall through */ }
  return 8; // fallback
}

// Available zoom/motion styles for screenshot clips.
type ZoomStyle = "punch" | "pull-back" | "burst" | "drift" | "ken-burns";

// Create an animated clip from a still image using the chosen zoom style.
// Default duration is 4s (faster feel); ken-burns uses 5s for its slow creep.
function createScreenshotClip(
  inputPath: string,
  outputPath: string,
  vW: number,
  vH: number,
  duration = 4,
  style: ZoomStyle = "punch",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fps    = 30;
    const frames = duration * fps;
    const dim    = `${vW}x${vH}`;
    const cx     = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`; // zoom from centre

    // Build the zoompan expression for the chosen style
    let zpFilter: string;
    switch (style) {
      case "punch":
        // Hard cut-in: zoom 1.0→1.5× over the first second, then hold tight
        zpFilter = `zoompan=z='if(lte(on,${fps}),1+on*(0.5/${fps}),1.5)':d=${frames}:s=${dim}:${cx}`;
        break;
      case "pull-back":
        // Start close at 1.5×, slowly pull back to reveal the full frame
        zpFilter = `zoompan=z='max(1.5-on*(0.5/${frames}),1.0)':d=${frames}:s=${dim}:${cx}`;
        break;
      case "burst":
        // Snap to 1.6× in ~12 frames (0.4s), then ease back and hold at 1.3×
        zpFilter = `zoompan=z='if(lte(on,12),1+on*(0.6/12),max(1.6-(on-12)*(0.3/${frames - 12}),1.3))':d=${frames}:s=${dim}:${cx}`;
        break;
      case "drift":
        // Steady 1.3× zoom + slow diagonal pan from top-left to bottom-right
        zpFilter = `zoompan=z=1.3:d=${frames}:s=${dim}:x='(iw-iw/zoom)*(on/${frames})':y='(ih-ih/zoom)*(on/${frames})'`;
        break;
      case "ken-burns":
      default: {
        // Slow gentle creep: 1.0→1.4× across the full clip
        const zoomSpeed = (0.4 / frames).toFixed(7);
        zpFilter = `zoompan=z='min(zoom+${zoomSpeed},1.4)':d=${frames}:s=${dim}:${cx}`;
        break;
      }
    }

    ffmpeg(inputPath)
      .inputOptions(["-loop 1"])
      .videoFilters([
        `scale=${vW}:${vH}:force_original_aspect_ratio=decrease`,
        `pad=${vW}:${vH}:(ow-iw)/2:(oh-ih)/2:black`,
        zpFilter,
        `fade=t=in:st=0:d=0.3`,
        `fade=t=out:st=${duration - 0.3}:d=0.3`,
      ])
      .outputOptions([`-t ${duration}`, "-c:v libx264", "-pix_fmt yuv420p", `-r ${fps}`])
      .output(outputPath)
      .on("end",   ()           => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

// ----------------------------------------------------------------
// Per-clip filter: re-encode an mp4 with a -vf chain to apply colour effects.
// ----------------------------------------------------------------
type ClipFilter =
  | "none" | "bw" | "sepia" | "vibrant" | "vintage" | "invert" | "vignette" | "warm" | "cool";

const FILTER_VF: Record<ClipFilter, string | null> = {
  none:    null,
  bw:      "hue=s=0",
  sepia:   "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
  vibrant: "eq=saturation=1.55:contrast=1.08",
  vintage: "curves=preset=vintage",
  invert:  "negate",
  vignette:"vignette=PI/4",
  warm:    "colorbalance=rs=.10:gs=.04:bs=-.10",
  cool:    "colorbalance=rs=-.08:gs=.02:bs=.10",
};

function applyClipFilter(input: string, output: string, filter: ClipFilter): Promise<void> {
  return new Promise((resolve, reject) => {
    const vf = FILTER_VF[filter];
    if (!vf) { try { fs.copyFileSync(input, output); resolve(); } catch (e: any) { reject(e); } return; }
    try {
      const cmd = `"${FFMPEG_PATH}" -i "${input}" -vf "${vf},setsar=1" -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 -an "${output}" -y`;
      execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
      resolve();
    } catch (err: any) {
      reject(new Error(err.stderr?.toString("utf8") || err.message));
    }
  });
}

// ----------------------------------------------------------------
// Cross-fade concat: builds an xfade chain between clips, with a per-junction
// transition. "cut" maps to a 0.05s fade so the same code path works for hard
// cuts and named transitions alike.
// ----------------------------------------------------------------
type TransitionKind =
  | "cut" | "fade" | "fadeblack" | "fadewhite"
  | "wipeleft" | "wiperight" | "wipeup" | "wipedown"
  | "slideleft" | "slideright" | "slideup" | "slidedown"
  | "circleopen" | "circleclose" | "pixelize" | "radial" | "smoothleft";

function concatClipsWithTransitions(
  clipPaths: string[],
  transitions: TransitionKind[],   // length = clipPaths.length - 1
  durations: number[],             // length = clipPaths.length
  outputPath: string,
  transitionSeconds = 0.5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (clipPaths.length === 0) { reject(new Error("No clips")); return; }
    if (clipPaths.length === 1) {
      try { fs.copyFileSync(clipPaths[0], outputPath); resolve(); } catch (e: any) { reject(e); }
      return;
    }
    if (transitions.length !== clipPaths.length - 1) {
      reject(new Error(`Expected ${clipPaths.length - 1} transitions, got ${transitions.length}`));
      return;
    }
    try {
      const bin = FFMPEG_PATH!;
      const inputs = clipPaths.map(p => `-i "${p}"`).join(" ");
      // Normalise every input to a consistent format/SAR/fps before xfade.
      const prep = clipPaths.map((_, i) => `[${i}:v]format=yuv420p,setsar=1,fps=30[p${i}]`).join(";");

      // Per-transition durations (cut maps to 0.05s for an effectively hard cut).
      const Ds = transitions.map(t => t === "cut" ? 0.05 : transitionSeconds);

      // offset_i = sum(durations[0..=i]) - sum(Ds[0..=i])
      let sumDur = 0, sumDs = 0;
      const chainParts: string[] = [];
      let prevLabel = "p0";
      for (let i = 0; i < transitions.length; i++) {
        const t = transitions[i];
        const xt = t === "cut" ? "fade" : t;
        const xd = Ds[i];
        sumDur += durations[i];
        sumDs  += xd;
        const offset = Math.max(0, sumDur - sumDs).toFixed(3);
        const outLabel = i === transitions.length - 1 ? "outv" : `x${i}`;
        chainParts.push(`[${prevLabel}][p${i + 1}]xfade=transition=${xt}:duration=${xd.toFixed(3)}:offset=${offset}[${outLabel}]`);
        prevLabel = outLabel;
      }

      const filterComplex = `${prep};${chainParts.join(";")}`;
      const cmd = `"${bin}" ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 "${outputPath}" -y`;
      execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
      resolve();
    } catch (err: any) {
      reject(new Error(err.stderr?.toString("utf8") || err.message));
    }
  });
}

// Concatenate an ordered list of .mp4 clips into one file.
// Uses the concat filter via a raw execSync command — avoids fluent-ffmpeg's
// auto-map behaviour which conflicts with a custom [outv] stream label and
// also properly resets PTS at each join so there's no freeze between clips.
function concatClips(clipPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const bin = FFMPEG_PATH!;
      const inputs = clipPaths.map(p => `-i "${p}"`).join(" ");
      // Normalise SAR to 1:1 on every stream before concat — Veo videos often
      // carry a non-square SAR that doesn't match the screenshot clips, which
      // makes the concat filter refuse to initialise with an EINVAL (-22).
      const sarNorm  = clipPaths.map((_, i) => `[${i}:v]setsar=1[v${i}]`).join(";");
      const concatIn = clipPaths.map((_, i) => `[v${i}]`).join("");
      const filterComplex = `${sarNorm};${concatIn}concat=n=${clipPaths.length}:v=1:a=0[outv]`;
      const cmd = `"${bin}" ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 "${outputPath}" -y`;
      execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
      resolve();
    } catch (err: any) {
      reject(new Error(err.stderr?.toString("utf8") || err.message));
    }
  });
}

// ----------------------------------------------------------------
// UI HTML
// ----------------------------------------------------------------
const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HabitBeast Veo Composer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f13; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column; height: 100vh; }

    header { background: #1a1a24; padding: 14px 24px; border-bottom: 1px solid #2a2a3a; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; color: #a78bfa; letter-spacing: 1px; }
    header span { font-size: 12px; color: #666; }

    /* Mode toggle */
    .mode-btn {
      background: #1e1e2a; border: 1px solid #2a2a3a; color: #888;
      border-radius: 6px; padding: 6px 12px; font-size: 11px; font-weight: 700;
      letter-spacing: .5px; cursor: pointer; transition: all .15s;
    }
    .mode-btn:hover { color: #a78bfa; border-color: #3a3a4a; }
    .mode-btn.active { background: #a78bfa; color: #0f0f13; border-color: #a78bfa; }

    /* Splice builder — replaces the right Veo panel in Splice mode */
    #spliceArea {
      display: none; width: 380px; background: #13131a; border-left: 1px solid #2a2a3a;
      padding: 14px; gap: 12px; flex-direction: column; overflow-y: auto; flex-shrink: 0;
    }
    #spliceArea.visible { display: flex; }
    .splice-pickers { display: flex; flex-direction: column; gap: 10px; }
    .splice-picker { background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 8px; padding: 10px; }
    .splice-picker h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #666; margin-bottom: 8px; }
    .splice-picker .picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(56px, 1fr)); gap: 4px; max-height: 140px; overflow-y: auto; }
    .splice-picker .pick-thumb {
      cursor: pointer; border-radius: 6px; border: 1px solid #2a2a3a; aspect-ratio: 9/16;
      background: #1e1e2a; display: flex; align-items: flex-end; justify-content: center;
      overflow: hidden; position: relative; transition: border-color .15s;
    }
    .splice-picker .pick-thumb:hover { border-color: #a78bfa; }
    .splice-picker .pick-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .splice-picker .pick-thumb video { width: 100%; height: 100%; object-fit: cover; }
    .splice-picker .pick-thumb label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,.65); font-size: 9px; text-align: center; padding: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ddd; }

    #spliceTimeline { background: #13131a; border: 1px solid #2a2a3a; border-radius: 10px; padding: 12px; }
    #spliceTimeline h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #666; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
    #spliceTimeline h3 .total-time { color: #a78bfa; font-weight: 400; letter-spacing: 1px; }
    #spliceItems { display: flex; flex-direction: column; gap: 8px; min-height: 60px; }
    .timeline-item {
      display: flex; flex-direction: column; gap: 8px; padding: 10px;
      background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 10px;
    }
    .ti-header { display: flex; align-items: center; gap: 10px; }
    .timeline-item .ti-thumb { width: 56px; height: 90px; border-radius: 6px; background: #0c0c10; overflow: hidden; flex-shrink: 0; border: 1px solid #2a2a3a; }
    .timeline-item .ti-thumb img,
    .timeline-item .ti-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .timeline-item .ti-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .timeline-item .ti-name { font-size: 13px; color: #e8e8e8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .timeline-item .ti-type { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 1.5px; }
    .timeline-item .ti-reorder { display: flex; flex-direction: column; gap: 3px; }
    .timeline-item .ti-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
    .timeline-item .ti-controls.full-row > * { grid-column: 1 / -1; }
    .ti-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .ti-field label { font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; color: #666; font-weight: 700; }
    .timeline-item select, .timeline-item input[type=number] {
      background: #0c0c10; border: 1px solid #2a2a3a; color: #ddd;
      border-radius: 6px; padding: 7px 8px; font-size: 13px; font-family: inherit;
      width: 100%; box-sizing: border-box;
    }
    .timeline-item select:focus, .timeline-item input[type=number]:focus {
      outline: none; border-color: #a78bfa;
    }
    .timeline-item .ti-btn {
      background: #1e1e2a; border: 1px solid #2a2a3a; color: #888;
      border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; line-height: 1;
      font-weight: 700;
    }
    .timeline-item .ti-btn:hover { color: #a78bfa; border-color: #a78bfa; }
    .timeline-item .ti-btn.danger:hover { color: #f87171; border-color: #f87171; }
    .ti-trans-row {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px;
      background: #0c0c10; border: 1px dashed #2a2a3a; border-radius: 6px;
    }
    .ti-trans-row .ti-trans-arrow { color: #555; font-size: 14px; }
    .ti-trans-row label { font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; color: #666; font-weight: 700; flex-shrink: 0; }
    .ti-trans-row select { flex: 1; }

    #spliceEmpty { text-align: center; color: #555; font-size: 12px; padding: 18px; }
    #spliceActions { display: flex; gap: 10px; align-items: center; }
    #spliceActions button { background: #a78bfa; color: #0f0f13; border: none; border-radius: 8px; padding: 12px 18px; font-size: 14px; font-weight: 700; letter-spacing: .5px; cursor: pointer; }
    #spliceActions button:disabled { background: #2a2a3a; color: #555; cursor: not-allowed; }
    #spliceStatus { font-size: 12px; color: #888; flex: 1; }
    #spliceStatus.error { color: #f87171; }
    #spliceStatus.success { color: #4ade80; }

    .layout { display: flex; flex: 1; overflow: hidden; }

    /* Left panel */
    .panel { width: 220px; background: #13131a; border-right: 1px solid #2a2a3a; overflow-y: auto; padding: 12px; flex-shrink: 0; }
    .panel h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #666; margin: 16px 0 8px; }
    .panel h2:first-child { margin-top: 0; }

    .thumb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .cat-hint   { font-size: 9px; color: #555; font-weight: 400; letter-spacing: 0; text-transform: none; margin-left: 4px; }
    .thumb { cursor: pointer; border-radius: 6px; border: 2px solid transparent; overflow: hidden; aspect-ratio: 1; background: #1e1e2a; transition: border-color .15s; position: relative; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb.selected { border-color: #a78bfa; }
    .thumb.disabled { opacity: 0.25; cursor: not-allowed; }
    .thumb label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,.65); font-size: 9px; text-align: center; padding: 3px; text-transform: uppercase; letter-spacing: .5px; }

    /* Center canvas */
    .canvas-area { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 16px; padding: 24px; background: #0c0c10; overflow-y: auto; }
    canvas { border-radius: 12px; border: 1px solid #2a2a3a; max-height: 70vh; width: auto; }
    .canvas-label { font-size: 11px; color: #444; }

    /* Dual-frame canvas row */
    .canvas-row { display: flex; gap: 16px; align-items: flex-start; justify-content: center; flex-wrap: wrap; }
    .frame-slot { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; padding: 6px; border-radius: 14px; border: 2px solid transparent; transition: border-color .15s, background-color .15s; }
    .frame-slot.active { border-color: #a78bfa; background: #15121f; }
    .frame-slot:not(.active):hover { border-color: #2a2a3a; }
    .frame-label { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #666; font-weight: 700; }
    .frame-slot.active .frame-label { color: #a78bfa; }
    .preview-canvas { border-radius: 10px; border: 1px solid #2a2a3a; max-height: 55vh; width: auto; display: block; }
    .add-to-splice-btn {
      background: #1e1e2a; border: 1px solid #a78bfa; color: #a78bfa;
      border-radius: 6px; padding: 5px 10px; font-size: 10px; font-weight: 700;
      letter-spacing: 1px; cursor: pointer; margin-top: 4px; transition: all .15s;
    }
    .add-to-splice-btn:hover  { background: #a78bfa; color: #0f0f13; }
    .add-to-splice-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    #videoPreview { display: none; border-radius: 12px; border: 1px solid #a78bfa; max-height: 70vh; width: auto; background: #000; }
    #approveBar { display: none; width: 100%; max-width: 600px; }
    #approveBar.visible { display: flex !important; }
    #screenshotPanel.visible { display: flex !important; }
    .sc-thumb { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; }
    .sc-thumb img { height: 80px; width: auto; border-radius: 6px; border: 2px solid #2a2a3a; transition: border-color .15s; }
    .sc-thumb.selected img { border-color: #a78bfa; }
    .sc-thumb label { font-size: 9px; color: #555; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #videoPreview.visible { display: block; }

    /* Right panel */
    .right-panel { width: 260px; background: #13131a; border-left: 1px solid #2a2a3a; padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; flex-shrink: 0; }
    .right-panel h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #666; margin-bottom: 6px; }

    select, textarea, input[type=text] {
      width: 100%; background: #1e1e2a; border: 1px solid #2a2a3a; color: #e0e0e0;
      border-radius: 6px; padding: 8px; font-size: 13px; font-family: inherit;
    }
    select:focus, textarea:focus, input[type=text]:focus { outline: none; border-color: #a78bfa; }
    textarea { resize: vertical; min-height: 70px; }

    .toggle-row { display: flex; align-items: center; justify-content: space-between; }
    .toggle { position: relative; width: 40px; height: 22px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; background: #2a2a3a; border-radius: 22px; cursor: pointer; transition: .2s; }
    .slider:before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; bottom: 3px; background: #666; border-radius: 50%; transition: .2s; }
    input:checked + .slider { background: #a78bfa; }
    input:checked + .slider:before { transform: translateX(18px); background: white; }

    .btn-generate {
      background: #a78bfa; color: #0f0f13; border: none; border-radius: 8px;
      padding: 14px; font-size: 15px; font-weight: 700; cursor: pointer;
      letter-spacing: .5px; transition: background .15s; width: 100%;
    }
    .btn-generate:hover { background: #c4b5fd; }
    .btn-generate:disabled { background: #2a2a3a; color: #555; cursor: not-allowed; }

    .status { font-size: 12px; color: #888; text-align: center; min-height: 18px; }
    .status.error { color: #f87171; }
    .status.success { color: #4ade80; }

    .selection-summary { font-size: 11px; color: #555; line-height: 1.6; }
    .selection-summary span { color: #a78bfa; }

    .color-swatch-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .color-swatch { cursor: pointer; border-radius: 6px; border: 2px solid transparent; overflow: hidden; aspect-ratio: 1; transition: border-color .15s; position: relative; }
    .color-swatch label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,.55); font-size: 9px; text-align: center; padding: 3px; text-transform: uppercase; letter-spacing: .5px; color: #fff; }
    .color-swatch.selected { border-color: #a78bfa; }

    /* Confirm modal */
    #confirmModal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.8); z-index: 1000; align-items: center; justify-content: center; }
    #confirmModal.open { display: flex; }
    #confirmModal .modal-box { background: #1a1a24; border: 1px solid #a78bfa; border-radius: 14px; padding: 28px 24px; max-width: 320px; width: 90%; text-align: center; display: flex; flex-direction: column; gap: 16px; }
    #confirmModal .modal-title { font-size: 17px; font-weight: 700; color: #e0e0e0; }
    #confirmModal .modal-body { font-size: 13px; color: #888; line-height: 1.6; }
    #confirmModal .modal-btns { display: flex; gap: 10px; }
    #confirmModal .modal-btns button { flex: 1; padding: 11px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 700; border: none; }
    #confirmNo  { background: #1e1e2a; color: #888; border: 1px solid #2a2a3a !important; }
    #confirmYes { background: #a78bfa; color: #0f0f13; }
  </style>
</head>
<body>

<!-- Confirm modal — copy + cost line filled in dynamically based on mode -->
<div id="confirmModal">
  <div class="modal-box">
    <div class="modal-title" id="confirmTitle">🎬 Ready to Generate?</div>
    <div class="modal-body" id="confirmBody">Is the model set up and ready?<br>This costs ~$2.80 for an 8-second clip.</div>
    <div class="modal-btns">
      <button id="confirmNo">No, cancel</button>
      <button id="confirmYes">Yes, generate!</button>
    </div>
  </div>
</div>

<header>
  <h1>🐉 HABITBEAST VIDEO COMPOSER</h1>
  <div id="modeSwitch" style="display:flex;gap:6px;margin-left:auto;">
    <button class="mode-btn active" data-mode="blink" type="button">🔁 Blink Loop</button>
    <button class="mode-btn"        data-mode="splice" type="button">✂️ Splice Only</button>
  </div>
  <span id="headerHint" style="margin-left:14px;">Pick a monster + mouth → render an 8s blinking loop (no Veo cost)</span>
</header>

<div class="layout">

  <!-- LEFT: Asset picker -->
  <div class="panel" id="leftPanel">
    <h2>Background</h2>
    <div class="thumb-grid" id="bgGrid"></div>

    <h2>Flat Colors</h2>
    <div class="color-swatch-grid" id="flatColorGrid"></div>

    <h2>Character</h2>
    <div class="thumb-grid" id="monsterGrid"></div>

    <h2>Expression <span class="cat-hint">starting mood &mdash; drifts naturally during the loop</span></h2>
    <div class="thumb-grid" id="expressionGrid"></div>

    <h2>Mouth / Lips <span class="cat-hint">default, pretty, red &hellip; mood-aware</span></h2>
    <div class="thumb-grid" id="mouthStyleGrid"></div>

    <h2>Hats <span class="cat-hint">cap, cowboy hat, wizard hat</span></h2>
    <div class="thumb-grid" id="hatGrid"></div>

    <h2>Chest <span class="cat-hint">vest, sash, tee, tank</span></h2>
    <div class="thumb-grid" id="chestGrid"></div>

    <h2>Pants <span class="cat-hint">pants, trunks, bell bottoms</span></h2>
    <div class="thumb-grid" id="pantsGrid"></div>

    <h2>Shoes <span class="cat-hint">kicks, shoes, boots</span></h2>
    <div class="thumb-grid" id="shoesGrid"></div>

    <h2>Beards <span class="cat-hint">sits above clothing, below mouth</span></h2>
    <div class="thumb-grid" id="beardGrid"></div>

    <h2>Mustaches <span class="cat-hint">mood-aware overlay above the mouth</span></h2>
    <div class="thumb-grid" id="mustacheGrid"></div>

    <h2>Capes <span class="cat-hint">paired top + bottom</span></h2>
    <div class="thumb-grid" id="capeGrid"></div>

    <h2 style="display:none;">Clothing (legacy fallback)</h2>
    <div class="thumb-grid" id="clothingGrid" style="display:none;"></div>

    <h2>Bottom Items</h2>
    <div class="thumb-grid" id="bottomGrid"></div>
  </div>

  <!-- RIGHT (SPLICE MODE): Splice builder — bypass Veo, build from composed frames + clips -->
  <div id="spliceArea">
    <div class="splice-pickers">
      <div class="splice-picker">
        <h3>🐉 Composed Frames <span style="color:#444;font-weight:400;letter-spacing:.5px;">— click to add</span></h3>
        <div class="picker-grid" id="spliceComposedPicker"></div>
      </div>
      <div class="splice-picker">
        <h3>📱 Screenshots <span style="color:#444;font-weight:400;letter-spacing:.5px;">— click to add</span></h3>
        <div class="picker-grid" id="spliceScreenshotPicker"></div>
      </div>
      <div class="splice-picker">
        <h3>🎞️ GoodToGo Videos <span style="color:#444;font-weight:400;letter-spacing:.5px;">— click to add</span></h3>
        <div class="picker-grid" id="spliceVideoPicker"></div>
      </div>
    </div>
    <div id="spliceTimeline">
      <h3>
        <span>⏱ Sequence</span>
        <span class="total-time" id="spliceTotalTime">0s</span>
      </h3>
      <div id="spliceItems"></div>
      <div id="spliceEmpty">Use ⬇ buttons under each canvas to add the composed monster, then pick screenshots/videos above.</div>
    </div>
    <div id="spliceActions">
      <button id="spliceBtn" type="button" disabled>✂️ SPLICE</button>
      <button id="spliceClearBtn" type="button" style="background:#1e1e2a;color:#888;border:1px solid #2a2a3a;">CLEAR</button>
    </div>
    <div id="spliceStatus"></div>
  </div>

  <!-- CENTER: Canvas preview + video result -->
  <div class="canvas-area">
    <div id="canvasRow" class="canvas-row">
      <div class="frame-slot active" data-frame="0">
        <div class="frame-label">START FRAME</div>
        <canvas class="preview-canvas" data-frame="0" width="600" height="800"></canvas>
        <button class="add-to-splice-btn" data-frame="0" type="button" style="display:none;">⬇ ADD START TO SEQUENCE</button>
      </div>
      <div class="frame-slot" data-frame="1">
        <div class="frame-label">END FRAME <span style="color:#555;font-weight:400;">(optional)</span></div>
        <canvas class="preview-canvas" data-frame="1" width="600" height="800"></canvas>
        <button class="add-to-splice-btn" data-frame="1" type="button" style="display:none;">⬇ ADD END TO SEQUENCE</button>
      </div>
    </div>
    <div id="frameControls" style="display:flex;gap:8px;">
      <button id="copyFrameBtn" type="button" style="background:#1e1e2a;border:1px solid #2a2a3a;color:#a78bfa;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:700;letter-spacing:.5px;cursor:pointer;">⇄ COPY ACTIVE → OTHER</button>
      <button id="clearEndBtn" type="button" style="background:#1e1e2a;border:1px solid #2a2a3a;color:#888;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:700;letter-spacing:.5px;cursor:pointer;">✕ CLEAR END</button>
    </div>
    <video id="videoPreview" controls loop autoplay muted playsinline></video>
    <div class="canvas-label" id="centerLabel">Click a canvas to make it active · End frame optional</div>

    <!-- Approve / Reject bar (shown after generation) -->
    <div id="approveBar" style="display:none;gap:12px;margin-top:4px;">
      <button id="rejectBtn" style="flex:1;padding:10px 0;background:#3a1a1a;border:1px solid #7f1d1d;color:#f87171;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:.5px;">✕ Reject &amp; Recompose</button>
      <button id="approveBtn" style="flex:1;padding:10px 0;background:#1a3a1a;border:1px solid #14532d;color:#4ade80;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:.5px;">✓ Add to Grid</button>
    </div>

    <!-- Screenshot panel (shown after approval) -->
    <div id="screenshotPanel" style="display:none;flex-direction:column;gap:12px;width:100%;max-width:600px;margin-top:8px;background:#13131a;border:1px solid #2a2a3a;border-radius:10px;padding:16px;">

      <!-- ── INTRO section ── -->
      <div style="font-size:12px;color:#a78bfa;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">🎬 Intro (optional)</div>
      <div style="font-size:10px;color:#444;">Pick an image (Screenshots/) or a video (GoodToGo/) to play before the main clip.</div>
      <div id="introThumbs" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      <div id="introStatus" style="font-size:11px;color:#555;"></div>
      <div style="display:flex;gap:10px;">
        <button id="introBtn" style="flex:1;padding:9px 0;background:#1a2a3a;border:1px solid #2563eb;color:#93c5fd;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">⬆️ Add Intro</button>
        <button id="skipIntroBtn" style="padding:9px 16px;background:#1e1e2a;border:1px solid #2a2a3a;color:#555;border-radius:8px;cursor:pointer;font-size:12px;">Skip</button>
      </div>

      <!-- divider -->
      <div style="border-top:1px solid #2a2a3a;"></div>

      <!-- ── SCREENSHOTS section ── -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div style="font-size:12px;color:#a78bfa;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">📱 Screenshots</div>
        <div style="display:flex;gap:6px;">
          <button class="sc-mode-btn active" data-mode="end"          style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #a78bfa;background:#1e1e2a;color:#a78bfa;cursor:pointer;font-weight:700;">📍 At End</button>
          <button class="sc-mode-btn"        data-mode="interspersed" style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;">🔀 Interspersed</button>
        </div>
      </div>
      <div id="screenshotThumbs" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      <!-- Transition style picker -->
      <div>
        <div style="font-size:10px;color:#444;letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px;">Transition Style</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;" id="zoomStyleBtns">
          <button class="zoom-style-btn active" data-style="punch"     style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #a78bfa;background:#1e1e2a;color:#a78bfa;cursor:pointer;font-weight:700;">⚡ Punch</button>
          <button class="zoom-style-btn"        data-style="burst"     style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;">💥 Burst</button>
          <button class="zoom-style-btn"        data-style="pull-back" style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;">🔭 Pull Back</button>
          <button class="zoom-style-btn"        data-style="drift"     style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;">🌊 Drift</button>
          <button class="zoom-style-btn"        data-style="ken-burns" style="padding:5px 10px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;">🎞️ Ken Burns</button>
        </div>
      </div>
      <div id="screenshotStatus" style="font-size:11px;color:#555;"></div>
      <div style="display:flex;gap:10px;">
        <button id="appendBtn" style="flex:1;padding:10px 0;background:#2a1a4a;border:1px solid #7c3aed;color:#c4b5fd;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">📍 Add to End</button>
        <button id="skipScreenshotsBtn" style="padding:10px 16px;background:#1e1e2a;border:1px solid #2a2a3a;color:#555;border-radius:8px;cursor:pointer;font-size:12px;">Skip</button>
      </div>
    </div>
  </div>

  <!-- RIGHT: Controls -->
  <div class="right-panel">

    <div>
      <h2>Selected Layers</h2>
      <div class="selection-summary" id="summary">Nothing selected yet.</div>
    </div>

    <!-- BLINK MODE controls — auto-derived mood, simple duration slider -->
    <div class="blink-only">
      <h2>Mood <span style="font-size:10px;color:#555;font-weight:400;">(from mouth)</span></h2>
      <div id="blinkMoodReadout" style="font-size:13px;color:#a78bfa;font-weight:700;letter-spacing:.5px;background:#1e1e2a;border:1px solid #2a2a3a;border-radius:6px;padding:8px 10px;text-transform:uppercase;">happy <span style="color:#555;font-weight:400;text-transform:none;letter-spacing:0;">— normal blink rate, even open/partial</span></div>
    </div>

    <div class="blink-only">
      <h2>Background Color <span style="font-size:10px;color:#555;font-weight:400;">(from Flat Colors)</span></h2>
      <div id="blinkBgReadout" style="display:flex;align-items:center;gap:8px;font-size:12px;color:#888;background:#1e1e2a;border:1px solid #2a2a3a;border-radius:6px;padding:8px 10px;">
        <span id="blinkBgSwatch" style="display:inline-block;width:18px;height:18px;border-radius:4px;border:1px solid #333;background:#1a1a24;"></span>
        <span id="blinkBgLabel">#1a1a24 — pick a flat color for a custom backdrop</span>
      </div>
    </div>

    <div class="blink-only">
      <h2>Duration <span id="blinkDurReadout" style="font-size:10px;color:#a78bfa;font-weight:700;">8s</span></h2>
      <input type="range" id="blinkDuration" min="2" max="20" step="1" value="8" style="width:100%;accent-color:#a78bfa;">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#444;margin-top:2px;">
        <span>2s</span><span>20s</span>
      </div>
    </div>

    <!-- FART SEQUENCE — single-monster behavior render. Uses the active monster + bg + clothing. -->
    <div class="blink-only">
      <button id="fartBtn" type="button" style="width:100%;padding:9px 0;background:#1e1e2a;border:1px solid #2a2a3a;color:#86efac;border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;letter-spacing:.5px;">
        💨 Render Fart Sequence (~7s)
      </button>
      <div style="font-size:10px;color:#444;margin-top:4px;line-height:1.3;">
        Strain → relief → 8-frame cloud → openWide finale. Pick a monster on the left first.
      </div>
    </div>

    <!-- BRADY BUNCH GRID BIN — collects 8 cells, then composes a 3×3 montage with a center title card -->
    <div class="blink-only">
      <h2>🎬 Brady Bunch Grid <span id="bradyCount" style="font-size:10px;color:#555;font-weight:400;">(0 / 8 cells)</span></h2>
      <div style="font-size:10px;color:#555;line-height:1.4;margin-bottom:6px;">
        Pick a monster + mouth + outfit, then click an empty slot below — or render a preview first and use <b>✓ Add to Grid</b>. Center is the title card.
      </div>
      <div id="bradyGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:#0e0e14;border:1px solid #2a2a3a;border-radius:8px;padding:6px;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">
        <input type="text" id="bradyTitleText" placeholder="Title (HabitBeast)" maxlength="24" style="font-size:11px;padding:6px 8px;background:#1e1e2a;border:1px solid #2a2a3a;border-radius:6px;color:#ddd;">
        <input type="text" id="bradyTitleSub" placeholder="Subtitle…" maxlength="48" style="font-size:11px;padding:6px 8px;background:#1e1e2a;border:1px solid #2a2a3a;border-radius:6px;color:#ddd;">
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button id="bradyComposeBtn" disabled style="flex:1;padding:9px 0;background:#1a3a2a;border:1px solid #15803d;color:#86efac;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.5px;opacity:.5;">🎬 Compose Brady Bunch</button>
        <button id="bradyClearBtn" type="button" style="padding:9px 12px;background:#1e1e2a;border:1px solid #2a2a3a;color:#666;border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;">Clear All</button>
      </div>
    </div>

    <!-- LINEUP PAN BIN — collects 8 cells in left-to-right pan order, then renders a horizontal pan video -->
    <div class="blink-only">
      <h2>🎥 Lineup Pan <span id="lineupCount" style="font-size:10px;color:#555;font-weight:400;">(0 / 8 cells)</span></h2>
      <div style="font-size:10px;color:#555;line-height:1.4;margin-bottom:6px;">
        Camera goes wide → zooms into cell 1 → pans across all 8 → zooms back out. Left-to-right is the camera path. Click a slot to capture the active monster.
      </div>
      <div id="lineupBin" style="display:flex;gap:4px;background:#0e0e14;border:1px solid #2a2a3a;border-radius:8px;padding:6px;"></div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button id="lineupComposeBtn" disabled style="flex:1;padding:9px 0;background:#1a3a2a;border:1px solid #15803d;color:#86efac;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.5px;opacity:.5;">🎥 Compose Lineup Pan</button>
        <button id="lineupClearBtn" type="button" style="padding:9px 12px;background:#1e1e2a;border:1px solid #2a2a3a;color:#666;border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;">Clear All</button>
      </div>
    </div>

    <div class="veo-only">
      <h2>Style</h2>
      <select id="styleSelect"></select>
    </div>

    <div class="veo-only">
      <h2>Behavior</h2>
      <textarea id="behavior" placeholder="Describe what the character does... (leave blank for default)"></textarea>
    </div>

    <div class="veo-only">
      <h2>Text Mode</h2>
      <div style="display:flex;gap:6px;">
        <button class="text-mode-btn active" data-mode="veo" style="flex:1;padding:7px 4px;font-size:11px;border-radius:6px;border:2px solid #a78bfa;background:#1e1e2a;color:#a78bfa;cursor:pointer;font-weight:700;letter-spacing:.5px;">✨ Veo</button>
        <button class="text-mode-btn" data-mode="both" style="flex:1;padding:7px 4px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;letter-spacing:.5px;">⚡ Both</button>
        <button class="text-mode-btn" data-mode="burn" style="flex:1;padding:7px 4px;font-size:11px;border-radius:6px;border:2px solid #2a2a3a;background:#1e1e2a;color:#555;cursor:pointer;font-weight:700;letter-spacing:.5px;">🔤 Burn</button>
      </div>
      <div style="font-size:10px;color:#444;margin-top:5px" id="textModeHint">Veo renders text dynamically in the scene — more cinematic, less predictable.</div>
    </div>

    <div class="veo-only">
      <h2>Text Overlay</h2>
      <input type="text" id="overlayText" placeholder='e.g. "Train your monster."'>
      <input type="text" id="subText" placeholder='Subtext (slight delay)...' style="margin-top:6px;font-size:12px;color:#aaa;">
    </div>

    <div>
      <h2>Aspect Ratio</h2>
      <select id="aspectRatio">
        <option value="1:1">1:1 — Square (Instagram / Threads)</option>
        <option value="9:16">9:16 — Portrait (TikTok / Reels)</option>
        <option value="16:9">16:9 — Landscape (YouTube)</option>
      </select>
    </div>

    <button class="btn-generate" id="generateBtn" disabled>Generate Video</button>

    <button id="libraryBtn" style="width:100%;padding:9px 0;background:#1e1e2a;border:1px solid #2a2a3a;color:#666;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.5px;transition:border-color .15s,color .15s;">📁 Open from GoodToGo</button>

    <!-- GoodToGo picker (shown inline) -->
    <div id="libraryPicker" style="display:none;background:#0f0f13;border:1px solid #2a2a3a;border-radius:8px;padding:10px;max-height:200px;overflow-y:auto;">
      <div style="font-size:10px;color:#555;letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px;">Approved Videos</div>
      <div id="libraryList"></div>
    </div>

    <div id="costEstimate" class="veo-only" style="text-align:center;font-size:12px;color:#555;margin-top:-6px;">
      Est. cost: <span id="estCost">—</span>
    </div>

    <div id="blinkFreeNote" class="blink-only" style="text-align:center;font-size:12px;color:#4ade80;margin-top:-6px;">
      💸 Local render — $0.00 / unlimited iterations
    </div>

    <div class="status" id="status"></div>

    <div id="costMeter" style="display:none;text-align:center;padding:10px;background:#1e1e2a;border-radius:8px;border:1px solid #2a2a3a;">
      <div style="font-size:10px;color:#666;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Burning money</div>
      <div id="costCounter" style="font-size:28px;font-weight:700;color:#f87171;font-variant-numeric:tabular-nums;">$0.0000</div>
      <div style="font-size:10px;color:#444;margin-top:4px;">Today: <span id="todayCostLive">—</span></div>
    </div>

    <div id="costSummary" style="display:none;font-size:11px;color:#666;text-align:center;line-height:1.8;">
      This run: <span id="runCost" style="color:#a78bfa;font-weight:700;"></span><br>
      Today: <span id="todayCostFinal" style="color:#888;"></span> &nbsp;|&nbsp;
      All time: <span id="totalCostFinal" style="color:#888;"></span>
    </div>

  </div>
</div>

<script>
  const BIG_MONSTERS = ["frank", "wolf", "murk", "biggs"];
  const SMALL_MONSTERS = ["stumbles", "iggs", "wrapps", "entsy"];

  // Eye folder names are PascalCase (Big/Eyes/Frank/) while body filenames are lowercase (frank.png).
  const EYE_FOLDER = {
    frank: "Frank", wolf: "Wolf", murk: "Murk", biggs: "Biggs",
    stumbles: "Stumbles", iggs: "Iggs", wrapps: "Wrapps", entsy: "Entsy",
  };

  // Clothing slot inference — enforces one-per-slot on the monster.
  // Derives the slot from the filename suffix so new PNGs auto-categorize
  // as long as they follow the convention:
  //   hat:    *Cap, *CowboyHat, *Hat
  //   chest:  *Vest, *Sash, *Tee, *Shirt
  //   pants:  *Pants, *Bottoms, *Trunks
  //   shoes:  *Kicks, *Shoes, *Boots
  // Anything unmatched gets a unique "other:<name>" slot so it never
  // evicts another item — safe default for new asset types.
  function clothingSlot(filename) {
    const name = filename.replace(/\\.png$/i, "");
    // Beards live in the same folder as clothing but have their own exclusive
    // slot (matches MonsterAvatar's render order — beard sits below mouth/eyes).
    if (/Beard$/i.test(name)) return "beard";
    if (/(CowboyHat|WizardHat|Hat|Cap)$/i.test(name)) return "hat";
    if (/(Vest|Sash|Tee|Shirt|Tank)$/i.test(name)) return "chest";
    if (/(Pants|Bottoms|Trunks)$/i.test(name)) return "pants";
    if (/(Kicks|Shoes|Boots|Slippas)$/i.test(name)) return "shoes";
    return "other:" + name;
  }

  // Two frames for Veo's image-to-video transitions:
  //   frames[0] = first frame (required)
  //   frames[1] = last frame (optional — if authored, sent as config.lastFrame)
  // The active frame is the one receiving clicks. Grids and the right-panel
  // summary reflect cur(); both canvases always render from their own frame.
  // Eye animation is fully derived from mood (mouth choice) — same as Habit Beast.
  // The user never picks an eye state directly; the renderer animates open/partial/closed
  // via the blink state machine. For static canvas previews we composite "open.png".
  const EMPTY_FRAME = () => ({
    background: null,
    monster: null,
    mood: "happy",       // starting expression — drives the blink state machine; drifts during the loop
    mouthStyle: null,    // lip style id (e.g. "pretty" / "red") — null = default mood mouth
    clothing: [],        // array — at most one per slot (hat/chest/pants/shoes/beard)
    bottom: null,        // from Bottom/
    cape: null,          // cape name (e.g. "blackCape") — pairs Top + Bottom from {size}/Paired/
    mustache: null,      // mustache style id (e.g. "founder") — mood-aware mustache overlay
  });
  let state = {
    frames: [EMPTY_FRAME(), EMPTY_FRAME()],
    activeFrame: 0,    // 0 or 1
    assets: null,
  };
  function cur() { return state.frames[state.activeFrame]; }
  function frameIsEmpty(f) {
    return !f.monster && !f.background && !f.mouthStyle && f.clothing.length === 0 && !f.bottom && !f.cape && !f.mustache;
  }

  // Two preview canvases (start + end frame). Keep handles for both so each
  // frame draws into its own surface. Wiring lives in init().
  let canvases = [];   // [HTMLCanvasElement, HTMLCanvasElement]
  let ctxs     = [];   // [CanvasRenderingContext2D, CanvasRenderingContext2D]

  // Load assets list
  async function init() {
    const res = await fetch("/api/assets");
    state.assets = await res.json();

    // Wire canvas refs and frame-switching clicks
    document.querySelectorAll(".preview-canvas").forEach(c => {
      const idx = parseInt(c.dataset.frame, 10);
      canvases[idx] = c;
      ctxs[idx] = c.getContext("2d");
      c.addEventListener("click", () => {
        if (state.activeFrame !== idx) setActiveFrame(idx);
      });
    });

    buildGrid("bgGrid", state.assets.backgrounds, "background", f => f, f => f.replace(".png",""));
    buildGrid("monsterGrid", state.assets.monsters, "monster", f => f + ".png", f => f.replace("lab-assistant","lab assistant"));
    buildFlatColorGrid(state.assets.flatColors || []);

    // Styles
    const sel = document.getElementById("styleSelect");
    state.assets.styles.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    });

    buildClothingGrids();
    applyActiveFrameUI();
    drawAllCanvases();
    // Initial render of the Brady Bunch grid bin (all 8 cells empty)
    renderBradyGrid();
    // Apply default mode (blink) — hides Veo-only fields and shows the blink readouts
    setMode(currentMode);
  }

  // Switch which frame receives clicks. Grids rebuild so selection highlights
  // reflect the new active frame's picks.
  function setActiveFrame(idx) {
    state.activeFrame = idx;
    applyActiveFrameUI();
    // Re-highlight background (flat color swatches + bg thumbs)
    document.querySelectorAll('.thumb[data-type="background"], .color-swatch').forEach(t => {
      t.classList.toggle("selected", t.dataset.value === cur().background);
    });
    // Re-highlight monster grid
    document.querySelectorAll('.thumb[data-type="monster"]').forEach(t => {
      t.classList.toggle("selected", t.dataset.value === cur().monster);
    });
    buildClothingGrids();
    updateSummary();
    updateGenerateBtn();
  }

  function applyActiveFrameUI() {
    document.querySelectorAll(".frame-slot").forEach(slot => {
      const idx = parseInt(slot.dataset.frame, 10);
      slot.classList.toggle("active", idx === state.activeFrame);
    });
  }

  // Copy the currently-active frame to the other slot. Handy shortcut for
  // "same scene, change one thing" transitions (e.g. swap mouth for end frame).
  function copyActiveToOther() {
    const src = cur();
    const dstIdx = state.activeFrame === 0 ? 1 : 0;
    state.frames[dstIdx] = {
      background: src.background,
      monster: src.monster,
      mouth: src.mouth,
      clothing: [...src.clothing],
      bottom: src.bottom,
    };
    drawAllCanvases();
  }

  // Clear the non-active frame (useful to abandon a transition)
  function clearFrame(idx) {
    state.frames[idx] = EMPTY_FRAME();
    if (idx === state.activeFrame) {
      // Deselect UI highlights
      document.querySelectorAll('.thumb.selected, .color-swatch.selected').forEach(t => t.classList.remove("selected"));
      buildClothingGrids();
      updateSummary();
      updateGenerateBtn();
    }
    drawAllCanvases();
  }

  function buildFlatColorGrid(colors) {
    const grid = document.getElementById("flatColorGrid");
    grid.innerHTML = "";
    colors.forEach(({ label, color }) => {
      const value = "flat:" + color;
      const div = document.createElement("div");
      div.className = "color-swatch" + (cur().background === value ? " selected" : "");
      div.dataset.type = "background";
      div.dataset.value = value;
      div.style.background = color;
      div.innerHTML = \`<label>\${label}</label>\`;
      div.addEventListener("click", () => {
        document.querySelectorAll('.thumb[data-type="background"], .color-swatch').forEach(t => t.classList.remove("selected"));
        if (cur().background === value) {
          cur().background = null;
        } else {
          cur().background = value;
          div.classList.add("selected");
        }
        updateSummary();
        drawAllCanvases();
      });
      grid.appendChild(div);
    });
  }

  function buildGrid(containerId, items, type, pathFn, labelFn) {
    const grid = document.getElementById(containerId);
    grid.innerHTML = "";
    items.forEach(item => {
      const div = document.createElement("div");
      div.className = "thumb";
      div.dataset.type = type;
      div.dataset.value = item;
      div.innerHTML = \`<img src="/assets/\${pathFn(item)}" loading="lazy"><label>\${labelFn(item).replace(".png","")}</label>\`;
      div.addEventListener("click", () => handleSelect(type, item, div));
      grid.appendChild(div);
    });
  }

  function buildClothingGrids() {
    const monster = cur().monster;
    const isBig = BIG_MONSTERS.includes(monster);
    const isSmall = SMALL_MONSTERS.includes(monster);

    // Expression (mood) — single-select. Drives the starting mood for the
    // blink state machine; mood drifts naturally during the loop. Each swatch
    // shows that mood's DEFAULT mouth so you can preview the look.
    const expressionGrid = document.getElementById("expressionGrid");
    if (expressionGrid) {
      expressionGrid.innerHTML = "";
      const MOODS = ["happy", "okay", "excited", "sad", "upset"];
      if (!monster || monster === "lab-assistant") {
        expressionGrid.innerHTML = '<div style="font-size:11px;color:#444;padding:4px;grid-column:1/-1;">' + (!monster ? 'Select a character first' : 'No expressions for lab assistant') + '</div>';
      } else {
        const subdir = isBig ? "Big/Mouths/" : "Small/Mouths/";
        MOODS.forEach(mood => {
          const div = document.createElement("div");
          div.className = "thumb" + (cur().mood === mood ? " selected" : "");
          div.dataset.type = "mood";
          div.dataset.value = mood;
          div.innerHTML = \`<img src="/assets/\${subdir}\${mood}.png" loading="lazy"><label>\${mood}</label>\`;
          div.addEventListener("click", () => handleSelect("mood", mood, div));
          expressionGrid.appendChild(div);
        });
      }
    }

    // Mouth/Lips — style picker. "Default" = the plain mood mouth, no style
    // prefix. "pretty"/"red" use the styled variants. All are mood-aware:
    // the renderer picks <style><MoodCap>.png each frame so mood drift swaps
    // the styled mouth too.
    const mouthStyleGrid = document.getElementById("mouthStyleGrid");
    if (mouthStyleGrid) {
      mouthStyleGrid.innerHTML = "";
      if (!monster || monster === "lab-assistant") {
        mouthStyleGrid.innerHTML = '<div style="font-size:11px;color:#444;padding:4px;grid-column:1/-1;">' + (!monster ? 'Select a character first' : 'No mouth styles for lab assistant') + '</div>';
      } else {
        const subdir = isBig ? "Big/Mouths/" : "Small/Mouths/";
        const styles = isBig ? (state.assets.bigMouthStyles || []) : (state.assets.smallMouthStyles || []);
        // "default" tile uses the plain happy.png so users see what the baseline mood face looks like
        const defaultTile = document.createElement("div");
        defaultTile.className = "thumb" + (!cur().mouthStyle ? " selected" : "");
        defaultTile.dataset.type = "mouthStyle";
        defaultTile.dataset.value = "";
        defaultTile.innerHTML = \`<img src="/assets/\${subdir}happy.png" loading="lazy"><label>default</label>\`;
        defaultTile.addEventListener("click", () => handleSelect("mouthStyle", "", defaultTile));
        mouthStyleGrid.appendChild(defaultTile);
        styles.forEach(style => {
          const div = document.createElement("div");
          div.className = "thumb" + (cur().mouthStyle === style ? " selected" : "");
          div.dataset.type = "mouthStyle";
          div.dataset.value = style;
          div.innerHTML = \`<img src="/assets/\${subdir}\${style}Happy.png" loading="lazy"><label>\${style}</label>\`;
          div.addEventListener("click", () => handleSelect("mouthStyle", style, div));
          mouthStyleGrid.appendChild(div);
        });
      }
    }

    // Eyes are auto-driven by mood (mouth selection) — no picker needed. The blink
    // renderer animates open/partial/closed via the state machine; static previews
    // composite "open.png" (handled in buildLayerListFor).

    // Clothing (Big or Small) — grouped per slot for clarity. Each slot has
    // its own grid so the user immediately sees which categories are available
    // and how many options exist per slot.
    const SLOT_GRID_IDS = { hat: "hatGrid", chest: "chestGrid", pants: "pantsGrid", shoes: "shoesGrid", beard: "beardGrid" };
    Object.values(SLOT_GRID_IDS).forEach(gid => {
      const g = document.getElementById(gid);
      if (g) g.innerHTML = "";
    });
    // Hide the unused legacy clothingGrid container
    const legacyGrid = document.getElementById("clothingGrid");
    if (legacyGrid) legacyGrid.innerHTML = "";

    let clothingItems = [];
    let clothingSubdir = "";

    if (isBig) { clothingItems = state.assets.bigClothing; clothingSubdir = "Big/"; }
    else if (isSmall) { clothingItems = state.assets.smallClothing; clothingSubdir = "Small/"; }

    clothingItems.forEach(item => {
      const slot = clothingSlot(item);
      const targetId = SLOT_GRID_IDS[slot] || "clothingGrid";
      const targetGrid = document.getElementById(targetId);
      if (!targetGrid) return;
      const div = document.createElement("div");
      div.className = "thumb" + (cur().clothing.includes(item) ? " selected" : "");
      div.dataset.type = "clothing";
      div.dataset.value = item;
      div.innerHTML = \`<img src="/assets/\${clothingSubdir}\${item}" loading="lazy"><label>\${item.replace(".png","")}</label>\`;
      div.addEventListener("click", () => handleSelect("clothing", item, div));
      targetGrid.appendChild(div);
    });

    // Empty-state messages for each slot the active monster has no items in
    Object.entries(SLOT_GRID_IDS).forEach(([slot, gid]) => {
      const g = document.getElementById(gid);
      if (g && g.children.length === 0) {
        if (!monster || monster === "lab-assistant") {
          g.innerHTML = '<div style="font-size:11px;color:#444;padding:4px;grid-column:1/-1;">' + (!monster ? 'Select a character first' : 'No clothing for lab assistant') + '</div>';
        } else {
          g.innerHTML = '<div style="font-size:10px;color:#333;padding:4px;grid-column:1/-1;">No ' + slot + ' yet</div>';
        }
      }
    });

    // Capes (paired top + bottom) — single-select like bottom
    const capeGrid = document.getElementById("capeGrid");
    if (capeGrid) {
      capeGrid.innerHTML = "";
      let capeItems = [];
      if (isBig)        capeItems = state.assets.bigCapes   || [];
      else if (isSmall) capeItems = state.assets.smallCapes || [];

      if (!monster || monster === "lab-assistant") {
        capeGrid.innerHTML = '<div style="font-size:11px;color:#444;padding:4px;grid-column:1/-1;">' + (!monster ? 'Select a character first' : 'No capes for lab assistant') + '</div>';
      } else if (capeItems.length === 0) {
        capeGrid.innerHTML = '<div style="font-size:10px;color:#333;padding:4px;grid-column:1/-1;">No capes available</div>';
      } else {
        capeItems.forEach(name => {
          const div = document.createElement("div");
          div.className = "thumb" + (cur().cape === name ? " selected" : "");
          div.dataset.type = "cape";
          div.dataset.value = name;
          // Preview = composite Top of cape (visible half) — Bottom drapes behind body
          div.innerHTML = \`<img src="/assets/\${clothingSubdir}Paired/\${name}Top.png" loading="lazy"><label>\${name}</label>\`;
          div.addEventListener("click", () => handleSelect("cape", name, div));
          capeGrid.appendChild(div);
        });
      }
    }

    // Mustaches — mood-aware overlay served from /mustaches (RN asset tree)
    const mustacheGrid = document.getElementById("mustacheGrid");
    if (mustacheGrid) {
      mustacheGrid.innerHTML = "";
      let mustacheItems = [];
      if (isBig)        mustacheItems = state.assets.bigMustaches   || [];
      else if (isSmall) mustacheItems = state.assets.smallMustaches || [];

      if (!monster || monster === "lab-assistant") {
        mustacheGrid.innerHTML = '<div style="font-size:11px;color:#444;padding:4px;grid-column:1/-1;">' + (!monster ? 'Select a character first' : 'No mustaches for lab assistant') + '</div>';
      } else if (mustacheItems.length === 0) {
        mustacheGrid.innerHTML = '<div style="font-size:10px;color:#333;padding:4px;grid-column:1/-1;">No mustaches available</div>';
      } else {
        const sizeFolder = isBig ? "Big" : "Small";
        // Preview uses the Happy variant since that's what the active mood is
        // most of the time in default renders.
        mustacheItems.forEach(style => {
          const div = document.createElement("div");
          div.className = "thumb" + (cur().mustache === style ? " selected" : "");
          div.dataset.type = "mustache";
          div.dataset.value = style;
          div.innerHTML = \`<img src="/mustaches/\${sizeFolder}/Mustaches/\${style}Happy.png" loading="lazy"><label>\${style}</label>\`;
          div.addEventListener("click", () => handleSelect("mustache", style, div));
          mustacheGrid.appendChild(div);
        });
      }
    }

    // Bottom items (universal)
    buildGrid("bottomGrid", state.assets.bottomItems, "bottom", f => "Bottom/" + f, f => f.replace(".png",""));
    if (cur().bottom) {
      document.querySelectorAll('#bottomGrid .thumb').forEach(el => {
        if (el.dataset.value === cur().bottom) el.classList.add("selected");
      });
    }
  }

  function handleSelect(type, value, el) {
    const frame = cur();
    if (type === "clothing") {
      // Slot-based multi-select: at most one item per slot (hat, chest, pants, shoes, ...).
      // Clicking a selected item deselects it; clicking a new item in an occupied slot
      // evicts the previous occupant.
      const idx = frame.clothing.indexOf(value);
      if (idx > -1) {
        frame.clothing.splice(idx, 1);
        el.classList.remove("selected");
      } else {
        const newSlot = clothingSlot(value);
        const conflicts = frame.clothing.filter(c => clothingSlot(c) === newSlot);
        conflicts.forEach(conflictItem => {
          const conflictIdx = frame.clothing.indexOf(conflictItem);
          if (conflictIdx > -1) frame.clothing.splice(conflictIdx, 1);
          document.querySelectorAll('.thumb[data-type="clothing"]').forEach(t => {
            if (t.dataset.value === conflictItem) t.classList.remove("selected");
          });
        });
        frame.clothing.push(value);
        el.classList.add("selected");
      }
    } else if (type === "mood") {
      // Mood is required — can be changed but not cleared. Always has a value.
      const current = frame.mood;
      if (current !== value) {
        document.querySelectorAll('.thumb[data-type="mood"]').forEach(t => t.classList.remove("selected"));
        frame.mood = value;
        el.classList.add("selected");
      }
    } else if (type === "mouthStyle") {
      // Empty string = default style (plain mood mouth). Clicking the same tile twice has no effect.
      const desired = value || null;
      if (frame.mouthStyle !== desired) {
        document.querySelectorAll('.thumb[data-type="mouthStyle"]').forEach(t => t.classList.remove("selected"));
        frame.mouthStyle = desired;
        el.classList.add("selected");
      }
    } else {
      // Single-select: toggle off or switch
      const current = frame[type];
      if (current === value) {
        frame[type] = null;
        el.classList.remove("selected");
      } else {
        // Deselect both regular thumbs and flat color swatches for this type
        document.querySelectorAll(\`.thumb[data-type="\${type}"], .color-swatch[data-type="\${type}"]\`).forEach(t => t.classList.remove("selected"));
        frame[type] = value;
        el.classList.add("selected");
      }
    }

    // Character changed — preserve outfit across Big↔Small since both folders
    // share the same filenames. Defensively filter to items that actually exist
    // in the new size's asset list (handles future asymmetric drops).
    // Lab-assistant has no clothing/mouth support, so clear when switching to it.
    // Eyes are no longer user-pickable — driven entirely by mood in the blink renderer.
    if (type === "monster") {
      const newMonster = frame.monster;
      if (newMonster === "lab-assistant") {
        frame.clothing = [];
        frame.mouthStyle = null;
        frame.cape = null;
        frame.mustache = null;
        // frame.bottom is universal (accessories like skateboards), keep it
        // frame.mood stays — it's a starting expression independent of monster
      } else if (newMonster) {
        const isBig = BIG_MONSTERS.includes(newMonster);
        const validClothing = isBig ? (state.assets.bigClothing || []) : (state.assets.smallClothing || []);
        frame.clothing = frame.clothing.filter(c => validClothing.includes(c));
        const validMouthStyles = isBig ? (state.assets.bigMouthStyles || []) : (state.assets.smallMouthStyles || []);
        if (frame.mouthStyle && !validMouthStyles.includes(frame.mouthStyle)) frame.mouthStyle = null;
        const validCapes = isBig ? (state.assets.bigCapes || []) : (state.assets.smallCapes || []);
        if (frame.cape && !validCapes.includes(frame.cape)) frame.cape = null;
        const validMustaches = isBig ? (state.assets.bigMustaches || []) : (state.assets.smallMustaches || []);
        if (frame.mustache && !validMustaches.includes(frame.mustache)) frame.mustache = null;
      } else {
        // Monster deselected — clear size-scoped state
        frame.clothing = [];
        frame.mouthStyle = null;
        frame.cape = null;
        frame.mustache = null;
      }
      buildClothingGrids();
    }

    updateSummary();
    drawAllCanvases();
  }

  async function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Draw a single frame into the given 2D context.
  async function drawFrameTo(ctx, canvas, frame) {
    const cw = canvas.width;
    const ch = canvas.height;
    const cx = cw / 2;

    ctx.clearRect(0, 0, cw, ch);

    // Fill background color (flat or default dark)
    if (frame.background && frame.background.startsWith("flat:")) {
      ctx.fillStyle = frame.background.slice(5);
    } else {
      ctx.fillStyle = "#1a1a24";
    }
    ctx.fillRect(0, 0, cw, ch);

    // Draw image background with cover-fit before any monster layers
    if (frame.background && !frame.background.startsWith("flat:")) {
      try {
        const bgImg = await loadImage("/assets/" + frame.background);
        const scale = Math.max(cw / bgImg.naturalWidth, ch / bgImg.naturalHeight);
        const tw = bgImg.naturalWidth * scale;
        const th = bgImg.naturalHeight * scale;
        ctx.drawImage(bgImg, (cw - tw) / 2, (ch - th) / 2, tw, th);
      } catch(e) {}
    }

    const layers = buildLayerListFor(frame);
    for (const src of layers) {
      if (src.startsWith("flat:")) continue;
      if (frame.background && src === frame.background) continue; // already drawn above
      try {
        const img = await loadImage("/assets/" + src);
        ctx.drawImage(img, 0, 0, cw, ch);
      } catch(e) {}
    }

    // Draw text overlays as preview (shown on both frames for consistency)
    const mainText = document.getElementById("overlayText").value.trim();
    const subText  = document.getElementById("subText").value.trim();

    if (mainText) {
      ctx.save();
      ctx.font = "bold 42px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 8;
      const metrics = ctx.measureText(mainText);
      const bw = metrics.width + 24;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(cx - bw/2, ch * 0.70, bw, 52);
      ctx.fillStyle = "white";
      ctx.fillText(mainText, cx, ch * 0.765);
      ctx.restore();
    }

    if (subText) {
      ctx.save();
      ctx.font = "24px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(subText, cx, ch * 0.85);
      ctx.restore();
    }
  }

  // Draw both frames and refresh the Generate button state.
  async function drawAllCanvases() {
    for (let i = 0; i < state.frames.length; i++) {
      if (ctxs[i] && canvases[i]) {
        await drawFrameTo(ctxs[i], canvases[i], state.frames[i]);
      }
    }
    updateGenerateBtn();
  }

  // Build the layered path list for a given frame.
  function buildLayerListFor(frame) {
    const layers = [];
    if (frame.background) layers.push(frame.background);
    const isBig = frame.monster && BIG_MONSTERS.includes(frame.monster);
    const subdir = isBig ? "Big/" : "Small/";
    const size = isBig ? "Big" : "Small";
    const isCharOk = frame.monster && frame.monster !== "lab-assistant";

    // Cape Bottom drapes behind the monster body — render it BEFORE the body
    // and the universal Bottom slot so it sits at the back of the stack.
    if (frame.cape && isCharOk) {
      layers.push(subdir + "Paired/" + frame.cape + "Bottom.png");
    }
    if (frame.bottom) layers.push("Bottom/" + frame.bottom);
    if (frame.monster) layers.push(frame.monster + ".png");

    // Body-region clothing (pants → shoes → chest) renders BEFORE the face
    // stack so the cape collar drapes over the chest. Beard is rendered ABOVE
    // cape top (further down), so it drapes over both the shirt and the cape.
    const allClothing = isCharOk ? (frame.clothing || []) : [];
    const pickSlot = (slot) => allClothing.filter(c => clothingSlot(c) === slot);
    pickSlot("pants").forEach(c => layers.push(subdir + c));
    pickSlot("shoes").forEach(c => layers.push(subdir + c));
    pickSlot("chest").forEach(c => layers.push(subdir + c));

    // Mouth — derived from (mood, mouthStyle). Default style means the plain
    // <mood>.png (happy.png, sad.png, ...); a styled mouth uses <style><Cap>.png.
    if (isCharOk) {
      const mood = (frame.mood || "happy");
      const moodCap = mood.charAt(0).toUpperCase() + mood.slice(1);
      const mouthFile = frame.mouthStyle ? (frame.mouthStyle + moodCap + ".png") : (mood + ".png");
      const mouthSubdir = isBig ? "Big/Mouths/" : "Small/Mouths/";
      layers.push(mouthSubdir + mouthFile);
    }

    // Mustache sits above the mouth, below the eyes — and is mood-aware.
    if (frame.mustache && isCharOk) {
      const mood = (frame.mood || "happy");
      const moodCap = mood.charAt(0).toUpperCase() + mood.slice(1);
      const mustacheSubdir = isBig ? "Big/Mouths/" : "Small/Mouths/";
      layers.push(mustacheSubdir + frame.mustache + moodCap + ".png");
    }

    // Eyes sit on the face above the mustache, matching the HabitBeast order.
    // The blink renderer drives the eye state; static previews composite "open.png".
    if (isCharOk && EYE_FOLDER[frame.monster]) {
      const eyeSubdir = isBig ? "Big/Eyes/" : "Small/Eyes/";
      layers.push(eyeSubdir + EYE_FOLDER[frame.monster] + "/open.png");
    }

    // Cape Top drapes over the chest + body — render it above the eyes block,
    // ABOVE the chest clothing (which is now below the face).
    if (frame.cape && isCharOk) {
      layers.push(subdir + "Paired/" + frame.cape + "Top.png");
    }

    // Beard renders ABOVE cape top so beards drape over the cape collar.
    pickSlot("beard").forEach(c => layers.push(subdir + c));

    // Hat + "other" render at the top of the stack so they cover everything
    // (including cape collars + beards). Pants/shoes/chest were drawn before
    // the face above, so only the top-of-stack items remain here.
    pickSlot("hat").forEach(c => layers.push(subdir + c));
    allClothing
      .filter(c => {
        const s = clothingSlot(c);
        return s !== "pants" && s !== "shoes" && s !== "chest" && s !== "hat" && s !== "beard";
      })
      .forEach(c => layers.push(subdir + c));
    return layers;
  }

  function buildLayerList() { return buildLayerListFor(cur()); }
  function buildServerLayers() { return buildLayerListFor(state.frames[0]); }
  function buildServerLastFrameLayers() {
    return frameIsEmpty(state.frames[1]) ? null : buildLayerListFor(state.frames[1]);
  }

  function updateSummary() {
    const parts = [];
    const f = cur();
    if (f.background) parts.push(\`<span>BG:</span> \${f.background.replace(".png","")}\`);
    if (f.monster) parts.push(\`<span>Character:</span> \${f.monster}\`);
    if (f.mouth) parts.push(\`<span>Mouth:</span> \${f.mouth.replace(".png","")} <span style="color:#777;font-size:10px;">(drives mood + blink)</span>\`);
    if (f.clothing.length) parts.push(\`<span>Clothing:</span> \${f.clothing.map(c=>c.replace(".png","")).join(", ")}\`);
    if (f.bottom) parts.push(\`<span>Bottom:</span> \${f.bottom.replace(".png","")}\`);
    document.getElementById("summary").innerHTML = parts.length ? parts.join("<br>") : "Nothing selected yet.";
    updateBlinkReadouts();
  }

  // Mood + bg readouts shown in Blink mode — kept in sync with the active frame.
  // Mood is now an explicit field on the frame (set by the Expression picker).
  function deriveMood(f) {
    const m = (f.mood || "happy").toString().toLowerCase();
    return ["happy","okay","excited","sad","upset"].includes(m) ? m : "happy";
  }
  const MOOD_HINTS = {
    happy:   "normal blink rate, even open/partial",
    okay:    "normal blink rate, even open/partial",
    excited: "wide-eyed most of the time, brief partial flicks",
    sad:     "heavy-lidded, infrequent blinks",
    upset:   "heavy-lidded, infrequent blinks",
  };
  function updateBlinkReadouts() {
    const f = cur();
    const mood = deriveMood(f);
    const readout = document.getElementById("blinkMoodReadout");
    if (readout) {
      readout.innerHTML = mood +
        ' <span style="color:#555;font-weight:400;text-transform:none;letter-spacing:0;">— ' +
        MOOD_HINTS[mood] + '</span>';
    }
    // Background readout — flat colors and image backgrounds both work.
    const bgLabel  = document.getElementById("blinkBgLabel");
    const swatch   = document.getElementById("blinkBgSwatch");
    if (bgLabel && swatch) {
      const bg = f.background;
      if (bg && bg.startsWith("flat:")) {
        const hex = bg.slice("flat:".length);
        swatch.style.background = hex;
        bgLabel.textContent = hex.toUpperCase();
      } else if (bg) {
        swatch.style.background = "#1a1a24";
        bgLabel.textContent = bg.replace(/^Background\//i, "").replace(".png", "");
      } else {
        swatch.style.background = "#1a1a24";
        bgLabel.textContent = "#1a1a24 — pick a color or image backdrop";
      }
    }
  }

  function blinkPayload() {
    const f = state.frames[0];
    const mood = deriveMood(f);
    const isFlat = f.background && f.background.startsWith("flat:");
    const bgColor = isFlat ? f.background.slice("flat:".length) : "#1a1a24";
    const backgroundImage = (!isFlat && f.background) ? f.background : null;
    // f.clothing is already raw filenames (e.g. "redCowboyHat.png").
    // blink.ts joins them under habitBeast/public/{Big|Small}/ based on the monster.
    const clothing = (f.clothing || []).slice();
    return {
      monster: f.monster,
      mood,
      bgColor,
      backgroundImage,
      clothing,
      bottom: f.bottom || null,
      cape:   f.cape   || null,
      mustache:   f.mustache   || null,
      mouthStyle: f.mouthStyle || null,
      durationSec: parseInt(document.getElementById("blinkDuration").value, 10) || 8,
      aspectRatio: document.getElementById("aspectRatio").value,
    };
  }

  // ── Brady Bunch grid bin ──────────────────────────────────────
  // 8 cells laid out in a 3×3 with the center reserved for a title card:
  //   [0] [1] [2]
  //   [3] T   [4]
  //   [5] [6] [7]
  // Each cell stores a snapshot of the composer state (monster, mood, bgColor,
  // clothing, bottom). Snapshots are independent of the live composer — once a
  // cell is captured, the user can rebuild a different monster for the next slot.
  const BRADY_LAYOUT = [
    [0, 1, 2],
    [3, "title", 4],
    [5, 6, 7],
  ];
  // bradyCells[i] = { monster, mood, bgColor, clothing[], bottom } | null
  const bradyCells = new Array(8).fill(null);

  function snapshotCellFromActive() {
    const p = blinkPayload();
    if (!p.monster) return null;
    return {
      monster: p.monster,
      mood: p.mood,
      bgColor: p.bgColor,
      clothing: (p.clothing || []).slice(),
      bottom: p.bottom || null,
      cape:   p.cape   || null,
      mustache:   p.mustache   || null,
      mouthStyle: p.mouthStyle || null,
    };
  }

  function nextEmptyCellIdx() {
    return bradyCells.findIndex(c => c === null);
  }

  function setBradyCell(idx, cell) {
    if (idx < 0 || idx > 7) return;
    bradyCells[idx] = cell;
    renderBradyGrid();
  }

  function clearBradyCell(idx) {
    if (idx < 0 || idx > 7) return;
    bradyCells[idx] = null;
    renderBradyGrid();
  }

  function renderBradyGrid() {
    const grid = document.getElementById("bradyGrid");
    if (!grid) return;
    grid.innerHTML = "";
    BRADY_LAYOUT.flat().forEach(slot => {
      const tile = document.createElement("div");
      tile.style.cssText = "aspect-ratio:1/1;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:10px;text-align:center;cursor:pointer;border:1px dashed #2a2a3a;background:#0a0a10;color:#444;position:relative;overflow:hidden;";
      if (slot === "title") {
        const titleText = (document.getElementById("bradyTitleText")?.value || "HabitBeast").trim() || "HabitBeast";
        tile.style.cursor = "default";
        tile.style.borderStyle = "solid";
        tile.style.background = "#1a1a24";
        tile.style.color = "#a78bfa";
        tile.style.fontWeight = "700";
        tile.style.borderColor = "#2a2a3a";
        tile.innerHTML = '<div style="font-size:9px;letter-spacing:.5px;">' + escapeHtml(titleText) + '</div><div style="font-size:8px;color:#555;font-weight:400;margin-top:2px;">title card</div>';
        grid.appendChild(tile);
        return;
      }
      const idx = slot;
      const cell = bradyCells[idx];
      if (cell) {
        // Filled — show monster name + mood + colored bg, clicking clears it
        tile.style.borderStyle = "solid";
        tile.style.borderColor = "#a78bfa";
        tile.style.background = cell.bgColor || "#1a1a24";
        tile.title = "Click to clear slot " + (idx + 1);
        // Pick a readable text color based on bg luminance
        const c = (cell.bgColor || "#1a1a24").replace("#","");
        const r = parseInt(c.substring(0,2),16), g = parseInt(c.substring(2,4),16), b = parseInt(c.substring(4,6),16);
        const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
        const fg = lum > 0.55 ? "#111" : "#fff";
        tile.innerHTML =
          '<div style="font-size:10px;font-weight:700;color:' + fg + ';text-transform:capitalize;">' + escapeHtml(cell.monster) + '</div>' +
          '<div style="font-size:9px;color:' + fg + ';opacity:.75;text-transform:lowercase;">' + escapeHtml(cell.mood) + '</div>' +
          '<div style="position:absolute;top:2px;right:4px;font-size:8px;color:' + fg + ';opacity:.6;">' + (idx + 1) + '</div>';
        tile.addEventListener("click", () => clearBradyCell(idx));
      } else {
        // Empty — clicking captures the current composer state into this slot
        tile.title = "Click to capture current composition into slot " + (idx + 1);
        tile.innerHTML = '<div style="font-size:18px;color:#333;">+</div><div style="font-size:8px;color:#444;margin-top:2px;">slot ' + (idx + 1) + '</div>';
        tile.addEventListener("click", () => {
          const cell = snapshotCellFromActive();
          if (!cell) {
            const status = document.getElementById("status");
            status.className = "status error";
            status.textContent = "❌ Pick a monster (and ideally a mouth) before adding to the grid.";
            return;
          }
          setBradyCell(idx, cell);
          const status = document.getElementById("status");
          status.className = "status success";
          status.textContent = \`✅ Slot \${idx + 1}: \${cell.monster} (\${cell.mood})\`;
        });
      }
      grid.appendChild(tile);
    });

    // Update count + compose-button state
    const filled = bradyCells.filter(c => c !== null).length;
    const countEl = document.getElementById("bradyCount");
    if (countEl) countEl.textContent = \`(\${filled} / 8 cells)\`;
    const composeBtn = document.getElementById("bradyComposeBtn");
    if (composeBtn) {
      const ready = filled === 8;
      composeBtn.disabled = !ready;
      composeBtn.style.opacity = ready ? "1" : ".5";
      composeBtn.style.cursor = ready ? "pointer" : "not-allowed";
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => (
      { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]
    ));
  }

  async function composeBradyBunch() {
    const filled = bradyCells.filter(c => c !== null);
    if (filled.length !== 8) return;
    const status = document.getElementById("status");
    const btn = document.getElementById("bradyComposeBtn");
    btn.disabled = true;
    btn.style.opacity = ".5";
    status.className = "status";
    status.textContent = "⏳ Compositing 3×3 Brady Bunch (rendering 8 cells + title)...";
    const titleText = document.getElementById("bradyTitleText").value.trim();
    const titleSubtext = document.getElementById("bradyTitleSub").value.trim();
    const dur = parseInt(document.getElementById("blinkDuration").value, 10) || 8;
    try {
      const res = await fetch("/api/blink-grid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cells: bradyCells,
          titleText: titleText || undefined,
          titleSubtext: titleSubtext || undefined,
          durationSec: dur,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "compose failed");
      status.className = "status success";
      status.textContent = "✅ Brady Bunch ready! " + data.file;
      // Show the result in the main video preview (no approve bar — it's already saved)
      showVideoPreview(data.file, "/videos/");
    } catch (e) {
      status.className = "status error";
      status.textContent = "❌ " + e.message;
    } finally {
      renderBradyGrid();
    }
  }

  // ── Lineup Pan grid bin ────────────────────────────────────────
  // 8 cells in left-to-right camera-path order. Each cell is a snapshot of the
  // composer state, same shape as Brady Bunch cells.
  const lineupCells = new Array(8).fill(null);

  function nextEmptyLineupIdx() {
    return lineupCells.findIndex(c => c === null);
  }

  function setLineupCell(idx, cell) {
    if (idx < 0 || idx > 7) return;
    lineupCells[idx] = cell;
    renderLineupBin();
  }

  function clearLineupCell(idx) {
    if (idx < 0 || idx > 7) return;
    lineupCells[idx] = null;
    renderLineupBin();
  }

  function renderLineupBin() {
    const bin = document.getElementById("lineupBin");
    if (!bin) return;
    bin.innerHTML = "";
    for (let idx = 0; idx < 8; idx++) {
      const tile = document.createElement("div");
      tile.style.cssText = "flex:1;aspect-ratio:1/1;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:9px;text-align:center;cursor:pointer;border:1px dashed #2a2a3a;background:#0a0a10;color:#444;position:relative;overflow:hidden;";
      const cell = lineupCells[idx];
      if (cell) {
        tile.style.borderStyle = "solid";
        tile.style.borderColor = "#86efac";
        tile.style.background = cell.bgColor || "#1a1a24";
        tile.title = "Click to clear cell " + (idx + 1);
        const c = (cell.bgColor || "#1a1a24").replace("#","");
        const r = parseInt(c.substring(0,2),16), g = parseInt(c.substring(2,4),16), b = parseInt(c.substring(4,6),16);
        const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
        const fg = lum > 0.55 ? "#111" : "#fff";
        tile.innerHTML =
          '<div style="font-size:9px;font-weight:700;color:' + fg + ';text-transform:capitalize;">' + escapeHtml(cell.monster) + '</div>' +
          '<div style="font-size:8px;color:' + fg + ';opacity:.75;text-transform:lowercase;">' + escapeHtml(cell.mood) + '</div>' +
          '<div style="position:absolute;top:2px;right:4px;font-size:8px;color:' + fg + ';opacity:.6;">' + (idx + 1) + '</div>';
        tile.addEventListener("click", () => clearLineupCell(idx));
      } else {
        tile.title = "Click to capture current composition into cell " + (idx + 1);
        tile.innerHTML = '<div style="font-size:14px;color:#333;">+</div><div style="font-size:8px;color:#444;margin-top:1px;">' + (idx + 1) + '</div>';
        tile.addEventListener("click", () => {
          const cell = snapshotCellFromActive();
          if (!cell) {
            const status = document.getElementById("status");
            status.className = "status error";
            status.textContent = "❌ Pick a monster (and ideally a mouth) before adding to the lineup.";
            return;
          }
          setLineupCell(idx, cell);
          const status = document.getElementById("status");
          status.className = "status success";
          status.textContent = \`✅ Lineup cell \${idx + 1}: \${cell.monster} (\${cell.mood})\`;
        });
      }
      bin.appendChild(tile);
    }
    const filled = lineupCells.filter(c => c !== null).length;
    const countEl = document.getElementById("lineupCount");
    if (countEl) countEl.textContent = \`(\${filled} / 8 cells)\`;
    const composeBtn = document.getElementById("lineupComposeBtn");
    if (composeBtn) {
      const ready = filled === 8;
      composeBtn.disabled = !ready;
      composeBtn.style.opacity = ready ? "1" : ".5";
      composeBtn.style.cursor = ready ? "pointer" : "not-allowed";
    }
  }

  async function composeLineupPan() {
    const filled = lineupCells.filter(c => c !== null);
    if (filled.length !== 8) return;
    const status = document.getElementById("status");
    const btn = document.getElementById("lineupComposeBtn");
    btn.disabled = true;
    btn.style.opacity = ".5";
    status.className = "status";
    status.textContent = "⏳ Rendering Lineup Pan (8 cells + camera move)...";
    try {
      const res = await fetch("/api/blink-lineup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells: lineupCells }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "compose failed");
      status.className = "status success";
      status.textContent = "✅ Lineup Pan ready! " + data.file;
      showVideoPreview(data.file, "/videos/");
    } catch (e) {
      status.className = "status error";
      status.textContent = "❌ " + e.message;
    } finally {
      renderLineupBin();
    }
  }

  // ── Fart sequence trigger ─────────────────────────────────────
  // Renders the full HabitBeast fart choreography on the active monster.
  async function renderFartFromActive() {
    const status = document.getElementById("status");
    const f = state.frames[0];
    if (!f.monster || f.monster === "lab-assistant") {
      status.className = "status error";
      status.textContent = "❌ Pick one of the 8 standard monsters first (Lab Assistant has no fart).";
      return;
    }
    const isFlat = f.background && f.background.startsWith("flat:");
    const bgColor = isFlat ? f.background.slice("flat:".length) : "#1a1a24";
    const backgroundImage = (!isFlat && f.background) ? f.background : null;
    const payload = {
      monster: f.monster,
      bgColor,
      backgroundImage,
      clothing: (f.clothing || []).slice(),
      bottom: f.bottom || null,
      cape:   f.cape   || null,
      mustache:   f.mustache   || null,
      mouthStyle: f.mouthStyle || null,
      aspectRatio: document.getElementById("aspectRatio").value,
    };
    const btn = document.getElementById("fartBtn");
    btn.disabled = true;
    status.className = "status";
    status.textContent = "⏳ Rendering fart sequence (~7s)...";
    try {
      const res = await fetch("/api/blink-fart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "fart render failed");
      status.className = "status success";
      status.textContent = "✅ Fart sequence ready! " + data.file;
      showVideoPreview(data.file, "/videos/");
    } catch (e) {
      status.className = "status error";
      status.textContent = "❌ " + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function updateGenerateBtn() {
    const btn = document.getElementById("generateBtn");
    const f = state.frames[0];
    if (currentMode === "blink") {
      // Blink only knows the 8 standard monsters — Lab Assistant has no eye sprites.
      const ok = !!f.monster && f.monster !== "lab-assistant";
      btn.disabled = !ok;
      btn.textContent = ok ? \`🔁 Render Blink Loop (\${blinkPayload().durationSec}s)\` : "Pick a monster to render";
    } else {
      // Veo mode: must have at least a start-frame character selected.
      btn.disabled = !f.monster;
      btn.textContent = "Generate Video";
    }
  }

  // Confirm modal wiring
  document.getElementById("confirmNo").addEventListener("click", () => {
    document.getElementById("confirmModal").classList.remove("open");
  });

  async function doGenerate() {
    const btn = document.getElementById("generateBtn");
    const status = document.getElementById("status");
    btn.disabled = true;
    status.className = "status";

    if (currentMode === "blink") {
      // Local sprite-swap renderer — no Veo, no money on fire
      const payload = blinkPayload();
      // Snapshot the cell config now so "Add to Grid" later commits exactly what
      // the user previewed, not whatever the composer happens to look like at click time.
      pendingCellSnapshot = {
        monster: payload.monster,
        mood: payload.mood,
        bgColor: payload.bgColor,
        clothing: (payload.clothing || []).slice(),
        bottom: payload.bottom || null,
      };
      status.textContent = \`⏳ Rendering \${payload.durationSec}s blink loop locally...\`;
      try {
        const res = await fetch("/api/blink", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.success) {
          status.className = "status success";
          status.textContent = "✅ Done! " + data.file;
          showPendingVideo(data.file);
        } else {
          throw new Error(data.error);
        }
      } catch(e) {
        status.className = "status error";
        status.textContent = "❌ " + e.message;
        pendingCellSnapshot = null;
      }
      btn.disabled = false;
      return;
    }

    // Veo mode (still available programmatically; the top-bar pill currently exposes
    // blink + splice only)
    status.textContent = "⏳ Submitting to Veo...";

    const layers = buildServerLayers();
    const lastFrameLayers = buildServerLastFrameLayers();
    const style = document.getElementById("styleSelect").value;
    const behavior = document.getElementById("behavior").value;
    const overlayText = document.getElementById("overlayText").value;
    const subText = document.getElementById("subText").value;
    const aspectRatio = document.getElementById("aspectRatio").value;

    try {
      status.textContent = lastFrameLayers
        ? "⏳ Generating before/after transition... this takes ~2 min"
        : "⏳ Generating... this takes ~2 min";
      startCostMeter();
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layers, lastFrameLayers, style, behavior, overlayText, subText, aspectRatio, textMode }),
      });
      const data = await res.json();
      stopCostMeter(data.cost, data.todayCost, data.totalCost);
      if (data.success) {
        status.className = "status success";
        status.textContent = data.textSkipped
          ? "✅ Done! (text skipped — ffmpeg not installed) " + data.file
          : "✅ Done! " + data.file;
        showPendingVideo(data.file);
      } else {
        throw new Error(data.error);
      }
    } catch(e) {
      clearInterval(costInterval);
      document.getElementById("costMeter").style.display = "none";
      status.className = "status error";
      status.textContent = "❌ " + e.message;
    }

    btn.disabled = false;
  }

  document.getElementById("generateBtn").addEventListener("click", () => {
    // Blink renders locally and is essentially free — skip the "are you sure / $$$"
    // prompt entirely so iteration feels instant.
    if (currentMode === "blink") {
      doGenerate();
      return;
    }
    // Veo mode keeps the cost-confirmation modal
    const title = document.getElementById("confirmTitle");
    const body  = document.getElementById("confirmBody");
    if (title) title.textContent = "🎬 Ready to Generate?";
    if (body)  body.innerHTML = "Is the model set up and ready?<br>This costs ~$2.80 for an 8-second clip.";
    document.getElementById("confirmModal").classList.add("open");
  });

  // Duration slider — keeps the readout + the generate button label live
  const blinkDurationEl = document.getElementById("blinkDuration");
  const blinkDurReadoutEl = document.getElementById("blinkDurReadout");
  if (blinkDurationEl && blinkDurReadoutEl) {
    blinkDurationEl.addEventListener("input", () => {
      blinkDurReadoutEl.textContent = blinkDurationEl.value + "s";
      updateGenerateBtn();
    });
  }

  // Frame control buttons
  document.getElementById("copyFrameBtn").addEventListener("click", () => {
    copyActiveToOther();
  });
  document.getElementById("clearEndBtn").addEventListener("click", () => {
    clearFrame(1);
    if (state.activeFrame === 1) setActiveFrame(0);
  });

  document.getElementById("confirmYes").addEventListener("click", () => {
    document.getElementById("confirmModal").classList.remove("open");
    doGenerate();
  });

  // Redraw canvas when text changes
  document.getElementById("overlayText").addEventListener("input", drawAllCanvases);
  document.getElementById("subText").addEventListener("input", drawAllCanvases);

  // Text mode toggle
  let textMode = "veo";
  document.querySelectorAll(".text-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      textMode = btn.dataset.mode;
      document.querySelectorAll(".text-mode-btn").forEach(b => {
        const active = b.dataset.mode === textMode;
        b.style.borderColor = active ? "#a78bfa" : "#2a2a3a";
        b.style.color = active ? "#a78bfa" : "#555";
      });
      const hints = {
        veo:  "Veo renders text dynamically in the scene — more cinematic, less predictable.",
        both: "Title goes to Veo (dynamic). Subtitle is burned in after — guaranteed to show.",
        burn: "Both title and subtitle burned onto the video — precise placement, always visible.",
      };
      document.getElementById("textModeHint").textContent = hints[textMode];
      drawAllCanvases();
    });
  });

  // Track the current pending filename across approve/reject/append steps
  let pendingFile = null;
  // Snapshot of the cell config used for the current pending blink preview, captured
  // at render time. This is what gets added to the Brady Bunch grid on "Approve" so
  // the grid cell matches the preview exactly even if the composer changes after.
  let pendingCellSnapshot = null;

  function showVideoPreview(filename, srcPrefix = "/videos/") {
    const video     = document.getElementById("videoPreview");
    const canvasRow = document.getElementById("canvasRow");
    const controls  = document.getElementById("frameControls");
    const label     = document.getElementById("centerLabel");
    video.src = srcPrefix + filename + "?t=" + Date.now();
    video.classList.add("visible");
    canvasRow.style.display = "none";
    controls.style.display = "none";
    label.innerHTML = filename + ' &nbsp;<a href="#" style="color:#a78bfa;font-size:11px" onclick="showComposer();return false">← back to composer</a>';
    video.load();
    video.play().catch(() => {});
  }

  function showPendingVideo(filename) {
    pendingFile = filename;
    showVideoPreview(filename, "/videos/");
    document.getElementById("approveBar").classList.add("visible");
    document.getElementById("screenshotPanel").classList.remove("visible");
  }

  function showComposer() {
    const video     = document.getElementById("videoPreview");
    const canvasRow = document.getElementById("canvasRow");
    const label     = document.getElementById("centerLabel");
    video.classList.remove("visible");
    video.src = "";
    canvasRow.style.display = "";
    label.textContent = currentMode === "blink"
      ? "Pick a monster + mouth — render a blink loop, then approve to add it to the grid"
      : "Click a canvas to make it active · End frame optional";
    document.getElementById("approveBar").classList.remove("visible");
    document.getElementById("screenshotPanel").classList.remove("visible");
    pendingFile = null;
    pendingCellSnapshot = null;
    // Re-apply mode-specific display rules (frameControls / veo-only / blink-only)
    // so they survive the show-video → show-composer round trip cleanly.
    setMode(currentMode);
    // Make sure the generate button is enabled and reflects the current selection.
    const btn = document.getElementById("generateBtn");
    if (btn) btn.disabled = false;
    updateGenerateBtn();
    drawAllCanvases();
  }

  // ── Approve / Reject ──────────────────────────────────────────
  document.getElementById("approveBtn").addEventListener("click", async () => {
    if (!pendingFile) return;
    const approveBtn = document.getElementById("approveBtn");
    approveBtn.disabled = true;

    // ── Blink mode: "Approve" means "add this cell to the Brady Bunch grid".
    // The preview clip itself is throwaway (the grid composer re-renders all 8 cells
    // at 360×360), so we delete it via /api/reject to keep the Veo folder tidy and
    // return to the composer ready for the next slot.
    if (currentMode === "blink") {
      const idx = nextEmptyCellIdx();
      if (idx < 0) {
        const status = document.getElementById("status");
        status.className = "status error";
        status.textContent = "❌ Grid is full. Compose Brady Bunch or clear a slot first.";
        approveBtn.disabled = false;
        return;
      }
      // Prefer the snapshot captured at render time (matches the previewed clip).
      // Fall back to a fresh snapshot if it's somehow missing (shouldn't happen).
      const cell = pendingCellSnapshot || snapshotCellFromActive();
      if (!cell) {
        const status = document.getElementById("status");
        status.className = "status error";
        status.textContent = "❌ No active monster — pick one before approving.";
        approveBtn.disabled = false;
        return;
      }
      setBradyCell(idx, cell);
      // Throw away the preview file
      const vid = document.getElementById("videoPreview");
      vid.pause();
      vid.src = "";
      vid.load();
      try {
        await fetch("/api/reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: pendingFile }) });
      } catch {}
      const status = document.getElementById("status");
      status.className = "status success";
      status.textContent = \`✅ Slot \${idx + 1}: \${cell.monster} (\${cell.mood}) — preview discarded\`;
      showComposer();
      approveBtn.disabled = false;
      return;
    }

    // Veo mode: original behavior — save to GoodToGo
    const vid = document.getElementById("videoPreview");
    vid.pause();
    vid.src = "";
    vid.load();
    try {
      const res  = await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: pendingFile }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || JSON.stringify(data));
      // Video is now in GoodToGo — update the preview source
      showVideoPreview(pendingFile, "/goodtogo/");
      document.getElementById("approveBar").classList.remove("visible");
      await loadScreenshotPanel();
    } catch(e) {
      alert("Approve failed: " + e.message);
      approveBtn.disabled = false;
    }
  });

  document.getElementById("rejectBtn").addEventListener("click", async () => {
    if (!pendingFile) return;
    const rejectBtn = document.getElementById("rejectBtn");
    rejectBtn.disabled = true;
    const fileToReject = pendingFile;
    try {
      await fetch("/api/reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: fileToReject }) });
    } catch {}
    showComposer();
    rejectBtn.disabled = false;
  });

  // ── Brady Bunch grid bin wiring ───────────────────────────────
  document.getElementById("bradyComposeBtn").addEventListener("click", composeBradyBunch);
  document.getElementById("bradyClearBtn").addEventListener("click", () => {
    for (let i = 0; i < 8; i++) bradyCells[i] = null;
    renderBradyGrid();
  });
  document.getElementById("bradyTitleText").addEventListener("input", renderBradyGrid);

  // ── Lineup Pan bin wiring ─────────────────────────────────────
  document.getElementById("lineupComposeBtn").addEventListener("click", composeLineupPan);
  document.getElementById("lineupClearBtn").addEventListener("click", () => {
    for (let i = 0; i < 8; i++) lineupCells[i] = null;
    renderLineupBin();
  });
  renderLineupBin();

  // ── Fart button wiring ────────────────────────────────────────
  document.getElementById("fartBtn").addEventListener("click", renderFartFromActive);

  // ── Zoom style picker ─────────────────────────────────────────
  let selectedZoomStyle = "punch";
  document.getElementById("zoomStyleBtns").addEventListener("click", (e) => {
    const btn = e.target.closest(".zoom-style-btn");
    if (!btn) return;
    selectedZoomStyle = btn.dataset.style;
    document.querySelectorAll(".zoom-style-btn").forEach(b => {
      const active = b.dataset.style === selectedZoomStyle;
      b.style.borderColor = active ? "#a78bfa" : "#2a2a3a";
      b.style.color       = active ? "#a78bfa" : "#555";
    });
  });

  // ── Screenshot mode toggle ────────────────────────────────────
  let selectedScreenshotMode = "end";
  document.getElementById("screenshotPanel").addEventListener("click", (e) => {
    const btn = e.target.closest(".sc-mode-btn");
    if (!btn) return;
    selectedScreenshotMode = btn.dataset.mode;
    document.querySelectorAll(".sc-mode-btn").forEach(b => {
      const active = b.dataset.mode === selectedScreenshotMode;
      b.style.borderColor = active ? "#a78bfa" : "#2a2a3a";
      b.style.color       = active ? "#a78bfa" : "#555";
    });
    const appendBtn = document.getElementById("appendBtn");
    appendBtn.textContent = selectedScreenshotMode === "interspersed" ? "🔀 Intersperse" : "📍 Add to End";
  });

  // ── Intro state ───────────────────────────────────────────────
  let selectedIntroFile   = null;
  let selectedIntroSource = null; // "screenshot" | "goodtogo"

  // ── Screenshot panel ──────────────────────────────────────────
  let selectedScreenshots = [];

  async function loadScreenshotPanel() {
    const panel  = document.getElementById("screenshotPanel");
    const thumbs = document.getElementById("screenshotThumbs");
    const status = document.getElementById("screenshotStatus");
    selectedScreenshots = [];
    selectedIntroFile   = null;
    selectedIntroSource = null;
    thumbs.innerHTML = "";
    status.textContent = "";
    document.getElementById("introStatus").textContent = "";
    document.getElementById("introThumbs").innerHTML = "";

    // Load screenshot thumbnails (for both intro and screenshot sections)
    const [ssRes, gtRes] = await Promise.all([
      fetch("/api/screenshots"),
      fetch("/api/goodtogo"),
    ]);
    const ssData = await ssRes.json();
    const gtData = await gtRes.json();

    // ── Populate intro candidates ────────────────────────────────
    const introThumbs = document.getElementById("introThumbs");
    const introStatus = document.getElementById("introStatus");

    const hasIntroSources = ssData.screenshots?.length || gtData.files?.length;
    if (!hasIntroSources) {
      introStatus.textContent = "No intro sources found. Add images to Screenshots/ or approve a video first.";
      document.getElementById("introBtn").style.display = "none";
    } else {
      document.getElementById("introBtn").style.display = "";
      // Image thumbnails from Screenshots/
      (ssData.screenshots || []).forEach(f => {
        const div = document.createElement("div");
        div.className = "sc-thumb";
        div.dataset.file = f;
        div.dataset.source = "screenshot";
        div.innerHTML = \`<img src="/screenshots/\${f}" style="border:2px solid #2a2a3a;border-radius:6px;height:60px;width:auto;"><label style="font-size:9px;color:#555;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${f}</label>\`;
        div.addEventListener("click", () => selectIntro(f, "screenshot", div));
        introThumbs.appendChild(div);
      });
      // Video items from GoodToGo/
      (gtData.files || []).forEach(f => {
        const div = document.createElement("div");
        div.className = "sc-thumb";
        div.dataset.file = f;
        div.dataset.source = "goodtogo";
        div.innerHTML = \`<div style="height:60px;width:48px;background:#1e1e2a;border:2px solid #2a2a3a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;">🎬</div><label style="font-size:9px;color:#555;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${f}</label>\`;
        div.addEventListener("click", () => selectIntro(f, "goodtogo", div));
        introThumbs.appendChild(div);
      });
      introStatus.textContent = "Pick one item as intro. Images play for 4s, videos play in full.";
    }

    // ── Populate screenshot section ──────────────────────────────
    if (!ssData.screenshots?.length) {
      status.textContent = "No screenshots found in Screenshots/ folder.";
      document.getElementById("appendBtn").style.display = "none";
    } else {
      document.getElementById("appendBtn").style.display = "";
      selectedScreenshots = [...ssData.screenshots];
      ssData.screenshots.forEach(f => {
        const div = document.createElement("div");
        div.className = "sc-thumb selected";
        div.dataset.file = f;
        div.innerHTML = \`<img src="/screenshots/\${f}"><label>\${f}</label>\`;
        div.addEventListener("click", () => {
          const idx = selectedScreenshots.indexOf(f);
          if (idx === -1) { selectedScreenshots.push(f); div.classList.add("selected"); }
          else            { selectedScreenshots.splice(idx, 1); div.classList.remove("selected"); }
        });
        thumbs.appendChild(div);
      });
      status.textContent = "Click thumbnails to toggle. All selected by default.";
    }

    panel.classList.add("visible");
  }

  function selectIntro(file, source, el) {
    // Toggle off if already selected
    if (selectedIntroFile === file && selectedIntroSource === source) {
      selectedIntroFile   = null;
      selectedIntroSource = null;
      el.querySelector("img,div").style.borderColor = "#2a2a3a";
      return;
    }
    // Deselect previous
    document.querySelectorAll("#introThumbs .sc-thumb img, #introThumbs .sc-thumb div").forEach(img => {
      img.style.borderColor = "#2a2a3a";
    });
    selectedIntroFile   = file;
    selectedIntroSource = source;
    el.querySelector("img,div").style.borderColor = "#3b82f6";
  }

  document.getElementById("introBtn").addEventListener("click", async () => {
    if (!pendingFile || !selectedIntroFile) {
      document.getElementById("introStatus").textContent = "⚠️ Select an intro item first.";
      return;
    }
    const btn    = document.getElementById("introBtn");
    const status = document.getElementById("introStatus");
    btn.disabled = true;
    status.textContent = "⏳ Rendering intro…";
    try {
      const res  = await fetch("/api/prepend-intro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: pendingFile, introFile: selectedIntroFile, introSource: selectedIntroSource, transitionStyle: selectedZoomStyle }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      pendingFile = data.file;
      showVideoPreview(data.file, "/goodtogo/");
      status.textContent = "✅ Intro added → " + data.file;
      selectedIntroFile   = null;
      selectedIntroSource = null;
    } catch(e) {
      status.textContent = "❌ " + e.message;
    }
    btn.disabled = false;
  });

  document.getElementById("skipIntroBtn").addEventListener("click", () => {
    selectedIntroFile   = null;
    selectedIntroSource = null;
    document.getElementById("introStatus").textContent = "";
    document.querySelectorAll("#introThumbs .sc-thumb img, #introThumbs .sc-thumb div").forEach(img => {
      img.style.borderColor = "#2a2a3a";
    });
  });

  document.getElementById("appendBtn").addEventListener("click", async () => {
    if (!pendingFile || !selectedScreenshots.length) return;
    const btn    = document.getElementById("appendBtn");
    const status = document.getElementById("screenshotStatus");
    btn.disabled = true;
    const modeLabel = selectedScreenshotMode === "interspersed" ? "interspersing" : "appending";
    status.textContent = \`⏳ Rendering screenshot clips (\${modeLabel})… this may take a minute.\`;
    try {
      const res  = await fetch("/api/append-screenshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: pendingFile, screenshots: selectedScreenshots, transitionStyle: selectedZoomStyle, mode: selectedScreenshotMode }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      pendingFile = data.file;
      showVideoPreview(data.file, "/goodtogo/");
      document.getElementById("screenshotPanel").classList.remove("visible");
      document.getElementById("centerLabel").innerHTML =
        "✅ " + data.file + ' &nbsp;<a href="#" style="color:#a78bfa;font-size:11px" onclick="showComposer();return false">← back to composer</a>';
    } catch(e) {
      status.textContent = "❌ " + e.message;
      btn.disabled = false;
    }
  });

  document.getElementById("skipScreenshotsBtn").addEventListener("click", () => {
    document.getElementById("screenshotPanel").classList.remove("visible");
    document.getElementById("centerLabel").innerHTML =
      "✅ " + pendingFile + ' &nbsp;<a href="#" style="color:#a78bfa;font-size:11px" onclick="showComposer();return false">← back to composer</a>';
  });

  // ── GoodToGo library picker ────────────────────────────────────
  const libraryBtn    = document.getElementById("libraryBtn");
  const libraryPicker = document.getElementById("libraryPicker");
  const libraryList   = document.getElementById("libraryList");

  libraryBtn.addEventListener("click", async () => {
    // Toggle the picker
    if (libraryPicker.style.display !== "none") {
      libraryPicker.style.display = "none";
      libraryBtn.style.borderColor = "#2a2a3a";
      libraryBtn.style.color = "#666";
      return;
    }
    libraryList.innerHTML = '<div style="font-size:11px;color:#555;">Loading…</div>';
    libraryPicker.style.display = "block";
    libraryBtn.style.borderColor = "#a78bfa";
    libraryBtn.style.color = "#a78bfa";

    try {
      const res  = await fetch("/api/goodtogo");
      const data = await res.json();
      libraryList.innerHTML = "";
      if (!data.files?.length) {
        libraryList.innerHTML = '<div style="font-size:11px;color:#555;">No approved videos yet.</div>';
        return;
      }
      data.files.forEach(file => {
        const row = document.createElement("div");
        row.style.cssText = "padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;color:#a78bfa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .1s;";
        row.textContent = file;
        row.addEventListener("mouseenter", () => row.style.background = "#1e1e2a");
        row.addEventListener("mouseleave", () => row.style.background = "");
        row.addEventListener("click", async () => {
          // Jump straight into the screenshot workflow for this approved video
          pendingFile = file;
          libraryPicker.style.display = "none";
          libraryBtn.style.borderColor = "#2a2a3a";
          libraryBtn.style.color = "#666";
          showVideoPreview(file, "/goodtogo/");
          document.getElementById("approveBar").classList.remove("visible");
          await loadScreenshotPanel();
        });
        libraryList.appendChild(row);
      });
    } catch(e) {
      libraryList.innerHTML = '<div style="font-size:11px;color:#f87171;">Failed to load: ' + e.message + '</div>';
    }
  });

  // ── Cost tracking ──────────────────────────────────────────────
  let costPerSecond = 0.35;
  const DURATION = 8; // seconds — keep in sync with server default

  async function loadCostStats() {
    try {
      const r = await fetch("/api/costs");
      const d = await r.json();
      costPerSecond = d.costPerSecond || 0.35;
      const est = (DURATION * costPerSecond).toFixed(4);
      document.getElementById("estCost").textContent = \`$\${est}\`;
      document.getElementById("todayCostLive").textContent = \`$\${d.today?.toFixed(4) || "0.0000"}\`;
    } catch {}
  }
  loadCostStats();

  let costInterval = null;
  function startCostMeter() {
    const meter = document.getElementById("costMeter");
    const counter = document.getElementById("costCounter");
    meter.style.display = "block";
    document.getElementById("costSummary").style.display = "none";
    const start = Date.now();
    costInterval = setInterval(() => {
      const running = (elapsed * costPerSecond).toFixed(4);
      counter.textContent = "$" + running;
      const intensity = Math.min(elapsed / DURATION, 1);
      counter.style.color = "hsl(" + (0 + intensity * 20) + ", 90%, " + (60 - intensity * 15) + "%)";
    }, 100);
  }

  function stopCostMeter(cost, todayCost, totalCost) {
    clearInterval(costInterval);
    document.getElementById("costMeter").style.display = "none";
    const summary = document.getElementById("costSummary");
    document.getElementById("runCost").textContent       = "$" + (cost      != null ? cost.toFixed(4)      : "?");
    document.getElementById("todayCostFinal").textContent = "$" + (todayCost != null ? todayCost.toFixed(4) : "?");
    document.getElementById("totalCostFinal").textContent = "$" + (totalCost != null ? totalCost.toFixed(4) : "?");
    summary.style.display = "block";
  }

  const spliceState = { items: [] };
  let spliceUid = 1;
  let currentMode = "blink";

  function setMode(mode) {
    currentMode = mode;
    const isSplice = mode === "splice";
    const isBlink  = mode === "blink";
    const isVeo    = mode === "veo";
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    document.querySelector(".right-panel").style.display = isSplice ? "none" : "";
    const spliceArea = document.getElementById("spliceArea");
    if (spliceArea) spliceArea.classList.toggle("visible", isSplice);
    document.querySelectorAll(".add-to-splice-btn").forEach(b => b.style.display = isSplice ? "" : "none");
    document.querySelectorAll(".veo-only").forEach(el => { el.style.display = isVeo ? "" : "none"; });
    document.querySelectorAll(".blink-only").forEach(el => { el.style.display = isBlink ? "" : "none"; });
    const endFrame = document.querySelector('.frame-slot[data-frame="1"]');
    if (endFrame) endFrame.style.display = isVeo ? "" : "none";
    const frameControls = document.getElementById("frameControls");
    if (frameControls) frameControls.style.display = isVeo ? "" : "none";
    document.getElementById("headerHint").textContent = isSplice
      ? "Compose monsters then splice with screenshots and clips (no Veo cost)"
      : isBlink ? "Pick a monster and expression, render a blinking loop, add it to a grid"
      : "Select layers, compose, generate";
    const approveBtnEl = document.getElementById("approveBtn");
    const rejectBtnEl  = document.getElementById("rejectBtn");
    if (approveBtnEl) approveBtnEl.textContent = isBlink ? "Add to Grid" : "Approve";
    if (rejectBtnEl)  rejectBtnEl.textContent  = isBlink ? "Reject and Recompose" : "Reject";
    if (isSplice) loadSplicePickers();
    if (!isSplice) { updateBlinkReadouts(); updateGenerateBtn(); }
  }
  document.querySelectorAll(".mode-btn").forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

  async function loadSplicePickers() {
    const cGrid = document.getElementById("spliceComposedPicker");
    if (cGrid) cGrid.innerHTML = '<div style="color:#666;font-size:11px;padding:8px;">Splice picker source data unavailable. Use the Blink Loop, Brady Bunch, Lineup Pan, or Fart composers above.</div>';
    if (sGrid) sGrid.innerHTML = "";
    const vGrid = document.getElementById("spliceVideoPicker");
    if (vGrid) vGrid.innerHTML = "";
  }

  init();
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log("HabitBeast Veo Composer running at http://localhost:" + PORT);
});
