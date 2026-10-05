import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { collectPlanFiles, findLatestPlanDir } from "../plugins/dsh/scripts/lib/plans.mjs";

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
