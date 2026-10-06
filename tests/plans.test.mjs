import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { collectPlanFiles, findLatestPlanDir, planDirName, savePlanFile } from "../plugins/dsh/scripts/lib/plans.mjs";

function writePlan(root, name, files, mtimeSeconds) {
  const dir = path.join(root, "plans", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const full = path.join(dir, file);
    fs.writeFileSync(full, `# ${file}\n`);
    fs.utimesSync(full, mtimeSeconds, mtimeSeconds);
  }
  return dir;
}

test("findLatestPlanDir ranks plans by the newest plan or phase file", () => {
  const root = makeTempDir();
  writePlan(root, "older", ["plan.md", "phase-01-a.md"], 1000);
  writePlan(root, "newer-by-phase", ["plan.md", "phase-01-a.md"], 500);
  const phase = path.join(root, "plans", "newer-by-phase", "phase-01-a.md");
  fs.utimesSync(phase, 2000, 2000);

  assert.equal(findLatestPlanDir(root), path.join("plans", "newer-by-phase"));
});

test("findLatestPlanDir skips reports and archive and directories without plan.md", () => {
  const root = makeTempDir();
  writePlan(root, "real", ["plan.md"], 1000);
  writePlan(root, "reports", ["plan.md"], 5000);
  writePlan(root, "archive", ["plan.md"], 5000);
  writePlan(root, "no-plan-file", ["phase-01-a.md"], 5000);

  assert.equal(findLatestPlanDir(root), path.join("plans", "real"));
});

test("findLatestPlanDir returns null when there is no plans directory or no plan", () => {
  const root = makeTempDir();
  assert.equal(findLatestPlanDir(root), null);
  fs.mkdirSync(path.join(root, "plans", "reports"), { recursive: true });
  assert.equal(findLatestPlanDir(root), null);
});

test("collectPlanFiles returns a single file as-is", () => {
  const root = makeTempDir();
  const file = path.join(root, "one.md");
  fs.writeFileSync(file, "x");
  assert.deepEqual(collectPlanFiles(file), [file]);
});

test("collectPlanFiles returns plan.md then phase files in name order", () => {
  const root = makeTempDir();
  const dir = writePlan(root, "p", ["phase-02-b.md", "plan.md", "phase-01-a.md", "notes.md"], 1000);
  assert.deepEqual(
    collectPlanFiles(dir).map((file) => path.basename(file)),
    ["plan.md", "phase-01-a.md", "phase-02-b.md"]
  );
});

test("collectPlanFiles rejects a missing path and a directory without plan.md", () => {
  const root = makeTempDir();
  assert.throws(() => collectPlanFiles(path.join(root, "missing")), /not found/);
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  assert.throws(() => collectPlanFiles(empty), /No plan\.md/);
});

const WHEN = new Date(2026, 9, 6, 11, 19);

test("planDirName builds a local-time stamp and an ascii slug", () => {
  assert.equal(planDirName("Add a version flag", WHEN), "261006-1119-add-a-version-flag");
  assert.equal(planDirName("lên plan cải tiến đường dẫn", WHEN), "261006-1119-len-plan-cai-tien-duong-dan");
  assert.equal(planDirName("ĐÀ NẴNG", WHEN), "261006-1119-da-nang");
});

test("planDirName falls back for empty or symbol-only requests and caps long slugs at a word boundary", () => {
  assert.equal(planDirName("", WHEN), "261006-1119-dsh-plan");
  assert.equal(planDirName("?!... ---", WHEN), "261006-1119-dsh-plan");
  const slug = planDirName("improve the session cleanup so that every workspace gets cleaned up properly", WHEN).slice("261006-1119-".length);
  assert.ok(slug.length <= 40, slug);
  assert.doesNotMatch(slug, /-$/);
  assert.equal(slug, "improve-the-session-cleanup-so-that");
});

test("savePlanFile creates plans/ when missing and numbers a colliding directory", () => {
  const root = makeTempDir();
  const first = savePlanFile(root, "do it", "# A\n\nbody\n\n", WHEN);
  const second = savePlanFile(root, "do it", "# B", WHEN);

  assert.equal(first, path.join("plans", "261006-1119-do-it", "plan.md"));
  assert.equal(second, path.join("plans", "261006-1119-do-it-2", "plan.md"));
  assert.equal(fs.readFileSync(path.join(root, first), "utf8"), "# Plan: do it\n\n# A\n\nbody\n");
  assert.equal(findLatestPlanDir(root) !== null, true);
});
