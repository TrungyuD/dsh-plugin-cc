import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";

export const SCOPES = ["auto", "working-tree", "branch"];
export const DEFAULT_MAX_DIFF_BYTES = 256 * 1024;
export const DEFAULT_MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_LOG_LINES = 50;
const BINARY_SNIFF_BYTES = 8 * 1024;
const DEFAULT_BRANCH_NAMES = ["main", "master", "trunk"];

// Repository config must not run a command while a change is collected: no external diff tool, no
// textconv driver, no fsmonitor hook and no signature check. Clean filters still run, as they do for
// any `git diff`; git has no switch for them.
const GIT_SAFETY_CONFIG = ["-c", "core.fsmonitor=false"];
const DIFF_FLAGS = ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color"];

function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

function runGit(repoRoot, args, maxBuffer) {
  return runCommand("git", [...GIT_SAFETY_CONFIG, ...args], { cwd: repoRoot, env: gitEnv(), shell: false, maxBuffer });
}

function git(repoRoot, args, maxBuffer) {
  const result = runGit(repoRoot, args, maxBuffer);
  if (result.error || result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || `exit status ${result.status}`;
    throw new Error(`git failed: ${detail}`);
  }
  return result.stdout;
}

function refExists(repoRoot, ref) {
  return runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

function currentBranch(repoRoot) {
  const result = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function detectDefaultBranch(repoRoot) {
  const remoteHead = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.status === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim();
  }
  for (const name of DEFAULT_BRANCH_NAMES) {
    if (refExists(repoRoot, `refs/heads/${name}`)) {
      return name;
    }
  }
  throw new Error("Cannot detect the default branch. Pass --base <ref> or use --scope working-tree.");
}

function hasWorkingTreeChanges(repoRoot) {
  return git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"]).length > 0;
}

function branchTarget(repoRoot, baseRef) {
  const branch = currentBranch(repoRoot);
  return {
    mode: "branch",
    baseRef,
    label: `${branch ? `branch ${branch}` : "detached HEAD"} against ${baseRef}`
  };
}

/**
 * Decides what to review. `auto` reviews the working tree when it has changes and otherwise the
 * current branch against the default branch.
 */
export function resolveReviewTarget(repoRoot, { scope = "auto", base = null } = {}) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`Unsupported review scope "${scope}". Use auto, working-tree or branch.`);
  }
  const hasBase = base !== null && base !== undefined;
  if (hasBase && scope === "working-tree") {
    throw new Error("--base only applies to branch review.");
  }
  if (hasBase) {
    if (!base || base.startsWith("-") || !refExists(repoRoot, base)) {
      throw new Error(`Unknown ref: ${base}`);
    }
    return branchTarget(repoRoot, base);
  }
  if (scope === "working-tree" || (scope === "auto" && hasWorkingTreeChanges(repoRoot))) {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
  }
  // A repository without commits has no branch to compare; its working tree is all there is.
  if (!refExists(repoRoot, "HEAD")) {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
  }
  return branchTarget(repoRoot, detectDefaultBranch(repoRoot));
}

// `--name-status -z` prints `<status>\0<path>\0`, and `<status>\0<old>\0<new>\0` for renames and copies.
function parseNameStatus(output) {
  const parts = output.split("\0");
  const files = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!status) {
      continue;
    }
    const paths = /^[RC]/.test(status) ? 2 : 1;
    const names = parts.slice(index, index + paths);
    index += paths;
    files.push({ path: names.at(-1), status: status[0] });
  }
  return files;
}

// Paths come from the repository and may hold any character, so keep them from closing a tag.
const ATTRIBUTE_ESCAPES = { '"': "%22", "<": "%3C", ">": "%3E", "\n": "%0A", "\r": "%0D" };

function escapeAttribute(value) {
  return value.replace(/["<>\n\r]/g, (char) => ATTRIBUTE_ESCAPES[char]);
}

function section(tag, attributes, content) {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
  return `<${tag}${attrs}>\n${content.replace(/\n$/, "")}\n</${tag}>`;
}

function readUntracked(repoRoot, relativePath, maxUntrackedBytes) {
  const full = path.join(repoRoot, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    return { note: `skipped: ${error.code ?? "unreadable"}` };
  }
  if (!stat.isFile()) {
    return { note: "skipped: not a regular file" };
  }
  if (stat.size > maxUntrackedBytes) {
    return { note: `skipped: ${stat.size} bytes` };
  }
  let buffer;
  try {
    buffer = fs.readFileSync(full);
  } catch (error) {
    return { note: `skipped: ${error.code ?? "unreadable"}` };
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { note: "skipped: binary" };
  }
  return { content: buffer.toString("utf8") };
}

function collectWorkingTree(repoRoot, limits) {
  const maxBuffer = limits.maxDiffBytes * 4;
  const files = [];
  const seen = new Set();
  const addFiles = (list) => {
    for (const file of list) {
      if (!seen.has(file.path)) {
        seen.add(file.path);
        files.push(file);
      }
    }
  };
  const parts = [];
  let overflow = false;
  const diffs = [
    ["staged", ["--cached"]],
    ["unstaged", []]
  ];
  for (const [name, extra] of diffs) {
    addFiles(parseNameStatus(git(repoRoot, [...DIFF_FLAGS, ...extra, "--name-status", "-z", "--"])));
    const result = runGit(repoRoot, [...DIFF_FLAGS, ...extra, "--"], maxBuffer);
    if (result.error?.code === "ENOBUFS") {
      overflow = true;
    } else if (result.error || result.status !== 0) {
      throw new Error(`git diff failed: ${result.stderr.trim() || result.error?.message}`);
    } else if (result.stdout) {
      parts.push(section("diff", { section: name }, result.stdout));
    }
  }

  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  addFiles(untracked.map((file) => ({ path: file, status: "?" })));

  let inlineBytes = parts.reduce((total, part) => total + Buffer.byteLength(part), 0);
  for (const file of untracked) {
    if (overflow || inlineBytes > limits.maxDiffBytes) {
      overflow = true;
      break;
    }
    const { content, note } = readUntracked(repoRoot, file, limits.maxUntrackedBytes);
    const block = section("untracked", { path: file }, content ?? `(${note})`);
    inlineBytes += Buffer.byteLength(block);
    parts.push(block);
  }

  const stat = () =>
    [["--cached"], []]
      .map((extra) => git(repoRoot, [...DIFF_FLAGS, ...extra, "--stat", "--"], maxBuffer))
      .filter(Boolean)
      .join("\n");
  return { files, parts, inlineBytes, overflow, stat };
}

function collectBranch(repoRoot, baseRef, limits) {
  const maxBuffer = limits.maxDiffBytes * 4;
  const mergeBaseResult = runGit(repoRoot, ["merge-base", "HEAD", baseRef]);
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
    const shallow = runGit(repoRoot, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
    throw new Error(
      `No common ancestor between HEAD and ${baseRef}.${shallow ? " This is a shallow clone; run `git fetch --unshallow` and retry." : ""}`
    );
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const range = [mergeBase, "HEAD"];
  const files = parseNameStatus(git(repoRoot, [...DIFF_FLAGS, "--name-status", "-z", ...range, "--"]));
  const log = git(repoRoot, ["log", "--oneline", "--no-decorate", "--no-color", "--no-show-signature", "-n", String(MAX_LOG_LINES), `${mergeBase}..HEAD`]);
  const parts = log.trim() ? [section("commits", {}, log)] : [];
  const result = runGit(repoRoot, [...DIFF_FLAGS, ...range, "--"], maxBuffer);
  let overflow = false;
  if (result.error?.code === "ENOBUFS") {
    overflow = true;
  } else if (result.error || result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim() || result.error?.message}`);
  } else if (result.stdout) {
    parts.push(section("diff", {}, result.stdout));
  }
  const inlineBytes = parts.reduce((total, part) => total + Buffer.byteLength(part), 0);
  const stat = () => git(repoRoot, [...DIFF_FLAGS, "--stat", ...range, "--"], maxBuffer);
  return { files, parts, inlineBytes, overflow, stat };
}

// The fallback body must respect the size cap too, so a huge file list ends with a count.
function fileList(files, maxBytes) {
  const lines = [];
  let bytes = 0;
  for (const file of files) {
    const line = `${file.status}\t${file.path.replace(/[\r\n]/g, " ")}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > maxBytes) {
      lines.push(`... and ${files.length - lines.length} more files`);
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Collects the change as prompt-ready text. When the change is larger than `maxDiffBytes`, the body
 * carries the diffstat and the changed file names instead, and tells the reviewer to read the files.
 */
export function collectReviewContext(repoRoot, target, options = {}) {
  const limits = {
    maxDiffBytes: options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    maxUntrackedBytes: options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES
  };
  const collected =
    target.mode === "working-tree"
      ? collectWorkingTree(repoRoot, limits)
      : collectBranch(repoRoot, target.baseRef, limits);
  const { files, parts, inlineBytes, overflow, stat } = collected;
  const truncated = overflow || inlineBytes > limits.maxDiffBytes;
  let body = parts.join("\n\n");
  if (truncated) {
    const names = fileList(files, limits.maxDiffBytes);
    body = [
      `The change is larger than ${limits.maxDiffBytes} bytes, so the full diff is not included. Read the changed files yourself.`,
      section("diffstat", {}, stat().slice(0, limits.maxDiffBytes)),
      section("changed_files", {}, names)
    ].join("\n\n");
  }
  return {
    label: target.label,
    empty: files.length === 0,
    files,
    fileCount: files.length,
    diffBytes: inlineBytes,
    truncated,
    body
  };
}
