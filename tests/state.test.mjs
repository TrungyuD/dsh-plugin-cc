import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  forgetSessionWorkspaces,
  listSessionWorkspaces,
  pruneSessionIndex,
  registerSessionWorkspace,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/dsh/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  let stateDir;
  try {
    stateDir = resolveStateDir(workspace);
  } finally {
    if (previousPluginDataDir != null) {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

function withPluginData(fn) {
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn(pluginData);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = saved;
  }
}

test("the session index keeps one marker per workspace and lists every workspace of a session", () => {
  withPluginData(() => {
    const first = fs.realpathSync(makeTempDir());
    const second = fs.realpathSync(makeTempDir());
    registerSessionWorkspace("claude-A", first);
    registerSessionWorkspace("claude-A", first);
    registerSessionWorkspace("claude-A", second);
    registerSessionWorkspace("claude-B", second);

    assert.deepEqual(listSessionWorkspaces("claude-A").sort(), [first, second].sort());
    assert.deepEqual(listSessionWorkspaces("claude-B"), [second]);
    assert.deepEqual(listSessionWorkspaces("claude-unknown"), []);
  });
});

test("forgetSessionWorkspaces removes only that session's markers", () => {
  withPluginData(() => {
    const workspace = fs.realpathSync(makeTempDir());
    registerSessionWorkspace("claude-A", workspace);
    registerSessionWorkspace("claude-B", workspace);
    forgetSessionWorkspaces("claude-A");
    forgetSessionWorkspaces("claude-A");

    assert.deepEqual(listSessionWorkspaces("claude-A"), []);
    assert.deepEqual(listSessionWorkspaces("claude-B"), [workspace]);
  });
});

test("pruneSessionIndex drops only session markers older than the limit", () => {
  withPluginData((pluginData) => {
    const workspace = fs.realpathSync(makeTempDir());
    registerSessionWorkspace("claude-old", workspace);
    registerSessionWorkspace("claude-new", workspace);
    const sessionsDir = path.join(pluginData, "state", "sessions");
    const oldDir = createHash("sha256").update("claude-old").digest("hex").slice(0, 16);
    const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(path.join(sessionsDir, oldDir), tenDaysAgo, tenDaysAgo);

    pruneSessionIndex(7 * 24 * 3600 * 1000);

    assert.deepEqual(listSessionWorkspaces("claude-old"), []);
    assert.deepEqual(listSessionWorkspaces("claude-new"), [workspace]);
  });
});

test("pruneSessionIndex and listSessionWorkspaces are quiet when nothing is indexed", () => {
  withPluginData(() => {
    pruneSessionIndex(1000);
    assert.deepEqual(listSessionWorkspaces("claude-A"), []);
  });
});
