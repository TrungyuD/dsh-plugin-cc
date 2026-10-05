import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createTempDir } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";
import { renderRunResult } from "./render.mjs";

export const CHILD_ENV = "DSH_COMPANION_CHILD";
export const DEFAULT_MODEL = "deepseek-flash";
export const SUPPORTED_RANGE = ">=0.2.0-rc.2 <0.3.0";
export const MODEL_ALIASES = { flash: "deepseek-flash", pro: "deepseek-v4-pro" };
export const PROVIDER = "deepseek-official";
export const PERMISSION_MODES = ["read-only", "workspace-write"];

export function normalizeModel(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value) {
    return null;
  }
  return MODEL_ALIASES[value.toLowerCase()] ?? value;
}

// No preset may use `approval: never`. It auto-approves, and headless has no approval channel, so `ask` fails closed.
const PRESET_TABLE = [
  "      read-only: { sandbox: read-only, approval: ask }",
  "      workspace-write: { sandbox: workspace-write, approval: ask }",
  "      danger-full-access: { sandbox: danger-full-access, approval: ask }"
];

/**
 * Writes the per-run patch and returns its path. The sandbox mode and default preset are pinned
 * to the requested permission mode; the model block is added only when a model is requested.
 */
export function writeRunPatch({ permissionMode, model, cwd }) {
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`Unsupported permission mode "${permissionMode}". Use read-only or workspace-write.`);
  }
  const lines = [
    "- id: sandbox-policy",
    `  config: { mode: ${permissionMode}, workspaceRoot: ${JSON.stringify(cwd)} }`,
    "- id: permission",
    "  config:",
    `    defaultPreset: ${permissionMode}`,
    "    presets:",
    ...PRESET_TABLE
  ];
  const resolvedModel = normalizeModel(model);
  if (resolvedModel) {
    lines.push("- id: agent-default-model", `  config: { provider: ${PROVIDER}, model: ${JSON.stringify(resolvedModel)} }`);
  }
  const dir = createTempDir("dsh-plugin-");
  const file = path.join(dir, "run.patch.yml");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function removePatch(file) {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Best effort: the patch lives in the OS temp dir.
  }
}

function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Runs one headless dsh process in its own process group.
 * Returns the tracked-job runner contract.
 */
export function runHeadless({ cwd, prompt, permissionMode, model, sessionId, onSpawn, onEvent, timeoutMs }) {
  const patchFile = writeRunPatch({ permissionMode, model, cwd });
  const resolvedModel = normalizeModel(model) ?? DEFAULT_MODEL;
  const args = ["--patch", patchFile, "--profile", "headless", "--json"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  args.push("-");

  return new Promise((resolve, reject) => {
    const child = spawn("dsh", args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DSH_PERMISSION_MODE: permissionMode, [CHILD_ENV]: "1" }
    });

    let dshSessionId = sessionId ?? null;
    let finalText = "";
    let errorMessage = "";
    let usage = null;
    let stderr = "";
    let buffer = "";
    let settled = false;
    let timer = null;

    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removePatch(patchFile);
      fn();
    };

    const handleEvent = (event) => {
      if (event.type === "session" && typeof event.sessionId === "string") {
        dshSessionId = event.sessionId;
      } else if (event.type === "final" && typeof event.text === "string") {
        finalText = event.text;
      } else if (event.type === "error") {
        errorMessage = String(event.message ?? "dsh reported an error");
      } else if (event.type === "status" && event.usage) {
        usage = event.usage;
      }
      onEvent?.(event, { dshSessionId });
    };

    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const event = parseEventLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (event) {
          handleEvent(event);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});

    if (child.pid) {
      onSpawn?.(child.pid);
    }
    child.stdin.end(prompt);
    if (timeoutMs && child.pid) {
      timer = setTimeout(() => {
        errorMessage = `dsh did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }, timeoutMs);
    }

    child.on("close", (code, signal) => {
      const tail = parseEventLine(buffer);
      if (tail) {
        handleEvent(tail);
      }
      finish(() => {
        if (!errorMessage && code !== 0) {
          errorMessage = stderr.trim() || (signal ? `dsh exited with signal ${signal}` : `dsh exited with code ${code}`);
        }
        const exitStatus = errorMessage ? 1 : (code ?? 1);
        const rendered = renderRunResult({
          title: "dsh",
          finalText,
          errorMessage,
          dshSessionId,
          model: resolvedModel,
          permissionMode
        });
        resolve({
          exitStatus,
          payload: { finalText, errorMessage, usage },
          rendered,
          summary: "",
          dshSessionId,
          model: resolvedModel,
          permissionMode,
          cwd
        });
      });
    });
  });
}

function compareSemver(left, right) {
  const parse = (value) => {
    const [core, pre = ""] = value.split("-");
    return { nums: core.split(".").map(Number), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) {
      return a.nums[i] < b.nums[i] ? -1 : 1;
    }
  }
  if (a.pre === b.pre) {
    return 0;
  }
  if (!a.pre) {
    return 1;
  }
  if (!b.pre) {
    return -1;
  }
  return a.pre < b.pre ? -1 : 1;
}

export function isSupportedDshVersion(version) {
  return Boolean(version) && compareSemver(version, "0.2.0-rc.2") >= 0 && compareSemver(version, "0.3.0") < 0;
}

export function getDshAvailability(cwd) {
  const result = binaryAvailable("dsh", ["--version"], { cwd });
  if (!result.available) {
    return { available: false, detail: result.detail, version: null, supported: false };
  }
  const match = result.detail.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/);
  const version = match ? match[0] : null;
  return { available: true, detail: result.detail, version, supported: isSupportedDshVersion(version) };
}
