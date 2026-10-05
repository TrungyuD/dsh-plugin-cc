import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installFakeDsh } from "./fake-dsh-fixture.mjs";
import { isPidAlive, makeTempDir, run, waitFor } from "./helpers.mjs";
import { extractVerdict } from "../plugins/dsh/scripts/dsh-companion.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/dsh/scripts/lib/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "dsh", "scripts", "dsh-companion.mjs");
const HOOK = path.join(ROOT, "plugins", "dsh", "scripts", "session-lifecycle-hook.mjs");

function nodeOnlyPath() {
  const dir = makeTempDir();
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
}

function setup(extraEnv = {}) {
  const fake = installFakeDsh();
  const workspace = fs.realpathSync(makeTempDir());
  const pluginData = makeTempDir();
  const env = fake.env({ CLAUDE_PLUGIN_DATA: pluginData, DSH_COMPANION_SESSION_ID: "claude-A", ...extraEnv });
  const companion = (args, options = {}) =>
    run(process.execPath, [COMPANION, ...args], { cwd: workspace, env: { ...env, ...(options.env ?? {}) }, input: options.input });
  const jobs = () => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    try {
      return listJobs(workspace);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = saved;
    }
  };
  const withState = (fn) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = saved;
    }
  };
  return { fake, workspace, pluginData, env, companion, jobs, withState };
}

test("plan runs read-only and returns dsh's output with the footer", () => {
  const { fake, companion } = setup({ FAKE_DSH_FINAL: "# Plan\n\nDo it." });
  const result = companion(["plan", "add", "a", "flag"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Plan\n\nDo it\.\n\ndsh session: session-fake-0001 · model: deepseek-flash · mode: read-only\n$/);

  const [call] = fake.calls();
  assert.equal(call.env.DSH_PERMISSION_MODE, "read-only");
  assert.match(call.patch, /mode: read-only/);
  assert.match(call.patch, /defaultPreset: read-only/);
  assert.match(call.stdin, /add a flag/);
  assert.match(call.stdin, /read-only/);
});

test("plan with no request exits 2, and --model flash/pro resolve to model names", () => {
  const { fake, companion } = setup();
  const missing = companion(["plan"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /what to plan/);

  const pro = companion(["plan", "--model", "pro", "x"]);
  assert.match(pro.stdout, /model: deepseek-v4-pro/);
  assert.match(fake.calls().at(-1).patch, /deepseek-v4-pro/);
  const flash = companion(["plan", "--model", "flash", "x"]);
  assert.match(flash.stdout, /model: deepseek-flash/);
});

test("stray --wait and --background flags never become prompt text", () => {
  const { fake, companion } = setup();
  companion(["plan", "--wait --background add a flag"]);
  assert.doesNotMatch(fake.calls()[0].stdin, /--wait|--background/);
});

test("review-plan inlines a directory as plan.md then phases, applies focus, and records the verdict", () => {
  const { fake, workspace, companion, jobs } = setup({ FAKE_DSH_FINAL: "Verdict: needs-changes\n\n1. problem" });
  const dir = path.join(workspace, "plans", "p1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "phase-02-b.md"), "PHASE-TWO");
  fs.writeFileSync(path.join(dir, "plan.md"), "PLAN-INDEX");
  fs.writeFileSync(path.join(dir, "phase-01-a.md"), "PHASE-ONE");

  const result = companion(["review-plan", "plans/p1", "focus", "on", "tests"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Verdict: needs-changes/);

  const stdin = fake.calls()[0].stdin;
  assert.ok(stdin.indexOf("PLAN-INDEX") < stdin.indexOf("PHASE-ONE"));
  assert.ok(stdin.indexOf("PHASE-ONE") < stdin.indexOf("PHASE-TWO"));
  assert.match(stdin, /path="plans\/p1\/plan\.md"/);
  assert.match(stdin, /focus on tests/);
  assert.equal(fake.calls()[0].env.DSH_PERMISSION_MODE, "read-only");
  assert.equal(jobs()[0].summary, "Verdict: needs-changes (plans/p1)");
  assert.equal(jobs()[0].kind, "review-plan");
});

test("review-plan reviews a single file", () => {
  const { fake, workspace, companion } = setup({ FAKE_DSH_FINAL: "Verdict: approve" });
  fs.writeFileSync(path.join(workspace, "one.md"), "ONLY-FILE");
  const result = companion(["review-plan", "one.md"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fake.calls()[0].stdin, /ONLY-FILE/);
});

test("review-plan exits 2 for a missing path, a directory without plan.md, and no argument", () => {
  const { workspace, companion, fake } = setup();
  assert.equal(companion(["review-plan", "nope.md"]).status, 2);
  fs.mkdirSync(path.join(workspace, "empty"));
  const empty = companion(["review-plan", "empty"]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /No plan\.md/);
  assert.equal(companion(["review-plan"]).status, 2);
  assert.equal(fake.calls().length, 0, "dsh is never started for a bad path");
});

test("extractVerdict reads the first line and reports unknown when it is missing", () => {
  assert.equal(extractVerdict("Verdict: approve\nrest"), "approve");
  assert.equal(extractVerdict("\n\nverdict: Needs-Changes"), "needs-changes");
  assert.equal(extractVerdict("Verdict: reject"), "reject");
  assert.equal(extractVerdict("Looks fine to me"), "unknown");
  assert.equal(extractVerdict("Verdict: maybe"), "unknown");
  assert.equal(extractVerdict(""), "unknown");
});

test("a missing verdict shows as unknown in the job summary and the output is not rewritten", () => {
  const { workspace, companion, jobs } = setup({ FAKE_DSH_FINAL: "No verdict here" });
  fs.writeFileSync(path.join(workspace, "p.md"), "x");
  const result = companion(["review-plan", "p.md"]);
  assert.match(result.stdout, /^No verdict here\n/);
  assert.match(jobs()[0].summary, /^Verdict: unknown/);
});

test("plan-candidates returns the latest plan dir or null", () => {
  const { workspace, companion } = setup();
  assert.deepEqual(JSON.parse(companion(["plan-candidates", "--json"]).stdout), { latest: null });
  fs.mkdirSync(path.join(workspace, "plans", "260101-a"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "plans", "260101-a", "plan.md"), "x");
  assert.deepEqual(JSON.parse(companion(["plan-candidates", "--json"]).stdout), { latest: path.join("plans", "260101-a") });
});

test("DSH_COMPANION_CHILD=1 makes the companion a silent no-op", () => {
  const { fake, companion } = setup();
  const result = companion(["plan", "x"], { env: { DSH_COMPANION_CHILD: "1" } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(fake.calls().length, 0);
});

test("a dsh error event fails the run with exit 1 and a failed job", () => {
  const { companion, jobs } = setup({ FAKE_DSH_MODE: "error" });
  const result = companion(["plan", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dsh failed: fake dsh failure/);
  assert.equal(jobs()[0].status, "failed");
});

test("the companion fails clearly when dsh is not installed", () => {
  const { companion } = setup();
  const result = companion(["plan", "x"], { env: { PATH: nodeOnlyPath() } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dsh is not installed/);
});

// ----- rescue (task)

test("task defaults to read-only and --write selects workspace-write in env and patch", () => {
  const { fake, companion } = setup();
  companion(["task", "look", "around"]);
  companion(["task", "--write", "fix", "it"]);
  const [ro, rw] = fake.calls();
  assert.equal(ro.env.DSH_PERMISSION_MODE, "read-only");
  assert.match(ro.patch, /mode: read-only/);
  assert.equal(rw.env.DSH_PERMISSION_MODE, "workspace-write");
  assert.match(rw.patch, /mode: workspace-write/);
  assert.match(rw.patch, /defaultPreset: workspace-write/);
  assert.equal(rw.stdin, "fix it");
});

test("task rejects --write together with --read-only and an empty prompt", () => {
  const { companion } = setup();
  assert.equal(companion(["task", "--write", "--read-only", "x"]).status, 2);
  assert.equal(companion(["task"], { input: "" }).status, 2);
});

test("task --resume-last passes the stored session id, mode and cwd", () => {
  const { fake, workspace, companion } = setup();
  companion(["task", "--write", "first"]);
  const result = companion(["task", "--resume-last", "second"]);
  assert.equal(result.status, 0, result.stderr);
  const [, second] = fake.calls();
  assert.deepEqual(second.argv.slice(-3, -1), ["--session-id", "session-fake-0001"]);
  assert.equal(second.env.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(second.cwd, workspace);
});

test("task --resume-last exits 2 on a mode mismatch and when nothing can be resumed", () => {
  const { companion, fake } = setup();
  const none = companion(["task", "--resume-last", "x"]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /No previous dsh rescue session for this Claude session in this directory\./);

  companion(["task", "--write", "first"]);
  const mismatch = companion(["task", "--resume-last", "--read-only", "second"]);
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /This dsh session runs in workspace-write; start a new one with --fresh to change permissions\./);
  assert.equal(fake.calls().length, 1, "dsh is not started for a rejected resume");
});

test("the resume resolver is scoped by Claude session", () => {
  const { workspace, companion } = setup();
  companion(["task", "--write", "from A"]);
  const other = companion(["task-resume-candidate", "--json"], { env: { DSH_COMPANION_SESSION_ID: "claude-B" } });
  assert.equal(JSON.parse(other.stdout).available, false);
  const same = companion(["task-resume-candidate", "--json"]);
  assert.equal(JSON.parse(same.stdout).available, true);
  assert.ok(workspace);
});

test("the resume resolver is scoped by cwd", () => {
  const { workspace, companion } = setup();
  companion(["task", "--write", "in root"]);
  const sub = path.join(workspace, "sub");
  fs.mkdirSync(sub);
  const inSub = companion(["task-resume-candidate", "--json", "--cwd", sub]);
  assert.equal(JSON.parse(inSub.stdout).available, false);
});

test("a running task blocks resume, and task-resume-candidate and --resume-last choose the same job", () => {
  const { workspace, companion, withState } = setup();
  companion(["task", "--write", "first"]);
  const candidate = JSON.parse(companion(["task-resume-candidate", "--json"]).stdout);

  withState(() => {
    upsertJob(workspace, {
      id: "task-running",
      kind: "task",
      status: "running",
      cwd: workspace,
      sessionId: "claude-A",
      workspaceRoot: workspace
    });
  });
  const blocked = companion(["task", "--resume-last", "again"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Task task-running is still running/);
  assert.match(companion(["task-resume-candidate", "--json"]).stderr, /still running/);

  // Once the newer run failed without ever getting a dsh session, an older session is not offered in its place.
  withState(() => upsertJob(workspace, { id: "task-running", status: "failed" }));
  assert.equal(JSON.parse(companion(["task-resume-candidate", "--json"]).stdout).available, false);
  assert.equal(companion(["task", "--resume-last", "again"]).status, 2);

  withState(() => upsertJob(workspace, { id: "task-running", status: "failed", dshSessionId: "session-newer", permissionMode: "workspace-write" }));
  const after = JSON.parse(companion(["task-resume-candidate", "--json"]).stdout);
  assert.equal(after.jobId, "task-running");
  assert.notEqual(after.jobId, candidate.jobId);
  assert.equal(after.dshSessionId, "session-newer");
});

// ----- status, result, cancel, setup

test("status lists jobs newest first and result returns the stored output with the footer", () => {
  const { companion } = setup({ FAKE_DSH_FINAL: "answer-one" });
  companion(["plan", "one"]);
  companion(["task", "--write", "two"]);

  const status = companion(["status"]).stdout;
  assert.match(status, /Latest finished:\n- task-/);

  const result = companion(["result"]);
  assert.match(result.stdout, /^answer-one\n\ndsh session: session-fake-0001 · model: deepseek-flash · mode: workspace-write\n$/);
  assert.match(companion(["status", "--json"]).stdout, /"latestFinished"/);
});

test("cancel kills the dsh process group and leaves no live process", async () => {
  const { workspace, env, companion, jobs } = setup({});
  const pidFile = path.join(makeTempDir(), "child.pid");
  const child = spawn("node", [COMPANION, "task", "--write", "sleep a long time"], {
    cwd: workspace,
    env: { ...env, FAKE_DSH_MODE: "spawn-child", FAKE_DSH_CHILD_PIDFILE: pidFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  const grandchild = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")));
  const job = await waitFor(() => jobs().find((entry) => entry.dshPid && entry.status === "running"));
  assert.ok(isPidAlive(job.dshPid));

  const cancel = companion(["cancel"]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /Cancelled task-/);
  await exited;
  await waitFor(() => !isPidAlive(grandchild));
  await waitFor(() => !isPidAlive(job.dshPid));
  assert.equal(jobs()[0].status, "cancelled", "a run that finishes after cancel stays cancelled");
});

test("setup reports dsh as missing when PATH has no dsh, and ready when the smoke run answers", () => {
  const { companion } = setup({ FAKE_DSH_FINAL: "OK" });
  const missing = JSON.parse(companion(["setup", "--json"], { env: { PATH: nodeOnlyPath() } }).stdout);
  assert.equal(missing.dsh.available, false);
  assert.equal(missing.ready, false);
  assert.match(missing.nextSteps.join("\n"), /npm install -g @deepseek-ai\/dsh/);

  const ready = JSON.parse(companion(["setup", "--json"]).stdout);
  assert.equal(ready.dsh.available, true);
  assert.equal(ready.dsh.supported, true);
  assert.equal(ready.auth.ok, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.defaultModel, "deepseek-flash");
});

test("setup flags an unsupported dsh version and a failed smoke run", () => {
  const { companion } = setup({ FAKE_DSH_VERSION: "0.3.1", FAKE_DSH_MODE: "error" });
  const report = JSON.parse(companion(["setup", "--json"]).stdout);
  assert.equal(report.dsh.supported, false);
  assert.equal(report.auth.ok, false);
  assert.equal(report.ready, false);
  assert.match(report.nextSteps.join("\n"), /dsh-tui/);
});

// ----- hooks

function runHook(event, input, env) {
  return run(process.execPath, [HOOK, event], { env, input: JSON.stringify(input) });
}

test("SessionStart exports the session id and plugin data dir, and companion calls share one state dir", () => {
  const { workspace, pluginData, env, companion } = setup();
  const envFile = path.join(makeTempDir(), "env.sh");
  fs.writeFileSync(envFile, "");
  const hookEnv = { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData };
  delete hookEnv.DSH_COMPANION_SESSION_ID;
  assert.equal(runHook("SessionStart", { session_id: "claude-Z", cwd: workspace }, hookEnv).status, 0);

  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export DSH_COMPANION_SESSION_ID='claude-Z'/);
  assert.match(exported, new RegExp(`export CLAUDE_PLUGIN_DATA='${pluginData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));

  // A companion run that sees the exported variables writes to the same state dir the hook later reads.
  const result = companion(["plan", "x"], { env: { DSH_COMPANION_SESSION_ID: "claude-Z" } });
  assert.equal(result.status, 0, result.stderr);
  const end = runHook("SessionEnd", { session_id: "claude-Z", cwd: workspace }, hookEnv);
  assert.equal(end.status, 0, end.stderr);
  // The finished job is untouched by SessionEnd, which only cancels running jobs.
  assert.equal(JSON.parse(companion(["status", "--json"], { env: { DSH_COMPANION_SESSION_ID: "claude-Z" } }).stdout).latestFinished.status, "completed");
});

test("SessionStart skips quietly when CLAUDE_ENV_FILE is unset", () => {
  const { workspace, env } = setup();
  const hookEnv = { ...env };
  delete hookEnv.CLAUDE_ENV_FILE;
  assert.equal(runHook("SessionStart", { session_id: "s", cwd: workspace }, hookEnv).status, 0);
});

test("SessionEnd cancels only that session's running jobs and kills their process groups", async () => {
  const { workspace, pluginData, env, withState } = setup();
  const sleeper = (sessionId) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "fake-dsh-hook-sleeper"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    withState(() => {
      const job = {
        id: `task-${sessionId}`,
        kind: "task",
        status: "running",
        sessionId,
        workspaceRoot: workspace,
        cwd: workspace,
        dshPid: child.pid
      };
      upsertJob(workspace, job);
      writeJobFile(workspace, job.id, job);
    });
    return child.pid;
  };
  const pidA = sleeper("claude-A");
  const pidB = sleeper("claude-B");

  try {
    const end = runHook("SessionEnd", { session_id: "claude-A", cwd: workspace }, { ...env, CLAUDE_PLUGIN_DATA: pluginData });
    assert.equal(end.status, 0, end.stderr);
    await waitFor(() => !isPidAlive(pidA));
    assert.ok(isPidAlive(pidB), "the other session's job is untouched");

    withState(() => {
      assert.equal(readJobFile(resolveJobFile(workspace, "task-claude-A")).status, "cancelled");
      assert.equal(listJobs(workspace).find((job) => job.id === "task-claude-B").status, "running");
    });
  } finally {
    for (const pid of [pidA, pidB]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("hooks are no-ops inside child runs", () => {
  const { workspace, env } = setup();
  const envFile = path.join(makeTempDir(), "env.sh");
  fs.writeFileSync(envFile, "");
  const result = runHook("SessionStart", { session_id: "s", cwd: workspace }, { ...env, DSH_COMPANION_CHILD: "1", CLAUDE_ENV_FILE: envFile });
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(envFile, "utf8"), "");
});

// ----- prompt templates

const PROMPTS_DIR = path.join(ROOT, "plugins", "dsh", "prompts");

test("the plan prompt carries the request placeholder, the six sections, and the read-only rule", () => {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, "plan.md"), "utf8");
  assert.match(text, /\{\{REQUEST\}\}/);
  for (const heading of ["Goal", "Context found", "Approach", "Phases", "Risks", "Open questions"]) {
    assert.match(text, new RegExp(`## ${heading}`));
  }
  assert.match(text, /read-only/);
});

test("the review-plan prompt instructs the Verdict first line and carries both placeholders", () => {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, "review-plan.md"), "utf8");
  assert.match(text, /\{\{FOCUS\}\}/);
  assert.match(text, /\{\{PLAN_FILES\}\}/);
  for (const verdict of ["approve", "needs-changes", "reject"]) {
    assert.match(text, new RegExp(`Verdict: ${verdict}`));
  }
  assert.match(text, /read-only/);
});

test("the rendered prompts sent to dsh contain the instructions and no unfilled placeholders", () => {
  const { fake, workspace, companion } = setup();
  fs.writeFileSync(path.join(workspace, "p.md"), "PLAN-BODY");
  companion(["plan", "build it"]);
  companion(["review-plan", "p.md", "check security"]);
  const [plan, review] = fake.calls().map((call) => call.stdin);
  assert.match(plan, /## Open questions/);
  assert.match(plan, /build it/);
  assert.match(review, /Verdict: approve/);
  assert.match(review, /check security/);
  assert.match(review, /PLAN-BODY/);
  for (const stdin of [plan, review]) {
    assert.doesNotMatch(stdin, /\{\{[A-Z_]+\}\}/);
  }
});

// ----- hardening

test("words in the request are never read as companion options", () => {
  const { fake, workspace, companion } = setup();
  const sub = path.join(workspace, "sub");
  fs.mkdirSync(sub);
  companion(["task", "--write", "why does git -C .. status fail and what is --json for --cwd /etc"]);
  const [call] = fake.calls();
  assert.equal(call.cwd, workspace, "the run stays in the invoking directory");
  assert.equal(call.stdin, "why does git -C .. status fail and what is --json for --cwd /etc");
  assert.match(call.patch, new RegExp(`workspaceRoot: "${workspace.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"`));
});

test("a plan request that contains flag-looking words keeps them as text", () => {
  const { fake, companion } = setup();
  companion(["plan", "--model pro explain the --write flag"]);
  const [call] = fake.calls();
  assert.match(call.stdin, /explain the --write flag/);
  assert.match(call.patch, /deepseek-v4-pro/);
});

test("resume does not fall back to an older session when the newest rescue was cancelled without one", () => {
  const { workspace, companion, withState } = setup();
  companion(["task", "--write", "first"]);
  withState(() =>
    upsertJob(workspace, { id: "task-cancelled", kind: "task", status: "cancelled", cwd: workspace, sessionId: "claude-A", workspaceRoot: workspace })
  );
  assert.equal(JSON.parse(companion(["task-resume-candidate", "--json"]).stdout).available, false);
});

test("resume is not offered when the Claude session id is unknown", () => {
  const { companion } = setup();
  companion(["task", "--write", "first"]);
  const none = companion(["task-resume-candidate", "--json"], { env: { DSH_COMPANION_SESSION_ID: "" } });
  assert.equal(JSON.parse(none.stdout).available, false);
});

test("a job whose companion died is reconciled as failed instead of blocking resume", () => {
  const { workspace, companion, withState } = setup();
  companion(["task", "--write", "first"]);
  withState(() =>
    upsertJob(workspace, {
      id: "task-dead",
      kind: "task",
      status: "running",
      pid: 2147483000,
      cwd: workspace,
      sessionId: "claude-A",
      workspaceRoot: workspace
    })
  );
  const candidate = companion(["task-resume-candidate", "--json"]);
  assert.equal(candidate.status, 0, candidate.stderr);
  withState(() => assert.equal(listJobs(workspace).find((job) => job.id === "task-dead").status, "failed"));
});

test("concurrent state updates from several processes lose no jobs", async () => {
  const pluginData = makeTempDir();
  const workspace = fs.realpathSync(makeTempDir());
  const script = path.join(makeTempDir(), "writer.mjs");
  fs.writeFileSync(
    script,
    `import { upsertJob, writeJobFile } from ${JSON.stringify(path.join(ROOT, "plugins/dsh/scripts/lib/state.mjs"))};
const [workspace, tag] = process.argv.slice(2);
for (let i = 0; i < 25; i += 1) {
  upsertJob(workspace, { id: tag + "-" + i, status: "completed" });
  upsertJob(workspace, { id: tag + "-0", phase: "p" + i });
}`
  );
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const writers = ["a", "b", "c", "d"].map(
    (tag) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, workspace, tag], { env, stdio: "ignore" });
        child.on("close", resolve);
      })
  );
  assert.deepEqual(await Promise.all(writers), [0, 0, 0, 0]);
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    assert.equal(listJobs(workspace).length, 50, "the 50-job cap holds and no entry was lost to a race");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = saved;
  }
});

test("review-plan skips symlinked phase files and a symlinked plan.md", () => {
  const { fake, workspace, companion } = setup();
  const dir = path.join(workspace, "plans", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.md"), "REAL-PLAN");
  const secret = path.join(makeTempDir(), "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET");
  fs.symlinkSync(secret, path.join(dir, "phase-01-evil.md"));
  fs.symlinkSync(path.join(workspace, "nowhere"), path.join(dir, "phase-02-broken.md"));

  assert.equal(companion(["review-plan", "plans/p"]).status, 0);
  assert.match(fake.calls()[0].stdin, /REAL-PLAN/);
  assert.doesNotMatch(fake.calls()[0].stdin, /TOP-SECRET/);
  assert.equal(JSON.parse(companion(["plan-candidates", "--json"]).stdout).latest, path.join("plans", "p"));
});
