import fs from "node:fs";

import { isProcessAlive, terminateProcessTree } from "./process.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, withStateLock, writeJobFile } from "./state.mjs";
import { nowIso, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

/**
 * Marks active jobs whose companion process has died (for example after SIGKILL) as failed and stops
 * any dsh process group they left behind, so they cannot block resume or hide from cancel.
 */
export function reconcileStaleJobs(workspaceRoot) {
  withStateLock(workspaceRoot, () => {
    for (const job of listJobs(workspaceRoot)) {
      const active = job.status === "queued" || job.status === "running";
      if (!active || !Number.isFinite(job.pid) || isProcessAlive(job.pid)) {
        continue;
      }
      const failure = {
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: "The companion process ended unexpectedly.",
        completedAt: nowIso()
      };
      const jobFile = resolveJobFile(workspaceRoot, job.id);
      const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : job;
      writeJobFile(workspaceRoot, job.id, { ...stored, ...failure });
      upsertJob(workspaceRoot, { id: job.id, ...failure });
      if (Number.isFinite(job.dshPid)) {
        terminateProcessTree(job.dshPid);
      }
    }
  });
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "plan" || job.kind === "review-plan") {
    return job.kind;
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    line === "Final output"
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function inferLegacyJobPhase(job) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      return "running";
  }
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /dsh:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileStaleJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    running,
    latestFinished,
    recent
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /dsh:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /dsh:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /dsh:status to inspect active jobs.`);
  }

  throw new Error("No finished dsh jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileStaleJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple dsh jobs are active. Pass a job id to /dsh:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active dsh jobs to cancel for this session.");
  }

  throw new Error("No active dsh jobs to cancel.");
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

/**
 * Finds the rescue job a resume should continue. Shared by `task --resume-last` and
 * `task-resume-candidate` so the picker and the executor can never disagree.
 * Only jobs of this Claude session and this cwd count, because dsh refuses to adopt a session
 * recorded under another cwd. Returns null when there is no candidate.
 */
export function resolveResumableTask(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    // Without a Claude session id every session would see every other session's rescue jobs.
    return null;
  }
  reconcileStaleJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) =>
      job.kind === "task" && job.id !== options.excludeJobId && job.sessionId === sessionId && job.cwd === cwd
  );

  const running = jobs.find((job) => isActiveStatus(job.status));
  if (running) {
    throw new Error(`Task ${running.id} is still running.`);
  }
  // The newest rescue run is the one the user means. If it never got a dsh session, there is nothing
  // to resume; an older session must not be continued in its place.
  const newest = jobs[0];
  return newest?.dshSessionId ? newest : null;
}
