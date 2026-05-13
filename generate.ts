import { GoogleGenAI } from "@google/genai";
import { execSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";
import sharp from "sharp";

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "veo-2.0-generate-001";
const POLL_INTERVAL_MS = 10_000; // 10 seconds

// Path to monster images — update if your public folder moves
const MONSTERS_DIR = path.join(__dirname, "..", "habitBeast", "public");

// Path to app screenshots for end-card appending
const SCREENSHOTS_DIR = path.join(__dirname, "..", "habitBeast");

// Screenshots to append after every generated video.
// Populate this array to enable the feature; leave empty to skip.
// e.g. [path.join(SCREENSHOTS_DIR, "PlayStoreScreenshot1.png"), ...]
const DEFAULT_SCREENSHOTS: string[] = [];

// How many seconds each screenshot is held on screen
const SCREENSHOT_DURATION_SECONDS = 3;

if (!GEMINI_API_KEY) {
  console.error("❌  GEMINI_API_KEY environment variable is not set.");
  console.error("    PowerShell:  $env:GEMINI_API_KEY = 'your-key-here'");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------
interface VideoConfig {
  prompt: string;
  // Layers composited bottom-to-top before sending to Veo.
  // e.g. [background, monster, hat]
  layers?: string[];
  outputPath?: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  // App screenshots to append after the video. Overrides DEFAULT_SCREENSHOTS if set.
  screenshotPaths?: string[];
  // Seconds per screenshot (default: SCREENSHOT_DURATION_SECONDS)
  screenshotDuration?: number;
}

// ----------------------------------------------------------------
// Image helpers
// ----------------------------------------------------------------

// Composite multiple PNG layers (bottom to top) into a single base64 image.
// Layers can be different sizes — the canvas is set to the maximum width/height
// across all layers so nothing gets cropped (e.g. 600×600 background + 600×800 monster).
//   - Base (background) layer: scaled with "cover" so it fills the full canvas
//   - Overlay layers (sprites, accessories): scaled with "contain" + transparent padding
async function compositeLayers(layers: string[]): Promise<{ imageBytes: string; mimeType: string }> {
  if (layers.length === 0) throw new Error("No image layers provided.");

  for (const l of layers) {
    if (!fs.existsSync(l)) throw new Error(`Layer not found: ${l}`);
  }

  // Determine canvas size from the largest dimensions across all layers
  const metas = await Promise.all(layers.map((l) => sharp(l).metadata()));
  const targetW = Math.max(...metas.map((m) => m.width  ?? 0));
  const targetH = Math.max(...metas.map((m) => m.height ?? 0));

  // Resize one layer to the target canvas:
  //   isBase=true  → "cover"   (background fills the frame, may crop edges slightly)
  //   isBase=false → "contain" (sprite preserved exactly, transparent padding added)
  const resizeLayer = (filePath: string, isBase: boolean): Promise<Buffer> =>
    sharp(filePath)
      .resize(targetW, targetH, {
        fit: isBase ? "cover" : "contain",
        background: isBase
          ? { r: 0, g: 0, b: 0, alpha: 255 }
          : { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

  // Start with the bottom (base) layer, composite the rest on top
  const [basePath, ...restPaths] = layers;
  const baseBuffer = await resizeLayer(basePath, true);
  let image = sharp(baseBuffer);

  if (restPaths.length > 0) {
    const overlays = await Promise.all(restPaths.map((l) => resizeLayer(l, false)));
    image = image.composite(overlays.map((buf) => ({ input: buf })));
  }

  const buffer = await image.png().toBuffer();
  return { imageBytes: buffer.toString("base64"), mimeType: "image/png" };
}

// Convenience: single image, no compositing
function loadImageAsBase64(filePath: string): { imageBytes: string; mimeType: string } {
  if (!fs.existsSync(filePath)) throw new Error(`Image not found: ${filePath}`);
  const imageBytes = fs.readFileSync(filePath).toString("base64");
  const mimeType = path.extname(filePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  return { imageBytes, mimeType };
}

// ----------------------------------------------------------------
// Core function
// ----------------------------------------------------------------
async function generateVideo(config: VideoConfig): Promise<void> {
  const {
    prompt,
    layers,
    outputPath = `habitbeast_${Date.now()}.mp4`,
    durationSeconds = 8,
    aspectRatio = "9:16",
  } = config;

  const requestConfig: Record<string, unknown> = {
    aspectRatio,
    numberOfVideos: 1,
    durationSeconds,
  };

  console.log(`🎬  Submitting to Veo (${MODEL})...`);
  console.log(`📝  Prompt: ${prompt}\n`);
  if (layers?.length) console.log(`🖼️   Compositing ${layers.length} layer(s)...\n`);

  // Build request — optionally composite and attach reference image
  const request: Parameters<typeof ai.models.generateVideos>[0] = {
    model: MODEL,
    prompt,
    config: requestConfig,
  };

  if (layers && layers.length > 0) {
    const { imageBytes, mimeType } = await compositeLayers(layers);
    request.image = { imageBytes, mimeType };
  }

  // Submit the generation request (returns a long-running operation)
  let operation = await ai.models.generateVideos(request);

  // Poll until done
  process.stdout.write("⏳  Generating");
  while (!operation.done) {
    await sleep(POLL_INTERVAL_MS);
    process.stdout.write(".");
    operation = await ai.operations.getVideosOperation({ operation });
  }
  console.log(" done!\n");

  if (operation.error) {
    throw new Error(`Generation failed: ${JSON.stringify(operation.error)}`);
  }

  const generatedVideos = operation.response?.generatedVideos;
  if (!generatedVideos || generatedVideos.length === 0) {
    throw new Error("No videos in response — check your quota or prompt.");
  }

  const videoUri: string | undefined = generatedVideos[0]?.video?.uri;
  if (!videoUri) {
    throw new Error("Video URI missing from response.");
  }

  console.log("💾  Downloading video...");
  const downloadUrl = `${videoUri}&key=${GEMINI_API_KEY}`;
  await downloadFile(downloadUrl, outputPath);

  console.log(`\n✅  Saved to: ${path.resolve(outputPath)}`);
  console.log(`🐉  Ready to share!`);

  // Append screenshots if configured
  const screenshots = config.screenshotPaths ?? DEFAULT_SCREENSHOTS;
  if (screenshots.length > 0) {
    const dur = config.screenshotDuration ?? SCREENSHOT_DURATION_SECONDS;
    await appendScreenshots(outputPath, screenshots, dur);
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const fetchUrl = (currentUrl: string) => {
      const client = currentUrl.startsWith("https") ? https : http;
      client
        .get(currentUrl, (response) => {
          // Follow redirects (301, 302, 303, 307, 308)
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            fetchUrl(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
    };

    fetchUrl(url);
  });
}

// ----------------------------------------------------------------
// Screenshot append
// ----------------------------------------------------------------

// Appends one static-image clip per screenshot to the end of a video using ffmpeg.
// Each screenshot is held for `durationPerShot` seconds, scaled/padded to match
// the video's dimensions (black bars added if aspect ratios differ).
async function appendScreenshots(
  videoPath: string,
  screenshotPaths: string[],
  durationPerShot: number,
): Promise<void> {
  // Verify ffmpeg is available
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    console.warn("\n⚠️  ffmpeg not found — skipping screenshot append.");
    console.warn("    Install ffmpeg (https://ffmpeg.org) and make sure it's on your PATH.");
    return;
  }

  const missing = screenshotPaths.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.warn(`\n⚠️  Screenshot(s) not found — skipping append:\n  ${missing.join("\n  ")}`);
    return;
  }

  console.log(`\n📱  Appending ${screenshotPaths.length} screenshot(s) (${durationPerShot}s each)...`);

  // Probe the Veo video for its dimensions so screenshots scale to match
  let vW = 720, vH = 1280; // 9:16 fallback
  try {
    const probe = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const [w, h] = probe.split(",").map(Number);
    if (w && h) { vW = w; vH = h; }
  } catch { /* use portrait defaults */ }

  const tmpDir = path.dirname(videoPath);
  const clipPaths: string[] = [];

  // Turn each screenshot into a short video clip at the target resolution
  for (let i = 0; i < screenshotPaths.length; i++) {
    const clipPath = path.join(tmpDir, `_sc_clip_${Date.now()}_${i}.mp4`);
    execSync(
      `ffmpeg -y -loop 1 -i "${screenshotPaths[i]}" ` +
      `-vf "scale=${vW}:${vH}:force_original_aspect_ratio=decrease,` +
      `pad=${vW}:${vH}:(ow-iw)/2:(oh-ih)/2:black" ` +
      `-c:v libx264 -t ${durationPerShot} -pix_fmt yuv420p -r 24 "${clipPath}"`,
      { stdio: "pipe" },
    );
    clipPaths.push(clipPath);
  }

  // Write the ffmpeg concat list (forward slashes work on both Win and Mac/Linux)
  const concatFile = path.join(tmpDir, `_concat_${Date.now()}.txt`);
  const concatContent = [videoPath, ...clipPaths]
    .map((p) => `file '${p.replace(/\\/g, "/")}'`)
    .join("\n");
  fs.writeFileSync(concatFile, concatContent, "utf-8");

  // Concatenate: re-encode to ensure codec compatibility with the Veo clip
  const finalPath = videoPath.replace(/\.mp4$/, "_with_screenshots.mp4");
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v libx264 -crf 18 -pix_fmt yuv420p "${finalPath}"`,
    { stdio: "pipe" },
  );

  // Clean up temp files
  for (const p of [...clipPaths, concatFile]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  console.log(`✅  Saved with screenshots → ${path.resolve(finalPath)}`);
}

// ----------------------------------------------------------------
// Monster showcase presets (image-based, portrait 9:16)
// Prompts describe BEHAVIOR only — let Veo read appearance from the image.
// Layers are composited bottom-to-top before sending.
// ----------------------------------------------------------------
const P = MONSTERS_DIR; // shorthand

// ----------------------------------------------------------------
// Size-based monster grouping
//
// Clothing and mouth layers are pre-positioned on a 600×800 canvas,
// sized differently for Big vs Small monsters.
//   Big   → Frank, Wolf, Murk, Biggs
//   Small → Iggs, Entsy, Wrapps, Stumbles
// ----------------------------------------------------------------
const BIG_MONSTERS   = ["frank", "wolf", "murk", "biggs"] as const;
const SMALL_MONSTERS = ["stumbles", "iggs", "wrapps", "entsy"] as const;
type BigMonster   = typeof BIG_MONSTERS[number];
type SmallMonster = typeof SMALL_MONSTERS[number];
type Monster      = BigMonster | SmallMonster;

// ----------------------------------------------------------------
// Dynamic asset loaders
//
// Drop a new PNG into public/Big, public/Small, public/Bottom,
// public/Big/Mouths, or public/Small/Mouths and it's picked up automatically.
//
// Layout:
//   Big/*.png                    → clothing for big monsters
//   Big/Mouths/*.png             → mouth layers for big monsters (excited, happy, okay, sad, upset)
//   Big/Eyes/{Monster}/*.png     → eye layers for big monsters, three states (open, partial, closed)
//   Small/*.png                  → clothing for small monsters
//   Small/Mouths/*.png           → mouth layers for small monsters
//   Small/Eyes/{Monster}/*.png   → eye layers for small monsters, three states (open, partial, closed)
//   Bottom/*.png                 → accessories below the monster (e.g. skateboard) — add
//                                    BEFORE the monster in the layers array so the monster stands on top
//
// Layer order convention (bottom → top):
//   [background, Bottom/*, monster.png, Mouths/*, Eyes/*, clothing/*]
//
// Example layer stack:
//   [CLOTHING.Bottom.blueSkateboard, P/frank.png, mouthFor("frank"), eyesFor("frank"), CLOTHING.Big.redCowboyHat]
// ----------------------------------------------------------------
function listPngs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
}

// Returns { "baseballCap": "<absolute path>", ... } for every .png in the subdir
function loadLayerMap(...subdirs: string[]): Record<string, string> {
  const dir = path.join(P, ...subdirs);
  const map: Record<string, string> = {};
  for (const f of listPngs(dir)) {
    map[f.replace(/\.png$/, "")] = path.join(dir, f);
  }
  return map;
}

const CLOTHING = {
  Big:    loadLayerMap("Big"),
  Small:  loadLayerMap("Small"),
  Bottom: loadLayerMap("Bottom"),
};

const MOUTHS = {
  Big:   loadLayerMap("Big",   "Mouths"),
  Small: loadLayerMap("Small", "Mouths"),
};

// Eye layers ship per-monster: Big|Small/Eyes/{PascalMonster}/{open|partial|closed}.png.
// Habit Beast animates blinks by swapping between these three states (driven by a state
// machine in MonsterAvatar). Veo composes static reference frames, so we default to "open"
// for showcase frames and rely on the behavior prompt (or a 2-frame transition in server.ts)
// to drive the actual blink in the generated video.
const EYE_FOLDER: Record<Monster, string> = {
  frank:    "Frank",
  wolf:     "Wolf",
  murk:     "Murk",
  biggs:    "Biggs",
  stumbles: "Stumbles",
  iggs:     "Iggs",
  wrapps:   "Wrapps",
  entsy:    "Entsy",
};

type EyeState = "open" | "partial" | "closed";

const EYES: { Big: Record<string, Record<EyeState, string>>; Small: Record<string, Record<EyeState, string>> } = {
  Big:   {},
  Small: {},
};
for (const m of BIG_MONSTERS) {
  EYES.Big[m] = {
    open:    path.join(P, "Big",   "Eyes", EYE_FOLDER[m], "open.png"),
    partial: path.join(P, "Big",   "Eyes", EYE_FOLDER[m], "partial.png"),
    closed:  path.join(P, "Big",   "Eyes", EYE_FOLDER[m], "closed.png"),
  };
}
for (const m of SMALL_MONSTERS) {
  EYES.Small[m] = {
    open:    path.join(P, "Small", "Eyes", EYE_FOLDER[m], "open.png"),
    partial: path.join(P, "Small", "Eyes", EYE_FOLDER[m], "partial.png"),
    closed:  path.join(P, "Small", "Eyes", EYE_FOLDER[m], "closed.png"),
  };
}

type Mood = "happy" | "okay" | "excited" | "sad" | "upset";

function sizeFor(monster: Monster): "Big" | "Small" {
  return (BIG_MONSTERS as readonly string[]).includes(monster) ? "Big" : "Small";
}

// Resolve the right mouth PNG for a monster + mood. Default mood: "happy".
// Monsters ship mouthless, so every image-based showcase should include a mouth layer.
function mouthFor(monster: Monster, mood: Mood = "happy"): string {
  const size = sizeFor(monster);
  const file = MOUTHS[size][mood];
  if (!file) throw new Error(`Mouth not found: ${size}/Mouths/${mood}.png`);
  return file;
}

// Resolve the right eye PNG for a monster + state. Default state: "open" (matches
// the resting pose Habit Beast displays between blinks). Use "partial" or "closed"
// for end-frame transitions when you want to bake a blink into the generated video.
function eyesFor(monster: Monster, state: EyeState = "open"): string {
  const size = sizeFor(monster);
  const set = EYES[size][monster];
  if (!set) throw new Error(`Eyes not found for monster: ${monster}`);
  const file = set[state];
  if (!fs.existsSync(file)) throw new Error(`Eye asset missing: ${file}`);
  return file;
}

// ----------------------------------------------------------------
// Styles — point STYLE at whichever one you want to test
// ----------------------------------------------------------------
const STYLE_SATURDAY_MORNING = `Saturday morning cartoon style, bouncy and charming. Bright colors, soft lighting.`;
const STYLE_DARK_GOTHIC       = `Dark, moody cartoon style. Rich shadows, slightly gothic atmosphere. Think Courage the Cowardly Dog meets Cartoon Network's darker era. Expressive characters, dramatic lighting.`;
const STYLE_RUBBER_HOSE       = `1930s rubber hose cartoon animation. Black and white with splashes of sickly green. Creepy but charming, bouncy movement.`;
const STYLE_GAME_CINEMATIC    = `Stylized 2D game cinematic. Dark fantasy palette, punchy contrast, cel-shaded. Dramatic but comedic.`;
const STYLE_MONSTER_MOVIE     = `Classic monster movie aesthetic rendered as 2D animation. Moody lighting, deep shadows, slight film grain. Comedic timing.`;
const STYLE_GRAPHIC_NOVEL     = `Flat 2D graphic novel style. Bold outlines, limited dark palette, dramatic shadow shapes.`;

// ✏️  Change this to swap styles across all showcases:
const STYLE = STYLE_GAME_CINEMATIC;

// Shorthand: monster body PNG
const monsterPng = (m: Monster) => path.join(P, `${m}.png`);

// Layer order for image-based showcases:
//   [Bottom (optional), monster body, mouth, eyes, clothing...]
// Mouth default is "happy" — swap in mouthFor(monster, "sad" | "upset" | ...) per preset to taste.
// Eyes default to "open" (matches Habit Beast's resting pose between blinks). The behavior
// prompt drives the actual blink in the generated video; for a guaranteed blink, build a
// 2-frame transition with eyesFor(m, "open") on frame 0 and eyesFor(m, "closed") on frame 1.
const SHOWCASES: Record<string, VideoConfig> = {
  // ---- Bare monsters ----
  "frank": {
    prompt: `Animate this character. He stands center frame. He yawns, his eyes blinking slowly a couple of times, scratches his belly, gives a slow sleepy wave. ${STYLE}`,
    layers: [monsterPng("frank"), mouthFor("frank"), eyesFor("frank")],
    outputPath: `showcase_frank_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "iggs": {
    prompt: `Animate this character. He stands center frame. His giant eye blinks slowly, goes wide with excitement, then droops sleepily. ${STYLE}`,
    layers: [monsterPng("iggs"), mouthFor("iggs"), eyesFor("iggs")],
    outputPath: `showcase_iggs_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "murk": {
    prompt: `Animate this character. He stands center frame. He sways slightly, blinks lazily, sniffs the air, gives a big dopey grin. ${STYLE}`,
    layers: [monsterPng("murk"), mouthFor("murk"), eyesFor("murk")],
    outputPath: `showcase_murk_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "stumbles": {
    prompt: `Animate this character. He stands center frame. He sways, almost falls over, blinks in surprise, catches himself, grins wider. ${STYLE}`,
    layers: [monsterPng("stumbles"), mouthFor("stumbles"), eyesFor("stumbles")],
    outputPath: `showcase_stumbles_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "wolf": {
    prompt: `Animate this character. He stands center frame. He pants, tongue flops side to side, blinks a few times, tries to look tough and fails. ${STYLE}`,
    layers: [monsterPng("wolf"), mouthFor("wolf"), eyesFor("wolf")],
    outputPath: `showcase_wolf_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "wrapps": {
    prompt: `Animate this character. He stands center frame. He blinks a couple of times. A bandage slowly unravels from his arm; he notices, tries to re-wrap it, makes it worse. ${STYLE}`,
    layers: [monsterPng("wrapps"), mouthFor("wrapps"), eyesFor("wrapps")],
    outputPath: `showcase_wrapps_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "biggs": {
    prompt: `Animate this character. He stands center frame. He sways his enormous belly side to side, blinks his one giant eye very slowly, flexes both arms to show off, then grins wide. ${STYLE}`,
    layers: [monsterPng("biggs"), mouthFor("biggs"), eyesFor("biggs")],
    outputPath: `showcase_biggs_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "entsy": {
    prompt: `Animate this character. He stands center frame. His mossy branches sway gently, he glances side to side with wide nervous eyes that blink rapidly, then gives a slow bewildered shrug. ${STYLE}`,
    layers: [monsterPng("entsy"), mouthFor("entsy"), eyesFor("entsy")],
    outputPath: `showcase_entsy_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },

  // ---- Outfit examples — mix and match using CLOTHING constants ----
  // Layer order: [Bottom?, monster, mouth, eyes, clothing...]
  "frank-hat": {
    prompt: `Animate this character. He stands center frame. He yawns and blinks slowly, tips his cowboy hat, scratches his belly, gives a slow sleepy wave. ${STYLE}`,
    layers: [monsterPng("frank"), mouthFor("frank"), eyesFor("frank"), CLOTHING.Big.redCowboyHat],
    outputPath: `showcase_frank_hat_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "frank-vest": {
    prompt: `Animate this character. He stands center frame. He admires his vest, blinks proudly, puffs his chest out, then lets it all droop back down. ${STYLE}`,
    layers: [monsterPng("frank"), mouthFor("frank"), eyesFor("frank"), CLOTHING.Big.purpleVest],
    outputPath: `showcase_frank_vest_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "iggs-cap": {
    prompt: `Animate this character. He stands center frame. He blinks, adjusts his cap confidently, then immediately trips over nothing. ${STYLE}`,
    layers: [monsterPng("iggs"), mouthFor("iggs"), eyesFor("iggs"), CLOTHING.Small.baseballCap],
    outputPath: `showcase_iggs_cap_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
  "iggs-skate": {
    prompt: `Animate this character. He stands center frame on a skateboard. He wobbles trying to balance, eyes blinking nervously, almost falls, then strikes a cool pose anyway. ${STYLE}`,
    layers: [CLOTHING.Bottom.blueSkateboard, monsterPng("iggs"), mouthFor("iggs"), eyesFor("iggs")],
    outputPath: `showcase_iggs_skate_${Date.now()}.mp4`,
    aspectRatio: "9:16",
  },
};

// ----------------------------------------------------------------
// Fight presets (prompt-only, 16:9)
// ----------------------------------------------------------------
const FIGHTS: Record<string, VideoConfig> = {
  "frank-vs-wrapps": {
    prompt: `A short cartoon fight scene between two goofy monsters. Frank is a massively overweight Frankenstein's monster with green skin, flat-top head, and neck bolts. Wrapps is a classic mummy in yellowed bandages with a single glowing blue eye. They trade wild exaggerated blows — Frank eats a hot dog mid-fight, Wrapps fires a ridiculous water cannon to finish him. Saturday morning cartoon style, bouncy and fun.`,
    outputPath: `frank_vs_wrapps_${Date.now()}.mp4`,
    aspectRatio: "16:9",
  },
  "iggs-vs-wolf": {
    prompt: `A short cartoon fight scene between two goofy monsters. Iggs is a tiny scrawny yellow-green cyclops monster with one giant expressive eye. Wolf is a muscular werewolf with shaggy brown fur and his tongue permanently flopped out to one side. Iggs fires a laser from his giant eye; Wolf is too dopey to dodge it. Saturday morning cartoon style, big reactions, exaggerated physics.`,
    outputPath: `iggs_vs_wolf_${Date.now()}.mp4`,
    aspectRatio: "16:9",
  },
  "murk-vs-stumbles": {
    prompt: `A short cartoon fight scene between two goofy monsters. Murk is a stocky swamp creature with a hippo's wide flat head, enormous mouth, and muddy brown skin. Stumbles is a thin ragged zombie in tattered clothes who always has a massive grin plastered on his face no matter what happens to him. Stumbles grins through every hit he takes. Murk is baffled by this. Saturday morning cartoon style, bouncy and fun.`,
    outputPath: `murk_vs_stumbles_${Date.now()}.mp4`,
    aspectRatio: "16:9",
  },
};

// ----------------------------------------------------------------
// CLI entry point
//
// Usage:
//   npx ts-node generate.ts                        <- frank showcase (default)
//
//   Bare monsters:
//   npx ts-node generate.ts frank
//   npx ts-node generate.ts iggs
//   npx ts-node generate.ts murk
//   npx ts-node generate.ts stumbles
//   npx ts-node generate.ts wolf
//   npx ts-node generate.ts wrapps
//   npx ts-node generate.ts biggs
//   npx ts-node generate.ts entsy
//
//   Outfit presets:
//   npx ts-node generate.ts frank-hat
//   npx ts-node generate.ts frank-vest
//   npx ts-node generate.ts iggs-cap
//   npx ts-node generate.ts iggs-skate
//
//   Fight scenes:
//   npx ts-node generate.ts frank-vs-wrapps
//   npx ts-node generate.ts iggs-vs-wolf
//   npx ts-node generate.ts murk-vs-stumbles
//
//   Custom prompt:
//   npx ts-node generate.ts "your custom prompt"
// ----------------------------------------------------------------
async function main(): Promise<void> {
  const arg = process.argv[2];
  const key = arg || "frank";

  let config: VideoConfig;
  let label: string;

  if (key in SHOWCASES) {
    config = SHOWCASES[key];
    label = `🐉  Monster showcase: ${key}`;
  } else if (key in FIGHTS) {
    config = FIGHTS[key];
    label = `🥊  Fight scene: ${key}`;
  } else {
    config = {
      prompt: key,
      outputPath: `habitbeast_custom_${Date.now()}.mp4`,
    };
    label = "✏️   Custom prompt";
  }

  console.log(label);
  await generateVideo(config);
}

main().catch((err) => {
  console.error("❌  Error:", err.message ?? err);
  process.exit(1);
});
