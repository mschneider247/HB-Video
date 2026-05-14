import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";
import { MONSTERS_DIR } from "../config";

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function aspectRatioDims(ar: string): [number, number] {
  if (ar === "1:1")  return [720, 720];
  if (ar === "16:9") return [1280, 720];
  return [720, 1280]; // 9:16 default
}

export async function compositeLayersToBase64(layers: string[], aspectRatio: string): Promise<string> {
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
