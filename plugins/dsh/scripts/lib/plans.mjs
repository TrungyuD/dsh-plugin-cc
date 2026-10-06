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

const SLUG_LIMIT = 40;
const HEADING_LIMIT = 120;

function pad(value) {
  return String(value).padStart(2, "0");
}

function slugify(text) {
  // NFKD has no decomposition for the Vietnamese d with stroke, so map it first.
  const slug = String(text ?? "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_LIMIT) {
    return slug;
  }
  const cut = slug.slice(0, SLUG_LIMIT + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, SLUG_LIMIT)).replace(/-+$/, "");
}

/** Name of a new plan directory, `YYMMDD-HHmm-<slug>`, in the local time of `date`. */
export function planDirName(request, date = new Date()) {
  const stamp = `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp}-${slugify(request) || "dsh-plan"}`;
}

/**
 * Writes `text` as `<workspaceRoot>/plans/<planDirName>/plan.md` and returns that path relative to
 * the workspace. The directory is created exclusively, so two saves in the same minute with the
 * same request get `-2`, `-3`, ... instead of sharing a directory.
 */
export function savePlanFile(workspaceRoot, request, text, date = new Date()) {
  const plansDir = path.join(workspaceRoot, "plans");
  fs.mkdirSync(plansDir, { recursive: true });

  const base = planDirName(request, date);
  let name = base;
  for (let attempt = 2; ; attempt += 1) {
    try {
      fs.mkdirSync(path.join(plansDir, name));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      name = `${base}-${attempt}`;
    }
  }

  const title = String(request ?? "").trim().replace(/\s+/g, " ").slice(0, HEADING_LIMIT);
  const file = path.join(plansDir, name, "plan.md");
  fs.writeFileSync(file, `# Plan: ${title}\n\n${String(text).trimEnd()}\n`, "utf8");
  return path.join("plans", name, "plan.md");
}
