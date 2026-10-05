#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { CHILD_ENV } from "./lib/dsh.mjs";
import { processCommandIncludes, terminateProcessTree } from "./lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveStateFile, upsertJob, withStateLock, writeJobFile } from "./lib/state.mjs";
import { nowIso, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function killQuietly(pid, killer) {
  if (!Number.isFinite(pid)) {
    return;
  }
  try {
    killer(pid);
  } catch {
    // Ignore teardown failures during session shutdown.
  }
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }

  for (const job of listJobs(workspaceRoot)) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (job.sessionId !== sessionId || !stillRunning) {
      continue;
    }

    // Mark the job cancelled first, under the state lock, so a racing completion cannot overwrite it.
    const completedAt = nowIso();
    const cancelled = {
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      errorMessage: "Session ended.",
      completedAt
    };
    withStateLock(workspaceRoot, () => {
      const jobFile = resolveJobFile(workspaceRoot, job.id);
      const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : job;
      writeJobFile(workspaceRoot, job.id, { ...stored, ...cancelled });
      upsertJob(workspaceRoot, { id: job.id, ...cancelled });
    });

    killQuietly(job.dshPid, terminateProcessTree);
    killQuietly(job.pid, (pid) => {
      if (processCommandIncludes(pid, "dsh-companion")) {
        process.kill(pid, "SIGTERM");
      }
    });
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  cleanupSessionJobs(input.cwd || process.cwd(), input.session_id || process.env[SESSION_ID_ENV]);
}

function main() {
  if (process.env[CHILD_ENV] === "1") {
    return;
  }
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
