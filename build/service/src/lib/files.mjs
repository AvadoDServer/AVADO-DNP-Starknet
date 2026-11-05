// Settings and secrets on the package volume. Writes go to a temporary file
// first and are renamed into place, so a restart in the middle of a write never
// leaves a half-written file behind.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(path, data, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export function writeJsonFile(path, value, mode = 0o600) {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", mode);
}

export function removeFile(path) {
  if (existsSync(path)) rmSync(path, { force: true });
}

/** Free and total bytes of the file system that holds `path`, or null. */
export function diskSpace(path) {
  try {
    const s = statfsSync(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}
