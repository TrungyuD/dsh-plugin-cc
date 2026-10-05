import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, withStateLock, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "DSH_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      dshSessionId:
        typeof value.dshSessionId === "string" && value.dshSessionId.trim() ? value.dshSessionId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    dshSessionId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

// Records phase and dsh session id changes in both the state index and the job file.
export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastDshSessionId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.dshSessionId && normalized.dshSessionId !== lastDshSessionId) {
      lastDshSessionId = normalized.dshSessionId;
      patch.dshSessionId = normalized.dshSessionId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    withStateLock(workspaceRoot, () => {
      const stored = readStoredJobOrNull(workspaceRoot, jobId);
      if (stored?.status === "cancelled") {
        return;
      }
      upsertJob(workspaceRoot, patch);
      if (stored) {
        writeJobFile(workspaceRoot, jobId, { ...stored, ...patch });
      }
    });
  };
}

// Records the dsh process-group leader pid so cancel can kill the whole group.
export function recordDshPid(workspaceRoot, jobId, dshPid) {
  return withStateLock(workspaceRoot, () => {
    const stored = readStoredJobOrNull(workspaceRoot, jobId);
    if (stored?.status === "cancelled") {
      return false;
    }
    upsertJob(workspaceRoot, { id: jobId, dshPid });
    if (stored) {
      writeJobFile(workspaceRoot, jobId, { ...stored, dshPid });
    }
    return true;
  });
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[dsh] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export function isJobCancelled(workspaceRoot, jobId) {
  return readStoredJobOrNull(workspaceRoot, jobId)?.status === "cancelled";
}

/**
 * Runner contract: { exitStatus, payload, rendered, summary, dshSessionId, model, permissionMode, cwd }.
 * A job that was cancelled while running stays cancelled; cancellation is terminal.
 */
export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile
  };
  if (isJobCancelled(job.workspaceRoot, job.id)) {
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const outcome = withStateLock(job.workspaceRoot, () => {
      // Cancellation is terminal: it is checked and the completion is written under one lock.
      if (isJobCancelled(job.workspaceRoot, job.id)) {
        return "cancelled";
      }
      const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
      const completedAt = nowIso();
      const finalState = {
        dshSessionId: execution.dshSessionId ?? null,
        model: execution.model ?? null,
        permissionMode: execution.permissionMode ?? null,
        cwd: execution.cwd ?? job.cwd ?? null
      };
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
      writeJobFile(job.workspaceRoot, job.id, {
        ...existing,
        status: completionStatus,
        ...finalState,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: completionStatus,
        ...finalState,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        completedAt
      });
      return completionStatus;
    });
    if (outcome === "cancelled") {
      return { ...execution, cancelled: true };
    }
    appendLogBlock(logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    withStateLock(job.workspaceRoot, () => {
      if (isJobCancelled(job.workspaceRoot, job.id)) {
        return;
      }
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
      const completedAt = nowIso();
      writeJobFile(job.workspaceRoot, job.id, {
        ...existing,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        completedAt,
        logFile: logFile ?? existing.logFile ?? null
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt
      });
    });
    throw error;
  }
}
