import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDsh } from "./fake-dsh-fixture.mjs";
import { isPidAlive, makeTempDir, waitFor } from "./helpers.mjs";
import { runHeadless } from "../plugins/dsh/scripts/lib/dsh.mjs";
import { terminateProcessTree } from "../plugins/dsh/scripts/lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/dsh/scripts/lib/state.mjs";
import {
  createJobProgressUpdater,
  recordDshPid,
  runTrackedJob
} from "../plugins/dsh/scripts/lib/tracked-jobs.mjs";

function setup() {
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  const workspace = makeTempDir();
  const job = { id: "job-1", kind: "task", jobClass: "task", workspaceRoot: workspace, cwd: workspace, status: "queued" };
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);
  return { workspace, job };
}

const contract = (extra = {}) => ({
  exitStatus: 0,
  payload: { finalText: "done" },
  rendered: "done\n",
  summary: "did it",
  dshSessionId: "session-1",
  model: "deepseek-flash",
  permissionMode: "workspace-write",
  cwd: "/work",
  ...extra
});

test("runTrackedJob persists every runner field in both stores on success", async () => {
  const { workspace, job } = setup();
  await runTrackedJob(job, async () => contract());

  const stored = readJobFile(resolveJobFile(workspace, job.id));
  const indexed = listJobs(workspace).find((entry) => entry.id === job.id);
  for (const record of [stored, indexed]) {
    assert.equal(record.status, "completed");
    assert.equal(record.dshSessionId, "session-1");
    assert.equal(record.model, "deepseek-flash");
    assert.equal(record.permissionMode, "workspace-write");
    assert.equal(record.cwd, "/work");
    assert.equal(record.pid, null);
  }
  assert.equal(stored.rendered, "done\n");
  assert.equal(indexed.summary, "did it");
});

test("runTrackedJob records failure for a non-zero exit and for a thrown runner", async () => {
  const { workspace, job } = setup();
  await runTrackedJob(job, async () => contract({ exitStatus: 1 }));
  assert.equal(listJobs(workspace)[0].status, "failed");

  const second = { ...job, id: "job-2" };
  upsertJob(workspace, second);
  writeJobFile(workspace, second.id, second);
  await assert.rejects(
    runTrackedJob(second, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  const stored = readJobFile(resolveJobFile(workspace, second.id));
  assert.equal(stored.status, "failed");
  assert.equal(stored.errorMessage, "boom");
});

test("a job cancelled while running stays cancelled when the runner completes", async () => {
  const { workspace, job } = setup();
  await runTrackedJob(job, async () => {
    const cancelled = { ...readJobFile(resolveJobFile(workspace, job.id)), status: "cancelled" };
    writeJobFile(workspace, job.id, cancelled);
    upsertJob(workspace, { id: job.id, status: "cancelled" });
    return contract();
  });
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "cancelled");
  assert.equal(listJobs(workspace)[0].status, "cancelled");
});

test("a job cancelled before it starts never runs the runner", async () => {
  const { workspace, job } = setup();
  writeJobFile(workspace, job.id, { ...job, status: "cancelled" });
  upsertJob(workspace, { id: job.id, status: "cancelled" });
  let ran = false;
  await assert.rejects(
    runTrackedJob(job, async () => {
      ran = true;
      return contract();
    }),
    /cancelled before it started/
  );
  assert.equal(ran, false);
  assert.equal(listJobs(workspace)[0].status, "cancelled");
});

test("recordDshPid stores the pid in both stores unless the job is cancelled", () => {
  const { workspace, job } = setup();
  assert.equal(recordDshPid(workspace, job.id, 4242), true);
  assert.equal(listJobs(workspace)[0].dshPid, 4242);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).dshPid, 4242);

  writeJobFile(workspace, job.id, { ...job, status: "cancelled" });
  assert.equal(recordDshPid(workspace, job.id, 5555), false);
});

test("the progress updater records the phase and dsh session id", () => {
  const { workspace, job } = setup();
  const update = createJobProgressUpdater(workspace, job.id);
  update({ phase: "investigating", dshSessionId: "session-9" });
  const indexed = listJobs(workspace)[0];
  assert.equal(indexed.phase, "investigating");
  assert.equal(indexed.dshSessionId, "session-9");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).dshSessionId, "session-9");
});

test("terminating the dsh process group leaves no grandchild alive", async () => {
  const fake = installFakeDsh();
  const pidFile = path.join(makeTempDir(), "child.pid");
  Object.assign(process.env, fake.env({ FAKE_DSH_MODE: "spawn-child", FAKE_DSH_CHILD_PIDFILE: pidFile }));

  let dshPid = null;
  const run = runHeadless({
    cwd: makeTempDir(),
    prompt: "sleep",
    permissionMode: "read-only",
    onSpawn: (pid) => {
      dshPid = pid;
    }
  });

  const grandchild = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")));
  assert.ok(isPidAlive(grandchild));
  const outcome = terminateProcessTree(dshPid);
  assert.equal(outcome.method, "process-group");
  const result = await run;
  assert.equal(result.exitStatus, 1);
  await waitFor(() => !isPidAlive(grandchild));
});
