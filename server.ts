import express from "express";
import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";
import { PORT, MONSTERS_DIR, OUTPUT_DIR, GOOD_TO_GO_DIR, SCREENSHOTS_DIR, COMPOSED_DIR } from "./config";
import "./utils/ffmpeg"; // initialises ffmpeg path on import
import assetsRouter from "./routes/assets";
import videoRouter  from "./routes/video";
import blinkRouter  from "./routes/blink";
import tempoRouter  from "./routes/tempo";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));

// Ensure output directories exist
for (const dir of [GOOD_TO_GO_DIR, SCREENSHOTS_DIR, COMPOSED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Static asset serving
app.use("/assets",      express.static(MONSTERS_DIR));
app.use("/videos",      express.static(OUTPUT_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");
  },
}));
app.use("/goodtogo",    express.static(GOOD_TO_GO_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");
  },
}));
app.use("/screenshots", express.static(SCREENSHOTS_DIR));
app.use("/composed",    express.static(COMPOSED_DIR));

// API routes
app.use(assetsRouter);
app.use(videoRouter);
app.use(blinkRouter);
app.use(tempoRouter);

// UI
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`HB-Video running at http://localhost:${PORT}`);
});
