import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "headless-sample.jsonl");

// FAKE_DSH_MODE: unset = replay the sample; error = emit an error event and exit 1;
// slow = print the session event, then sleep until killed;
// spawn-child = like slow, but also starts a grandchild sleeper in the same process group.
const SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log(process.env.FAKE_DSH_VERSION ?? "0.2.0-rc.2");
  process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const patchIndex = argv.indexOf("--patch");
const patchPath = patchIndex === -1 ? null : argv[patchIndex + 1];
const record = process.env.FAKE_DSH_RECORD;
if (record) {
  let calls = [];
  try { calls = JSON.parse(fs.readFileSync(record, "utf8")); } catch {}
  calls.push({
    argv,
    cwd: process.cwd(),
    stdin,
    patch: patchPath && fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : null,
    env: {
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
      DSH_COMPANION_CHILD: process.env.DSH_COMPANION_CHILD ?? null
    }
  });
  fs.writeFileSync(record, JSON.stringify(calls));
}


const sessionIndex = argv.indexOf("--session-id");
const sessionId = sessionIndex === -1 ? "session-fake-0001" : argv[sessionIndex + 1];
const mode = process.env.FAKE_DSH_MODE ?? "";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");

if (mode === "error") {
  emit({ type: "session", sessionId, cwd: process.cwd() });
  emit({ type: "error", message: "fake dsh failure" });
  process.exit(1);
}

if (mode === "slow" || mode === "spawn-child") {
  emit({ type: "session", sessionId, cwd: process.cwd() });
  if (mode === "spawn-child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "fake-dsh-grandchild"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_DSH_CHILD_PIDFILE, String(child.pid));
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const lines = fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8").split("\\n").filter(Boolean);
for (const line of lines) {
  const event = JSON.parse(line);
  if (event.type === "session") event.sessionId = sessionId;
  if (event.type === "final" && process.env.FAKE_DSH_FINAL) event.text = process.env.FAKE_DSH_FINAL;
  emit(event);
}
`;

// Installs a fake \`dsh\` on a temp bin dir and returns env helpers for tests.
export function installFakeDsh() {
  const binDir = makeTempDir("dsh-fake-bin-");
  // The fake is an extensionless ESM script; Node < 20.19 only treats it as ESM when the nearest package.json says so.
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"module"}');
  writeExecutable(path.join(binDir, "dsh"), SOURCE.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  const recordFile = path.join(makeTempDir("dsh-fake-record-"), "calls.json");
  return {
    binDir,
    recordFile,
    env(extra = {}) {
      return {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        FAKE_DSH_RECORD: recordFile,
        ...extra
      };
    },
    calls() {
      return fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : [];
    }
  };
}
