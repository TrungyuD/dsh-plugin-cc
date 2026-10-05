import fs from "node:fs";
import path from "node:path";

const SKIPPED_DIRS = new Set(["reports", "archive"]);

// Symlinks are skipped: a plan folder must not be able to pull in files from elsewhere on disk.
function isPlainFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function listPhaseFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^phase-.*\.md$/.test(name) && isPlainFile(path.join(dir, name)))
    .sort();
}

function newestMtimeMs(dir) {
  const names = ["plan.md", ...listPhaseFiles(dir)];
  return Math.max(...names.map((name) => fs.statSync(path.join(dir, name)).mtimeMs));
}

/**
 * Returns the plan directory under `<root>/plans/` that changed most recently, relative to `root`,
 * or null. A plan directory contains `plan.md`. `reports/` and `archive/` are skipped.
 */
export function findLatestPlanDir(root) {
  const plansDir = path.join(root, "plans");
  if (!fs.existsSync(plansDir)) {
    return null;
  }

  let latest = null;
  for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const dir = path.join(plansDir, entry.name);
    if (!isPlainFile(path.join(dir, "plan.md"))) {
      continue;
    }
    const mtime = newestMtimeMs(dir);
    if (!latest || mtime > latest.mtime) {
      latest = { name: entry.name, mtime };
    }
  }
  return latest ? path.join("plans", latest.name) : null;
}

/**
 * Resolves a plan path to the files to review. A file yields itself. A directory yields `plan.md`
 * followed by every `phase-*.md` in name order. Throws when the path or `plan.md` is missing.
 */
export function collectPlanFiles(absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Plan path not found: ${absolutePath}`);
  }
  if (!fs.statSync(absolutePath).isDirectory()) {
    return [absolutePath];
  }
  const planFile = path.join(absolutePath, "plan.md");
  if (!isPlainFile(planFile)) {
    throw new Error(`No plan.md in ${absolutePath}. Pass a plan file or a directory that has plan.md.`);
  }
  return [planFile, ...listPhaseFiles(absolutePath).map((name) => path.join(absolutePath, name))];
}
