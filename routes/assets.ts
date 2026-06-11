import { Router } from "express";
import * as path from "path";
import * as fs from "fs";
import { MONSTERS_DIR, OUTPUT_DIR, GOOD_TO_GO_DIR, SCREENSHOTS_DIR, COMPOSED_DIR } from "../config";
import { BIG_MONSTERS, SMALL_MONSTERS } from "../constants";
import { compositeLayersToBase64 } from "../utils/composite";

const router = Router();

router.get("/api/assets", (_req, res) => {
  const rootBgs = ["background.png", "laboratory.png"]
    .filter(f => fs.existsSync(path.join(MONSTERS_DIR, f)));
  const bgFolder = path.join(MONSTERS_DIR, "Background");
  const folderBgs = fs.existsSync(bgFolder)
    ? fs.readdirSync(bgFolder).filter(f => f.endsWith(".png")).sort().map(f => "Background/" + f)
    : [];
  const backgrounds = [...rootBgs, ...folderBgs];

  const monsters = ["frank", "iggs", "murk", "stumbles", "wolf", "wrapps", "biggs", "entsy"]
    .filter(m => fs.existsSync(path.join(MONSTERS_DIR, `${m}.png`)));

  if (fs.existsSync(path.join(MONSTERS_DIR, "lab-assistant.png"))) {
    monsters.push("lab-assistant");
  }

  function loadClothing(size: "Big" | "Small"): string[] {
    const root = path.join(MONSTERS_DIR, size);
    const base = fs.readdirSync(root).filter(f => f.endsWith(".png"));
    const classDir = path.join(root, "Class");
    const classItems = fs.existsSync(classDir)
      ? fs.readdirSync(classDir).filter(f => f.endsWith(".png") && !f.endsWith("Bottom.png") && !f.endsWith("Top.png")).map(f => `Class/${f}`)
      : [];
    return [...base, ...classItems];
  }
  const bigClothing   = loadClothing("Big");
  const smallClothing = loadClothing("Small");
  const bottomItems   = fs.readdirSync(path.join(MONSTERS_DIR, "Bottom")).filter(f => f.endsWith(".png"));

  function loadPaired(size: "Big" | "Small"): { capes: string[]; wigs: string[] } {
    const result = { capes: [] as string[], wigs: [] as string[] };
    const dirs: Array<[string, string]> = [
      [path.join(MONSTERS_DIR, size, "Paired"), ""],
      [path.join(MONSTERS_DIR, size, "Class"),  "Class/"],
    ];
    for (const [dir, prefix] of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      const tops = new Set(files.filter(f => /Top\.png$/i.test(f)).map(f => f.replace(/Top\.png$/i, "")));
      const bots = new Set(files.filter(f => /Bottom\.png$/i.test(f)).map(f => f.replace(/Bottom\.png$/i, "")));
      for (const name of [...tops].filter(n => bots.has(n)).sort()) {
        const full = prefix + name;
        if (/Wig$/i.test(name)) result.wigs.push(full);
        else result.capes.push(full);
      }
    }
    return result;
  }
  const bigPaired   = loadPaired("Big");
  const smallPaired = loadPaired("Small");
  const bigCapes    = bigPaired.capes;
  const smallCapes  = smallPaired.capes;
  const bigWigs     = bigPaired.wigs;
  const smallWigs   = smallPaired.wigs;

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
  const bigOverlays    = loadMouthAndMustacheStyles("Big");
  const smallOverlays  = loadMouthAndMustacheStyles("Small");

  const bigMouthsDir   = path.join(MONSTERS_DIR, "Big",   "Mouths");
  const smallMouthsDir = path.join(MONSTERS_DIR, "Small", "Mouths");
  const bigMouths   = fs.existsSync(bigMouthsDir)   ? fs.readdirSync(bigMouthsDir).filter(f   => f.endsWith(".png")) : [];
  const smallMouths = fs.existsSync(smallMouthsDir) ? fs.readdirSync(smallMouthsDir).filter(f => f.endsWith(".png")) : [];

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
  const bigEyes:   Record<string, string[]> = {};
  const smallEyes: Record<string, string[]> = {};
  for (const m of BIG_MONSTERS)   bigEyes[m]   = loadEyesFor("Big",   m);
  for (const m of SMALL_MONSTERS) smallEyes[m] = loadEyesFor("Small", m);

  const flatColors = [
    { label: "White",    color: "#FFFFFF" },
    { label: "Cream",    color: "#FFF8E7" },
    { label: "Grey",     color: "#D0D0D0" },
    { label: "Sky",      color: "#87CEEB" },
    { label: "Green",    color: "#00CC44" },
    { label: "Yellow",   color: "#FFE566" },
    { label: "Coral",    color: "#FF6B6B" },
    { label: "Blue",     color: "#3399FF" },
    { label: "Lavender", color: "#C8A4FF" },
    { label: "Peach",    color: "#FFB877" },
  ];

  res.json({
    backgrounds,
    monsters,
    bigClothing,
    smallClothing,
    bigCapes,
    smallCapes,
    bigWigs,
    smallWigs,
    bigMustaches:   bigOverlays.mustaches,
    smallMustaches: smallOverlays.mustaches,
    bigMouthStyles:   bigOverlays.mouthStyles,
    smallMouthStyles: smallOverlays.mouthStyles,
    bottomItems,
    bigMouths,
    smallMouths,
    bigEyes,
    smallEyes,
    bigMonsters:   [...BIG_MONSTERS],
    smallMonsters: [...SMALL_MONSTERS],
    flatColors,
    styles: [],
  });
});

router.get("/api/screenshots", (_req, res) => {
  const files = fs.existsSync(SCREENSHOTS_DIR)
    ? fs.readdirSync(SCREENSHOTS_DIR).filter(f => /\.(png|jpe?g)$/i.test(f))
    : [];
  res.json({ screenshots: files });
});

router.get("/api/composed", (_req, res) => {
  const files = fs.existsSync(COMPOSED_DIR)
    ? fs.readdirSync(COMPOSED_DIR).filter(f => /\.(png|jpe?g)$/i.test(f)).sort().reverse()
    : [];
  res.json({ composed: files });
});

router.get("/api/goodtogo", (_req, res) => {
  const files = fs.existsSync(GOOD_TO_GO_DIR)
    ? fs.readdirSync(GOOD_TO_GO_DIR).filter(f => /\.mp4$/i.test(f)).sort().reverse()
    : [];
  res.json({ files });
});

router.post("/api/approve", (req, res) => {
  const { file } = req.body;
  if (!file) { res.status(400).json({ error: "No file specified." }); return; }
  const src  = path.join(OUTPUT_DIR, file);
  const dest = path.join(GOOD_TO_GO_DIR, file);
  if (!fs.existsSync(src)) { res.status(404).json({ error: "File not found: " + src }); return; }
  try {
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
    console.log(`✅ Approved: ${file} → GoodToGo/`);
    res.json({ success: true, file });
  } catch (err: any) {
    console.error("❌ Approve failed:", err.message);
    res.status(500).json({ error: "Failed to move file: " + err.message });
  }
});

router.post("/api/reject", (req, res) => {
  const { file } = req.body;
  if (!file) { res.status(400).json({ error: "No file specified." }); return; }
  const filePath = path.join(OUTPUT_DIR, file);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  console.log(`🗑️  Rejected: ${file}`);
  res.json({ success: true });
});

router.post("/api/compose-frame", async (req, res) => {
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

export default router;
