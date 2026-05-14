import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import { execSync } from "child_process";

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

export const FFMPEG_PATH = findFfmpeg();

if (FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(FFMPEG_PATH);
  console.log(`✅ ffmpeg found: ${FFMPEG_PATH}`);
} else {
  console.warn("⚠️  ffmpeg not found — video processing disabled. Install from https://ffmpeg.org/download.html and add to PATH.");
}

export function probeVideoDimensions(filePath: string): { w: number; h: number } {
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
  return { w: 720, h: 1280 };
}

export function probeVideoDuration(filePath: string): number {
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
  return 8;
}

export type ZoomStyle = "punch" | "pull-back" | "burst" | "drift" | "ken-burns";

export function createScreenshotClip(
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
    const cx     = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;

    let zpFilter: string;
    switch (style) {
      case "punch":
        zpFilter = `zoompan=z='if(lte(on,${fps}),1+on*(0.5/${fps}),1.5)':d=${frames}:s=${dim}:${cx}`;
        break;
      case "pull-back":
        zpFilter = `zoompan=z='max(1.5-on*(0.5/${frames}),1.0)':d=${frames}:s=${dim}:${cx}`;
        break;
      case "burst":
        zpFilter = `zoompan=z='if(lte(on,12),1+on*(0.6/12),max(1.6-(on-12)*(0.3/${frames - 12}),1.3))':d=${frames}:s=${dim}:${cx}`;
        break;
      case "drift":
        zpFilter = `zoompan=z=1.3:d=${frames}:s=${dim}:x='(iw-iw/zoom)*(on/${frames})':y='(ih-ih/zoom)*(on/${frames})'`;
        break;
      case "ken-burns":
      default: {
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

export type ClipFilter =
  | "none" | "bw" | "sepia" | "vibrant" | "vintage" | "invert" | "vignette" | "warm" | "cool";

export const FILTER_VF: Record<ClipFilter, string | null> = {
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

export function applyClipFilter(input: string, output: string, filter: ClipFilter): Promise<void> {
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

export type TransitionKind =
  | "cut" | "fade" | "fadeblack" | "fadewhite"
  | "wipeleft" | "wiperight" | "wipeup" | "wipedown"
  | "slideleft" | "slideright" | "slideup" | "slidedown"
  | "circleopen" | "circleclose" | "pixelize" | "radial" | "smoothleft";

export function concatClipsWithTransitions(
  clipPaths: string[],
  transitions: TransitionKind[],
  durations: number[],
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
      const prep = clipPaths.map((_, i) => `[${i}:v]format=yuv420p,setsar=1,fps=30[p${i}]`).join(";");
      const Ds = transitions.map(t => t === "cut" ? 0.05 : transitionSeconds);
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

export function concatClips(clipPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const bin = FFMPEG_PATH!;
      const inputs = clipPaths.map(p => `-i "${p}"`).join(" ");
      // Normalise SAR to 1:1 on every stream — mismatched SAR causes concat filter to fail
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
