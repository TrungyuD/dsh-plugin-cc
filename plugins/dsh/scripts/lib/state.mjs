import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "dsh-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_DIR_NAME = ".lock";
const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 8000;
const lockDepth = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Runs `fn` while holding the per-workspace state lock, so read-modify-write sequences from
 * concurrent companions, hooks and cancels cannot overwrite each other. Re-entrant within a process.
 */
export function withStateLock(cwd, fn) {
  const stateDir = resolveStateDir(cwd);
  const depth = lockDepth.get(stateDir) ?? 0;
  if (depth > 0) {
    lockDepth.set(stateDir, depth + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(stateDir, depth);
    }
  }

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = path.join(stateDir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the dsh state lock.");
      }
      sleepSync(15);
    }
  }

  lockDepth.set(stateDir, 1);
  try {
    return fn();
  } finally {
    lockDepth.delete(stateDir);
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    if (job.logFile && path.dirname(path.resolve(job.logFile)) === path.resolve(resolveJobsDir(cwd))) {
      removeFileIfExists(job.logFile);
    }
  }

  atomicWrite(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWrite(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
