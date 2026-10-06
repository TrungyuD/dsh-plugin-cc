#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  CHILD_ENV,
  DEFAULT_MODEL,
  getDshAvailability,
  normalizeModel,
  runHeadless
} from "./lib/dsh.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { ensureGitRepository } from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  resolveResumableTask
} from "./lib/job-control.mjs";
import { collectPlanFiles, findLatestPlanDir, savePlanFile } from "./lib/plans.mjs";
import { binaryAvailable, processCommandIncludes, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/review-target.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult
} from "./lib/render.mjs";
import { generateJobId, registerSessionWorkspace, upsertJob, withStateLock, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  isJobCancelled,
  nowIso,
  recordDshPid,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const SMOKE_TIMEOUT_MS = 90000;
const READ_ONLY = "read-only";
const WORKSPACE_WRITE = "workspace-write";
const VERDICTS = ["approve", "needs-changes", "reject"];

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/dsh-companion.mjs setup [--json]",
      "  node scripts/dsh-companion.mjs plan [--model <flash|pro|name>] <request>",
      "  node scripts/dsh-companion.mjs review-plan [--model <flash|pro|name>] <plan-path> [focus text]",
      "  node scripts/dsh-companion.mjs plan-candidates --json",
      "  node scripts/dsh-companion.mjs code-review [--model <flash|pro|name>] [--base <ref>] [--scope auto|working-tree|branch] [focus text]",
      "  node scripts/dsh-companion.mjs code-review-target [--base <ref>] [--scope auto|working-tree|branch] [--json]",
      "  node scripts/dsh-companion.mjs task [--write|--read-only] [--resume-last] [--model <flash|pro|name>] <prompt>",
      "  node scripts/dsh-companion.mjs task-resume-candidate --json",
      "  node scripts/dsh-companion.mjs status [job-id] [--all] [--wait] [--json]",
      "  node scripts/dsh-companion.mjs result [job-id] [--json]",
      "  node scripts/dsh-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

// A single argv entry is the raw slash-command string: split it shell-style, but keep everything
// after an unquoted `--` as one verbatim text. Several argv entries are already split.
function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return { tokens: [], verbatim: null };
    }
    return splitRawArgumentString(raw);
  }
  return { tokens: argv, verbatim: null };
}

// --wait and --background are handled by the slash commands. They are accepted and ignored here
// so a stray flag never turns into prompt text.
function parseCommandInput(argv, config = {}) {
  const { tokens, verbatim } = normalizeArgv(argv);
  const parsed = parseArgs(tokens, {
    ...config,
    booleanOptions: [...(config.booleanOptions ?? []), "background", "wait"],
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  // The verbatim text never goes through option parsing, so text such as `--json` stays text.
  if (verbatim) {
    parsed.positionals.push(verbatim);
  }
  return parsed;
}

function canonicalCwd(cwd) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function resolveCommandCwd(options = {}) {
  return canonicalCwd(options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function isDshAvailable(cwd) {
  const availability = getDshAvailability(cwd);
  if (!availability.available) {
    throw new Error("dsh is not installed. Run /dsh:setup.");
  }
  return availability;
}

function findOnPath(command) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tracked runs

function createCompanionJob({ prefix, kind, title, workspaceRoot, cwd, summary, permissionMode, model }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind === "task" ? "rescue" : kind,
    title,
    workspaceRoot,
    cwd,
    jobClass: kind === "task" ? "task" : "plan",
    summary,
    permissionMode,
    model,
    status: "queued"
  });
}

function phaseForEvent(event) {
  if (event.type === "tool_call") {
    return { phase: "investigating", message: `Running tool: ${event.tool ?? "tool"}` };
  }
  if (event.type === "status" && event.phase === "turn_start") {
    return { phase: "running", message: "Turn started." };
  }
  if (event.type === "final") {
    return { phase: "finalizing", message: "Final answer received." };
  }
  return null;
}

/**
 * Runs one dsh headless process under job tracking, in the foreground of this process.
 * `summarize(finalText)` produces the one-line job summary. `finalize(result)` may return
 * `{ payload, renderedSuffix }` extras that are stored with the job result and shown after the output.
 */
async function executeRun({ job, prompt, permissionMode, model, sessionId, summarize, finalize, asJson }) {
  if (job.sessionId) {
    registerSessionWorkspace(job.sessionId, job.workspaceRoot);
  }
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const jobWithLog = { ...job, logFile };
  upsertJob(job.workspaceRoot, jobWithLog);
  writeJobFile(job.workspaceRoot, job.id, jobWithLog);

  const updateProgress = createJobProgressUpdater(job.workspaceRoot, job.id);
  const report = createProgressReporter({ logFile, onEvent: updateProgress });
  let dshPid = null;

  const forwardSignal = (signal) => {
    if (dshPid) {
      try {
        process.kill(-dshPid, signal);
      } catch {
        // The group is already gone.
      }
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const execution = await runTrackedJob(
      jobWithLog,
      async () => {
        const result = await runHeadless({
          cwd: job.cwd,
          prompt,
          permissionMode,
          model,
          sessionId,
          onSpawn: (pid) => {
            dshPid = pid;
            if (!recordDshPid(job.workspaceRoot, job.id, pid)) {
              terminateProcessTree(pid);
            }
          },
          onEvent: (event, { dshSessionId }) => {
            if (event.type === "session") {
              report({ message: `dsh session ${dshSessionId} ready.`, dshSessionId });
              return;
            }
            const progress = phaseForEvent(event);
            if (progress) {
              report(progress);
            }
          }
        });
        const extras = finalize?.(result);
        return {
          ...result,
          payload: { ...result.payload, ...extras?.payload },
          rendered: `${result.rendered}${extras?.renderedSuffix ?? ""}`,
          summary: summarize(result.payload.finalText, result)
        };
      },
      { logFile }
    );

    if (execution.cancelled) {
      process.stderr.write(`Job ${job.id} was cancelled.\n`);
      process.exitCode = 1;
      return execution;
    }
    outputCommandResult(
      { jobId: job.id, status: execution.exitStatus === 0 ? "completed" : "failed", ...execution },
      execution.rendered,
      asJson
    );
    process.exitCode = execution.exitStatus;
    return execution;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function resolveModelOption(options) {
  return normalizeModel(options.model);
}

// ---------------------------------------------------------------------------
// plan and review-plan

async function handlePlan(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json"],
    stopAtPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const request = positionals.join(" ").trim();
  if (!request) {
    throw new UsageError("Provide what to plan, for example: plan add a --version flag.");
  }
  isDshAvailable(cwd);

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = resolveModelOption(options);
  const prompt = interpolateTemplate(loadPromptTemplate(ROOT_DIR, "plan"), { REQUEST: request });
  const job = createCompanionJob({
    prefix: "plan",
    kind: "plan",
    title: "dsh Plan",
    workspaceRoot,
    cwd,
    summary: shorten(request),
    permissionMode: READ_ONLY,
    model: model ?? DEFAULT_MODEL
  });

  await executeRun({
    job,
    prompt,
    permissionMode: READ_ONLY,
    model,
    summarize: (finalText) => shorten(firstMeaningfulLine(finalText, request)),
    // dsh stays read-only; the plan file is written here, after dsh has exited.
    finalize: (result) => {
      if (result.exitStatus !== 0 || !result.payload.finalText.trim() || isJobCancelled(workspaceRoot, job.id)) {
        return null;
      }
      try {
        const planFile = savePlanFile(workspaceRoot, request, result.payload.finalText);
        return { payload: { planFile }, renderedSuffix: `Saved plan: ${planFile}\n` };
      } catch (error) {
        return { payload: {}, renderedSuffix: `Plan not saved: ${error instanceof Error ? error.message : String(error)}\n` };
      }
    },
    asJson: options.json
  });
}

export function extractVerdict(finalText) {
  const first = firstMeaningfulLine(finalText, "");
  const match = first.match(/^\W*Verdict:\s*([A-Za-z-]+)/i);
  const verdict = match ? match[1].toLowerCase() : null;
  return VERDICTS.includes(verdict) ? verdict : "unknown";
}

function resolvePlanPath(cwd, workspaceRoot, rawPath) {
  for (const base of [cwd, workspaceRoot]) {
    const candidate = path.resolve(base, rawPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildPlanFilesBlock(files, workspaceRoot) {
  return files
    .map((file) => {
      const label = (path.relative(workspaceRoot, file) || path.basename(file)).replace(/"/g, "%22");
      return `<file path="${label}">\n${fs.readFileSync(file, "utf8")}\n</file>`;
    })
    .join("\n\n");
}

async function handleReviewPlan(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json"],
    stopAtPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const [rawPath, ...focusParts] = positionals;
  if (!rawPath) {
    throw new UsageError("Provide the plan path: review-plan <plan-file-or-dir> [focus text].");
  }
  const planPath = resolvePlanPath(cwd, workspaceRoot, rawPath);
  if (!planPath) {
    throw new UsageError(`Plan path not found: ${rawPath}`);
  }
  let files;
  try {
    files = collectPlanFiles(planPath);
  } catch (error) {
    throw new UsageError(error.message);
  }
  isDshAvailable(cwd);

  const model = resolveModelOption(options);
  const focus = focusParts.join(" ").trim();
  const prompt = interpolateTemplate(loadPromptTemplate(ROOT_DIR, "review-plan"), {
    FOCUS: focus || "No extra focus. Review the plan as a whole.",
    PLAN_FILES: buildPlanFilesBlock(files, workspaceRoot)
  });
  const label = path.relative(workspaceRoot, planPath) || path.basename(planPath);
  const job = createCompanionJob({
    prefix: "review-plan",
    kind: "review-plan",
    title: "dsh Plan Review",
    workspaceRoot,
    cwd,
    summary: `Review ${label}`,
    permissionMode: READ_ONLY,
    model: model ?? DEFAULT_MODEL
  });

  await executeRun({
    job,
    prompt,
    permissionMode: READ_ONLY,
    model,
    summarize: (finalText) => `Verdict: ${extractVerdict(finalText)} (${label})`,
    asJson: options.json
  });
}

function handlePlanCandidates(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCommandCwd(options));
  const latest = findLatestPlanDir(workspaceRoot);
  outputCommandResult(
    { latest },
    latest ? `Latest plan: ${latest}\n` : "No plans found under ./plans.\n",
    options.json
  );
}

// ---------------------------------------------------------------------------
// code-review

// Everything git-related happens before dsh is involved, so a usage error or an empty change never
// needs dsh.
function prepareCodeReview(options) {
  const cwd = resolveCommandCwd(options);
  try {
    const repoRoot = ensureGitRepository(cwd);
    const target = resolveReviewTarget(repoRoot, { scope: options.scope, base: options.base });
    return { cwd, repoRoot, target, context: collectReviewContext(repoRoot, target) };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function nothingToReviewLine(label) {
  return `Nothing to review: ${label} has no changes.\n`;
}

async function handleCodeReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "base", "scope"],
    booleanOptions: ["json"],
    stopAtPositional: true
  });
  const { cwd, repoRoot, target, context } = prepareCodeReview(options);
  if (context.empty) {
    outputCommandResult({ empty: true, mode: target.mode, label: target.label }, nothingToReviewLine(target.label), options.json);
    return;
  }
  isDshAvailable(cwd);

  const model = resolveModelOption(options);
  const focus = positionals.join(" ").trim();
  const targetNote =
    target.mode === "branch"
      ? `${target.label}. Uncommitted edits are not part of this review.`
      : "Staged, unstaged and untracked changes in the working tree.";
  const prompt = interpolateTemplate(loadPromptTemplate(ROOT_DIR, "code-review"), {
    TARGET: targetNote,
    FOCUS: focus || "No extra focus. Review the change as a whole.",
    CHANGES: context.body
  });
  const job = createCompanionJob({
    prefix: "code-review",
    kind: "code-review",
    title: "dsh Code Review",
    workspaceRoot: repoRoot,
    cwd,
    summary: `Review ${target.label}`,
    permissionMode: READ_ONLY,
    model: model ?? DEFAULT_MODEL
  });

  await executeRun({
    job,
    prompt,
    permissionMode: READ_ONLY,
    model,
    summarize: (finalText) => `Verdict: ${extractVerdict(finalText)} (${target.label})`,
    asJson: options.json
  });
}

function handleCodeReviewTarget(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "base", "scope"],
    booleanOptions: ["json"]
  });
  const { target, context } = prepareCodeReview(options);
  const payload = {
    mode: target.mode,
    baseRef: target.baseRef,
    label: target.label,
    empty: context.empty,
    fileCount: context.fileCount,
    diffBytes: context.diffBytes,
    truncated: context.truncated
  };
  const rendered = context.empty
    ? nothingToReviewLine(target.label)
    : `${target.label}: ${context.fileCount} files, ${context.diffBytes} bytes${context.truncated ? " (too large to include in full)" : ""}\n`;
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// task (rescue)

function readTaskPrompt(positionals) {
  const fromArgs = positionals.join(" ").trim();
  return fromArgs || readStdinIfPiped().trim();
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json", "write", "read-only", "resume-last"],
    stopAtPositional: true
  });
  if (options.write && options["read-only"]) {
    throw new UsageError("Choose either --write or --read-only.");
  }
  const requestedMode = options.write ? WORKSPACE_WRITE : options["read-only"] ? READ_ONLY : null;
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = readTaskPrompt(positionals);

  let permissionMode = requestedMode ?? READ_ONLY;
  let sessionId = null;
  if (options["resume-last"]) {
    const candidate = resolveResumableTask(cwd);
    if (!candidate) {
      throw new UsageError("No previous dsh rescue session for this Claude session in this directory.");
    }
    if (requestedMode && requestedMode !== candidate.permissionMode) {
      throw new UsageError(
        `This dsh session runs in ${candidate.permissionMode}; start a new one with --fresh to change permissions.`
      );
    }
    permissionMode = candidate.permissionMode;
    sessionId = candidate.dshSessionId;
    if (!prompt) {
      throw new UsageError("Provide a prompt to continue the previous dsh session.");
    }
  } else if (!prompt) {
    throw new UsageError("Provide a prompt for dsh.");
  }
  isDshAvailable(cwd);

  const model = resolveModelOption(options);
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: "dsh Rescue",
    workspaceRoot,
    cwd,
    summary: shorten(prompt),
    permissionMode,
    model: model ?? DEFAULT_MODEL
  });

  await executeRun({
    job,
    prompt,
    permissionMode,
    model,
    sessionId,
    summarize: (finalText) => shorten(firstMeaningfulLine(finalText, prompt)),
    asJson: options.json
  });
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const candidate = resolveResumableTask(cwd);
  const payload = {
    available: Boolean(candidate),
    jobId: candidate?.id ?? null,
    dshSessionId: candidate?.dshSessionId ?? null,
    permissionMode: candidate?.permissionMode ?? null,
    summary: candidate?.summary ?? null
  };
  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.permissionMode}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// setup, status, result, cancel

async function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const dshStatus = getDshAvailability(cwd);
  const dshTuiPath = findOnPath("dsh-tui");

  const nextSteps = [];
  let auth = { ok: false, detail: "not checked (dsh is not installed)" };
  let dshDetail = dshStatus.detail;

  if (!dshStatus.available) {
    nextSteps.push("Install dsh with `npm install -g @deepseek-ai/dsh`.");
  } else {
    if (!dshStatus.supported) {
      dshDetail = `${dshStatus.detail} (unsupported; this plugin expects >=0.2.0-rc.2 <0.3.0)`;
      nextSteps.push("Install a supported dsh version: `npm install -g @deepseek-ai/dsh@0.2`.");
    }
    try {
      const smoke = await runHeadless({ cwd, prompt: "Reply with OK", permissionMode: READ_ONLY, timeoutMs: SMOKE_TIMEOUT_MS });
      const ok = smoke.exitStatus === 0 && Boolean(smoke.payload.finalText.trim());
      auth = {
        ok,
        detail: ok ? "headless run answered" : shorten(smoke.payload.errorMessage || "no answer from dsh", 160)
      };
    } catch (error) {
      auth = { ok: false, detail: shorten(error.message, 160) };
    }
    if (!auth.ok) {
      nextSteps.push("Run `!dsh-tui`, then log in with `/login`.");
    }
  }

  return {
    ready: nodeStatus.available && dshStatus.available && dshStatus.supported && auth.ok,
    node: nodeStatus,
    npm: npmStatus,
    dsh: { ...dshStatus, detail: dshDetail },
    dshTui: { available: Boolean(dshTuiPath), detail: dshTuiPath ?? "not found (optional)" },
    auth,
    defaultModel: DEFAULT_MODEL,
    actionsTaken: [],
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const report = await buildSetupReport(resolveCommandCwd(options));
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return { ...snapshot, waitTimedOut: isActiveJobStatus(snapshot.job.status), timeoutMs };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new UsageError("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "", { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const dshPid = existing.dshPid ?? job.dshPid ?? null;
  const companionPid = existing.pid ?? job.pid ?? null;

  // Cancellation is terminal: record it under the state lock before any process is signalled, so a
  // racing completion or progress write cannot overwrite it.
  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  withStateLock(workspaceRoot, () => {
    const latest = readStoredJob(workspaceRoot, job.id) ?? existing;
    writeJobFile(workspaceRoot, job.id, { ...latest, ...nextJob, cancelledAt: completedAt });
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      errorMessage: "Cancelled by user.",
      completedAt
    });
  });

  if (Number.isFinite(dshPid)) {
    terminateProcessTree(dshPid);
  }
  if (Number.isFinite(companionPid) && companionPid !== process.pid && processCommandIncludes(companionPid, "dsh-companion")) {
    try {
      process.kill(companionPid, "SIGTERM");
    } catch {
      // The companion already exited.
    }
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  outputCommandResult({ jobId: job.id, status: "cancelled", title: job.title }, renderCancelReport(nextJob), options.json);
}

async function main() {
  if (process.env[CHILD_ENV] === "1") {
    return;
  }
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "plan":
      await handlePlan(argv);
      break;
    case "review-plan":
      await handleReviewPlan(argv);
      break;
    case "plan-candidates":
      handlePlanCandidates(argv);
      break;
    case "code-review":
      await handleCodeReview(argv);
      break;
    case "code-review-target":
      handleCodeReviewTarget(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new UsageError(`Unknown subcommand: ${subcommand}`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error?.exitCode ?? 1;
  });
}
