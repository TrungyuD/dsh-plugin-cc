import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { collectReviewContext, resolveReviewTarget } from "../plugins/dsh/scripts/lib/review-target.mjs";

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function makeRepo() {
  const root = fs.realpathSync(makeTempDir());
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

test("auto reviews the working tree when a tracked file has an unstaged edit", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
  const target = resolveReviewTarget(root);
  assert.equal(target.mode, "working-tree");
  assert.equal(target.label, "working tree");
  const context = collectReviewContext(root, target);
  assert.equal(context.empty, false);
  assert.deepEqual(context.files, [{ path: "a.txt", status: "M" }]);
  assert.match(context.body, /\+two/);
});

test("auto reviews the working tree for an untracked file and includes its content", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "new.txt"), "brand new\n");
  const target = resolveReviewTarget(root);
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(root, target);
  assert.deepEqual(context.files, [{ path: "new.txt", status: "?" }]);
  assert.match(context.body, /<untracked path="new\.txt">\nbrand new\n<\/untracked>/);
});

test("staged and unstaged edits appear in separate sections", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "staged\n");
  git(root, "add", "a.txt");
  fs.writeFileSync(path.join(root, "a.txt"), "staged\nunstaged\n");
  const context = collectReviewContext(root, resolveReviewTarget(root));
  assert.match(context.body, /<diff section="staged">[\s\S]*\+staged[\s\S]*<\/diff>/);
  assert.match(context.body, /<diff section="unstaged">[\s\S]*\+unstaged[\s\S]*<\/diff>/);
  assert.equal(context.fileCount, 1);
});

test("auto on a clean feature branch reviews the branch against main", () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(root, "b.txt"), "feature work\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "add feature work");
  const target = resolveReviewTarget(root);
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.label, "branch feature against main");
  const context = collectReviewContext(root, target);
  assert.deepEqual(context.files, [{ path: "b.txt", status: "A" }]);
  assert.match(context.body, /<commits>\n[0-9a-f]+ add feature work\n<\/commits>/);
  assert.match(context.body, /\+feature work/);
});

test("a clean main branch has nothing to review", () => {
  const root = makeRepo();
  const context = collectReviewContext(root, resolveReviewTarget(root));
  assert.equal(context.empty, true);
  assert.equal(context.fileCount, 0);
});

test("the branch review leaves out uncommitted edits", () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(root, "a.txt"), "uncommitted\n");
  const context = collectReviewContext(root, resolveReviewTarget(root, { scope: "branch" }));
  assert.equal(context.empty, true);
});

test("the default branch comes from origin/HEAD when it exists", () => {
  const remote = fs.realpathSync(makeTempDir());
  initGitRepo(remote);
  fs.writeFileSync(path.join(remote, "a.txt"), "one\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "initial");
  const parent = fs.realpathSync(makeTempDir());
  const clone = path.join(parent, "clone");
  git(parent, "clone", "-q", remote, clone);
  git(clone, "checkout", "-q", "-b", "feature");
  assert.equal(resolveReviewTarget(clone, { scope: "branch" }).baseRef, "origin/main");
});

test("branch review without a detectable default branch explains what to pass", () => {
  const root = makeRepo();
  git(root, "branch", "-m", "work");
  assert.throws(() => resolveReviewTarget(root, { scope: "branch" }), /Cannot detect the default branch.*--base/);
});

test("--base picks the base ref and validates it", () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(root, "b.txt"), "x\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "work");
  const target = resolveReviewTarget(root, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.throws(() => resolveReviewTarget(root, { base: "nope" }), /Unknown ref: nope/);
  assert.throws(() => resolveReviewTarget(root, { base: "main", scope: "working-tree" }), /--base only applies to branch review/);
  assert.throws(() => resolveReviewTarget(root, { scope: "weird" }), /Unsupported review scope "weird"/);
});

test("a base ref that starts with a dash is rejected, never read as a git option", () => {
  const root = makeRepo();
  assert.throws(() => resolveReviewTarget(root, { base: "--output=/tmp/x" }), /Unknown ref: --output=\/tmp\/x/);
  assert.throws(() => resolveReviewTarget(root, { base: "-x" }), /Unknown ref: -x/);
});

test("untracked binary, oversized and symlinked files are listed with a reason, not inlined", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(100));
  fs.symlinkSync("a.txt", path.join(root, "link"));
  const context = collectReviewContext(root, resolveReviewTarget(root), { maxUntrackedBytes: 50 });
  assert.match(context.body, /<untracked path="blob\.bin">\n\(skipped: binary\)\n/);
  assert.match(context.body, /<untracked path="big\.txt">\n\(skipped: 100 bytes\)\n/);
  assert.match(context.body, /<untracked path="link">\n\(skipped: not a regular file\)\n/);
  assert.equal(context.fileCount, 3);
});

test("a change over the cap falls back to the diffstat and file names", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), `${"changed line\n".repeat(100)}`);
  const context = collectReviewContext(root, resolveReviewTarget(root), { maxDiffBytes: 200 });
  assert.equal(context.truncated, true);
  assert.match(context.body, /Read the changed files yourself/);
  assert.match(context.body, /<diffstat>[\s\S]*a\.txt[\s\S]*<\/diffstat>/);
  assert.match(context.body, /<changed_files>\nM\ta\.txt\n<\/changed_files>/);
  assert.doesNotMatch(context.body, /changed line/);
});

test("repository diff tools and textconv drivers never run while collecting", () => {
  const root = makeRepo();
  const marker = path.join(root, "..", `marker-${path.basename(root)}`);
  const script = path.join(makeTempDir(), "tool.sh");
  writeExecutable(script, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  git(root, "config", "diff.external", script);
  git(root, "config", "diff.danger.textconv", script);
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt diff=danger\n");
  fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");

  const context = collectReviewContext(root, resolveReviewTarget(root));
  assert.match(context.body, /\+two/);
  assert.equal(fs.existsSync(marker), false);
});

test("a rename is reported once under the new name", () => {
  const root = makeRepo();
  git(root, "mv", "a.txt", "renamed.txt");
  const context = collectReviewContext(root, resolveReviewTarget(root));
  assert.deepEqual(context.files, [{ path: "renamed.txt", status: "R" }]);
});

test("an fsmonitor hook from the repository config never runs while collecting", () => {
  const root = makeRepo();
  const marker = path.join(root, "..", `fsmonitor-${path.basename(root)}`);
  const script = path.join(makeTempDir(), "monitor.sh");
  writeExecutable(script, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  git(root, "config", "core.fsmonitor", script);
  fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");

  const context = collectReviewContext(root, resolveReviewTarget(root));
  assert.match(context.body, /\+two/);
  assert.equal(fs.existsSync(marker), false);
});

test("an unreadable untracked file is listed as skipped instead of failing the review", { skip: process.getuid?.() === 0 }, () => {
  const root = makeRepo();
  const secret = path.join(root, "locked.txt");
  fs.writeFileSync(secret, "hidden\n");
  fs.chmodSync(secret, 0o000);
  try {
    const context = collectReviewContext(root, resolveReviewTarget(root));
    assert.match(context.body, /<untracked path="locked\.txt">\n\(skipped: EACCES\)\n/);
  } finally {
    fs.chmodSync(secret, 0o644);
  }
});

test("the large-change fallback caps the file list and keeps the total near the limit", () => {
  const root = makeRepo();
  for (let index = 0; index < 400; index += 1) {
    fs.writeFileSync(path.join(root, `file-${String(index).padStart(4, "0")}.txt`), "x\n");
  }
  const context = collectReviewContext(root, resolveReviewTarget(root), { maxDiffBytes: 1000 });
  assert.equal(context.truncated, true);
  assert.equal(context.fileCount, 400);
  assert.match(context.body, /\.\.\. and \d+ more files/);
  assert.ok(Buffer.byteLength(context.body) < 3000, `body is ${Buffer.byteLength(context.body)} bytes`);
});

test("a path with a newline or angle brackets cannot close the prompt tag", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'odd">\nname.txt'), "text\n");
  const context = collectReviewContext(root, resolveReviewTarget(root));
  assert.match(context.body, /<untracked path="odd%22%3E%0Aname\.txt">/);
});

test("a repository with no commits reviews the working tree and an empty base is rejected", () => {
  const root = fs.realpathSync(makeTempDir());
  initGitRepo(root);
  const clean = collectReviewContext(root, resolveReviewTarget(root));
  assert.equal(clean.empty, true);
  fs.writeFileSync(path.join(root, "first.txt"), "first\n");
  const target = resolveReviewTarget(root);
  assert.equal(target.mode, "working-tree");
  assert.deepEqual(collectReviewContext(root, target).files, [{ path: "first.txt", status: "?" }]);
  assert.throws(() => resolveReviewTarget(root, { base: "" }), /Unknown ref: /);
});

test("a detached HEAD is labelled as such in a branch review", () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(root, "b.txt"), "x\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "work");
  git(root, "checkout", "-q", "--detach");
  const target = resolveReviewTarget(root, { scope: "branch" });
  assert.equal(target.label, "detached HEAD against main");
  assert.equal(collectReviewContext(root, target).fileCount, 1);
});
