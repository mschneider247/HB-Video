import { Router } from "express";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { OUTPUT_DIR, GOOD_TO_GO_DIR, SCREENSHOTS_DIR, COMPOSED_DIR } from "../config";
import {
  FFMPEG_PATH,
  probeVideoDimensions, probeVideoDuration,
  ZoomStyle, createScreenshotClip,
  ClipFilter, FILTER_VF, applyClipFilter,
  TransitionKind, concatClips, concatClipsWithTransitions,
} from "../utils/ffmpeg";

const router = Router();

router.post("/api/append-screenshots", async (req, res) => {
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

    const ts = Date.now();
    const clipPaths: string[] = [];
    for (let i = 0; i < screenshots.length; i++) {
      const screenshotPath = path.join(SCREENSHOTS_DIR, screenshots[i]);
      if (!fs.existsSync(screenshotPath)) throw new Error(`Screenshot not found: ${screenshots[i]}`);
      const clipPath = path.join(OUTPUT_DIR, `_sc_${ts}_${i}.mp4`);
      console.log(`🖼️  Creating clip ${i + 1}/${screenshots.length}: ${screenshots[i]} [${transitionStyle}]`);
      await createScreenshotClip(screenshotPath, clipPath, vW, vH, 4, transitionStyle as ZoomStyle);
      clipPaths.push(clipPath);
    }

    if (mode === "interspersed") {
      const duration = probeVideoDuration(inputPath);
      const n = screenshots.length;
      const segDur = duration / n;
      console.log(`✂️  Splitting ${duration.toFixed(2)}s video into ${n} segments of ~${segDur.toFixed(2)}s each...`);

      const segPaths: string[] = [];
      for (let i = 0; i < n; i++) {
        const segPath = path.join(OUTPUT_DIR, `_seg_${ts}_${i}.mp4`);
        const ss = (i * segDur).toFixed(3);
        const t  = segDur.toFixed(3);
        execSync(
          `"${FFMPEG_PATH}" -i "${inputPath}" -ss ${ss} -t ${t} -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 "${segPath}" -y`,
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        segPaths.push(segPath);
      }

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

router.post("/api/prepend-intro", async (req, res) => {
  const { file, introFile, introSource, transitionStyle = "ken-burns", introDuration = 4 } = req.body;
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
      const imagePath = path.join(SCREENSHOTS_DIR, introFile);
      if (!fs.existsSync(imagePath)) {
        res.status(404).json({ error: `Intro image not found: ${introFile}` });
        return;
      }
      introClipPath = path.join(OUTPUT_DIR, `_intro_${ts}.mp4`);
      console.log(`🎬 Creating intro clip from image: ${introFile} [${transitionStyle}]`);
      await createScreenshotClip(imagePath, introClipPath, vW, vH, introDuration, transitionStyle as ZoomStyle);
      createdTempClip = true;
    } else {
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

router.post("/api/splice", async (req, res) => {
  const { items, aspectRatio = "9:16", transitionSeconds = 0.5 } = req.body as {
    items?: Array<{
      type: "image" | "video";
      file: string;
      style?: ZoomStyle;
      duration?: number;
      source?: "screenshot" | "composed";
      filter?: ClipFilter;
      transition?: TransitionKind;
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

  let vW = 720, vH = 1280;
  const firstVideo = items.find(it => it.type === "video");
  if (firstVideo) {
    const probePath = path.join(GOOD_TO_GO_DIR, firstVideo.file);
    if (fs.existsSync(probePath)) {
      const dims = probeVideoDimensions(probePath);
      vW = dims.w; vH = dims.h;
    }
  } else {
    if (aspectRatio === "16:9") { vW = 1280; vH = 720; }
    else                        { vW = 720;  vH = 1280; }
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
        const sourceDir = it.source === "composed" ? COMPOSED_DIR : SCREENSHOTS_DIR;
        const src = path.join(sourceDir, it.file);
        if (!fs.existsSync(src)) throw new Error(`Image not found: ${it.file} (source=${it.source || "screenshot"})`);
        const clipPath = path.join(OUTPUT_DIR, `_splice_${ts}_${i}.mp4`);
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
          const normPath = path.join(OUTPUT_DIR, `_splice_${ts}_${i}_norm.mp4`);
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

      const filter = (it.filter || "none") as ClipFilter;
      if (filter !== "none" && FILTER_VF[filter]) {
        const filteredPath = path.join(OUTPUT_DIR, `_splice_${ts}_${i}_fx.mp4`);
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

    const transitions: TransitionKind[] = items.slice(0, -1).map(it => (it.transition || "cut") as TransitionKind);
    const hasNamedTransition = transitions.some(t => t !== "cut");

    if (hasNamedTransition) {
      console.log(`✂️  Crossfade-concatenating ${orderedClipPaths.length} clips with transitions [${transitions.join(", ")}] → ${outputName}`);
      await concatClipsWithTransitions(orderedClipPaths, transitions, clipDurations, outputPath, transitionSeconds);
    } else {
      console.log(`✂️  Concatenating ${orderedClipPaths.length} clips → ${outputName}`);
      await concatClips(orderedClipPaths, outputPath);
    }

    for (const p of tempClips) { try { fs.unlinkSync(p); } catch {} }
    console.log(`✅ Spliced: ${outputName}`);
    res.json({ success: true, file: outputName, count: orderedClipPaths.length });
  } catch (err: any) {
    for (const p of tempClips) { try { fs.unlinkSync(p); } catch {} }
    console.error("❌ splice error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
