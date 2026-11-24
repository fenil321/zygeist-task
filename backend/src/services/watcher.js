import chokidar from "chokidar";
import fs from "fs/promises";
import path from "path";
import { ingestOutboxFile } from "./ingestor.js";

export async function startOutboxWatcher(outboxDir, onEventBroadcast) {
  await fs.mkdir(outboxDir, { recursive: true });

  // Serial queue ensures files are ingested one at a time without DB race conditions
  let queue = Promise.resolve();
  const enqueue = (filePath) => {
    const filename = path.basename(filePath);
    if (filename.endsWith(".tmp") || filename.startsWith(".")) return;

    queue = queue
      .then(() => ingestOutboxFile(filePath, onEventBroadcast))
      .catch((err) =>
        console.error(`[WATCHER] Queue error on ${filename}:`, err),
      );
  };

  // 1. Startup catch-up scan for any files emitted while the platform was offline
  const entries = await fs.readdir(outboxDir, { withFileTypes: true });
  const fileStats = await Promise.all(
    entries
      .filter(
        (e) =>
          e.isFile() && !e.name.endsWith(".tmp") && !e.name.startsWith("."),
      )
      .map(async (e) => {
        const fullPath = path.join(outboxDir, e.name);
        const st = await fs.stat(fullPath);
        return { fullPath, mtimeMs: st.mtimeMs, name: e.name };
      }),
  );

  // Load PRICELIST_*.xml first so items/departments exist before checking TLOG references,
  // then sort remaining files chronologically by modification time (mtime)
  fileStats.sort((a, b) => {
    const aIsPriceList = a.name.startsWith("PRICELIST_") ? 0 : 1;
    const bIsPriceList = b.name.startsWith("PRICELIST_") ? 0 : 1;
    if (aIsPriceList !== bIsPriceList) return aIsPriceList - bIsPriceList;
    return a.mtimeMs - b.mtimeMs;
  });

  console.log(
    `[WATCHER] Catch-up scan found ${fileStats.length} file(s) in ${outboxDir}`,
  );
  for (const file of fileStats) {
    enqueue(file.fullPath);
  }
  await queue;

  // 2. Watch outbox/ live for newly arriving or re-emitted files
  const watcher = chokidar.watch(outboxDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100,
    },
  });

  watcher.on("add", enqueue);
  watcher.on("change", enqueue);
  watcher.on("error", (err) => console.error("[WATCHER] Chokidar error:", err));

  console.log(`[WATCHER] Live monitoring active on ${outboxDir}`);
  return watcher;
}
