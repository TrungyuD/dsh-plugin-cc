function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatDshResumeCommand(job) {
  if (!job?.dshSessionId) {
    return null;
  }
  return `dsh tui --resume ${job.dshSessionId}`;
}

function isActive(job) {
  return job.status === "queued" || job.status === "running";
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | dsh Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/dsh:status ${job.id}`];
    if (isActive(job)) {
      actions.push(`/dsh:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.dshSessionId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.permissionMode) {
    lines.push(`  Mode: ${job.permissionMode}`);
  }
  if (job.dshSessionId) {
    lines.push(`  dsh session ID: ${job.dshSessionId}`);
  }
  const resumeCommand = formatDshResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in dsh: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if (isActive(job) && options.showCancelHint) {
    lines.push(`  Cancel: /dsh:cancel ${job.id}`);
  }
  if (!isActive(job) && options.showResultHint) {
    lines.push(`  Result: /dsh:result ${job.id}`);
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# dsh Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- dsh: ${report.dsh.detail}`,
    `- dsh-tui: ${report.dshTui.detail}`,
    `- auth: ${report.auth.detail}`,
    `- default model: ${report.defaultModel}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Prints dsh's final text verbatim, then a footer naming the session, model and mode. */
export function renderRunResult({ title, finalText, errorMessage, dshSessionId, model, permissionMode }) {
  const lines = [];
  const text = String(finalText ?? "").trimEnd();
  if (text) {
    lines.push(text);
  } else if (errorMessage) {
    lines.push(`${title ?? "dsh"} failed: ${errorMessage}`);
  } else {
    lines.push("dsh did not return a final message.");
  }
  const footer = [
    `dsh session: ${dshSessionId ?? "unknown"}`,
    `model: ${model ?? "default"}`,
    `mode: ${permissionMode ?? "unknown"}`
  ].join(" · ");
  lines.push("", footer);
  return `${lines.join("\n")}\n`;
}

export function renderStatusReport(report) {
  const lines = ["# dsh Status", ""];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# dsh Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: isActive(job),
    showDuration: !isActive(job),
    showLog: true,
    showCancelHint: true,
    showResultHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  if (storedJob?.rendered) {
    return storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
  }

  const dshSessionId = storedJob?.dshSessionId ?? job.dshSessionId ?? null;
  const lines = [`# ${job.title ?? "dsh Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];

  if (dshSessionId) {
    lines.push(`dsh session ID: ${dshSessionId}`);
    lines.push(`Resume in dsh: dsh tui --resume ${dshSessionId}`);
  }
  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }
  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# dsh Cancel", "", `Cancelled ${job.id}.`, ""];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/dsh:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
