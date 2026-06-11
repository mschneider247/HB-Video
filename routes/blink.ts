import { Router } from "express";
import * as path from "path";
import { OUTPUT_DIR } from "../config";
import { BIG_MONSTERS, SMALL_MONSTERS } from "../constants";
import { aspectRatioDims } from "../utils/composite";
import { renderBlinkClip, renderBradyBunch, renderFartClip, renderLineupPan, GridCell } from "../blink";

const router = Router();

const BLINK_MONSTERS = new Set([...BIG_MONSTERS, ...SMALL_MONSTERS]);
const BLINK_MOODS    = new Set(["happy", "okay", "excited", "sad", "upset"]);

router.post("/api/blink", async (req, res) => {
  const {
    monster,
    mood = "happy",
    bgColor = "#1a1a24",
    backgroundImage,
    clothing = [],
    bottom,
    cape,
    wig,
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
    wig?: string | null;
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
  const [w, h] = aspectRatio === "1:1" ? [1080, 1080] : aspectRatioDims(aspectRatio);

  const ts = Date.now();
  const outputName = `habitbeast_blink_${monster}_${safeMood}_${ts}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log(`\n🔁 Rendering blink loop`);
  console.log(`   monster=${monster} mood=${safeMood} bg=${bgColor} dur=${dur}s ${w}×${h}`);

  try {
    await renderBlinkClip({
      monster: monster as any,
      mood: safeMood as any,
      bgColor,
      backgroundImage: backgroundImage || undefined,
      clothing: Array.isArray(clothing) ? clothing : [],
      bottom: bottom || undefined,
      cape:   cape   || undefined,
      wig:    wig    || undefined,
      mustache:   mustache   || undefined,
      mouthStyle: mouthStyle || undefined,
      durationSec: dur,
      width: w,
      height: h,
      outputPath,
    });
    console.log(`✅ Saved: ${outputPath}`);
    res.json({ success: true, file: outputName });
  } catch (err: any) {
    console.error("❌ blink error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/blink-grid", async (req, res) => {
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
    wig:    c.wig    || undefined,
    mustache:   c.mustache   || undefined,
    mouthStyle: c.mouthStyle || undefined,
    behavior: (c.behavior === "fart" || c.behavior === "eyeRoll") ? c.behavior : undefined,
    behaviorAt: typeof c.behaviorAt === "number" ? c.behaviorAt : undefined,
  }));

  const ts = Date.now();
  const outputName = `habitbeast_brady_${ts}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log(`\n🎬 Rendering Brady Bunch grid`);
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
    res.json({ success: true, file: outputName });
  } catch (err: any) {
    console.error("❌ brady error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/blink-fart", async (req, res) => {
  const {
    monster,
    bgColor = "#1a1a24",
    backgroundImage,
    clothing = [],
    bottom,
    cape,
    wig,
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
    wig?: string | null;
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
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log(`\n💨 Rendering fart sequence`);
  console.log(`   monster=${monster} bg=${bgColor} ${w}×${h}`);

  try {
    await renderFartClip({
      monster: monster as any,
      bgColor,
      backgroundImage: backgroundImage || undefined,
      clothing: Array.isArray(clothing) ? clothing : [],
      bottom: bottom || undefined,
      cape:   cape   || undefined,
      wig:    wig    || undefined,
      mustache:   mustache   || undefined,
      mouthStyle: mouthStyle || undefined,
      preRollSec: 0.5,
      postRollSec: 0.5,
      width: w,
      height: h,
      outputPath,
    });
    console.log(`✅ Saved: ${outputPath}`);
    res.json({ success: true, file: outputName });
  } catch (err: any) {
    console.error("❌ fart error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/blink-lineup", async (req, res) => {
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
    wig:    c.wig    || undefined,
    mustache:   c.mustache   || undefined,
    mouthStyle: c.mouthStyle || undefined,
    behavior: (c.behavior === "fart" || c.behavior === "eyeRoll") ? c.behavior : undefined,
    behaviorAt: typeof c.behaviorAt === "number" ? c.behaviorAt : undefined,
  }));

  const ts = Date.now();
  const outputName = `habitbeast_lineup_${ts}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log(`\n🎥 Rendering Lineup Pan`);
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
    res.json({ success: true, file: outputName });
  } catch (err: any) {
    console.error("❌ lineup error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
