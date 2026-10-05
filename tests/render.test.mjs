import test from "node:test";
import assert from "node:assert/strict";

import { renderCancelReport, renderRunResult, renderStatusReport, renderStoredJobResult } from "../plugins/dsh/scripts/lib/render.mjs";

test("renderRunResult prints the final text verbatim followed by the footer", () => {
  const out = renderRunResult({
    finalText: "Verdict: approve\n\nAll good.",
    dshSessionId: "session-1",
    model: "deepseek-flash",
    permissionMode: "read-only"
  });
  assert.equal(out, "Verdict: approve\n\nAll good.\n\ndsh session: session-1 · model: deepseek-flash · mode: read-only\n");
});

test("renderRunResult reports an error when there is no final text", () => {
  const out = renderRunResult({ title: "dsh", errorMessage: "boom", dshSessionId: "s", model: "m", permissionMode: "read-only" });
  assert.match(out, /^dsh failed: boom\n/);
});

test("renderStoredJobResult returns the stored rendered output", () => {
  assert.equal(renderStoredJobResult({ id: "j" }, { rendered: "hello\n" }), "hello\n");
});

test("renderStoredJobResult falls back to job details with the resume command", () => {
  const out = renderStoredJobResult({ id: "j1", status: "failed", errorMessage: "bad", dshSessionId: "session-2" }, null);
  assert.match(out, /Job: j1/);
  assert.match(out, /Resume in dsh: dsh tui --resume session-2/);
  assert.match(out, /bad/);
});

test("renderStatusReport lists active jobs in a table with cancel actions", () => {
  const out = renderStatusReport({
    running: [{ id: "task-1", kindLabel: "rescue", status: "running", phase: "investigating", elapsed: "3s", summary: "fix it" }],
    latestFinished: null,
    recent: []
  });
  assert.match(out, /\| task-1 \| rescue \| running \| investigating \| 3s \|/);
  assert.match(out, /\/dsh:cancel task-1/);
});

test("renderStatusReport says when no jobs exist", () => {
  assert.match(renderStatusReport({ running: [], latestFinished: null, recent: [] }), /No jobs recorded yet\./);
});

test("renderCancelReport names the job", () => {
  assert.match(renderCancelReport({ id: "task-1", title: "dsh Rescue" }), /Cancelled task-1\./);
});
