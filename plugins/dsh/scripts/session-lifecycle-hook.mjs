#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { CHILD_ENV } from "./lib/dsh.mjs";
import { processCommandIncludes, terminateProcessTree } from "./lib/process.mjs";
import {
  forgetSessionWorkspaces,
  listJobs,
  listSessionWorkspaces,
  pruneSessionIndex,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  resolveStateFile,
  upsertJob,
  withStateLock,
  writeJobFile
} from "./lib/state.mjs";
import { nowIso, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SESSION_INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

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
  try {
    pruneSessionIndex(SESSION_INDEX_MAX_AGE_MS);
  } catch {
    // Housekeeping must never fail a session start.
  }
}

function handleSessionEnd(input) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }

  // The starting directory plus every workspace this session ran a job in, one state dir each.
  const roots = new Map();
  for (const cwd of [input.cwd || process.cwd(), ...listSessionWorkspaces(sessionId)]) {
    try {
      roots.set(resolveStateDir(cwd), cwd);
    } catch {
      // A workspace that can no longer be resolved has nothing to clean.
    }
  }

  try {
    for (const cwd of roots.values()) {
      try {
        cleanupSessionJobs(cwd, sessionId);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    forgetSessionWorkspaces(sessionId);
  }
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
