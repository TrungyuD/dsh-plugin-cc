import test from "node:test";
import assert from "node:assert/strict";

import { installFakeDsh } from "./fake-dsh-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  getDshAvailability,
  isSupportedDshVersion,
  normalizeModel,
  runHeadless,
  writeRunPatch
} from "../plugins/dsh/scripts/lib/dsh.mjs";
import fs from "node:fs";

async function withFakePath(fake, env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, fake.env(env));
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

test("normalizeModel maps aliases and passes unknown names through", () => {
  assert.equal(normalizeModel("flash"), "deepseek-flash");
  assert.equal(normalizeModel("PRO"), "deepseek-v4-pro");
  assert.equal(normalizeModel("custom-model"), "custom-model");
  assert.equal(normalizeModel(""), null);
  assert.equal(normalizeModel(undefined), null);
});

test("writeRunPatch pins the sandbox and default preset, and no preset auto-approves", () => {
  const cwd = makeTempDir();
  for (const mode of ["read-only", "workspace-write"]) {
    const file = writeRunPatch({ permissionMode: mode, cwd });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, new RegExp(`mode: ${mode}`));
    assert.match(text, new RegExp(`defaultPreset: ${mode}`));
    assert.doesNotMatch(text, /agent-default-model/);
    assert.doesNotMatch(text, /never/, "no preset may auto-approve");
  }
});

test("writeRunPatch adds the model block only when a model is requested", () => {
  const file = writeRunPatch({ permissionMode: "read-only", model: "pro", cwd: makeTempDir() });
  assert.match(fs.readFileSync(file, "utf8"), /id: agent-default-model[\s\S]*deepseek-v4-pro/);
});

test("writeRunPatch rejects unsupported permission modes", () => {
  assert.throws(
    () => writeRunPatch({ permissionMode: "danger-full-access", cwd: makeTempDir() }),
    /Unsupported permission mode/
  );
});

test("runHeadless passes argv, env and stdin, captures the session and final text", async () => {
  const fake = installFakeDsh();
  const cwd = makeTempDir();
  const events = [];
  let spawnedAt = null;
  const result = await withFakePath(fake, { FAKE_DSH_FINAL: "plan text" }, () =>
    runHeadless({
      cwd,
      prompt: "make a plan",
      permissionMode: "read-only",
      model: "pro",
      onSpawn: () => {
        spawnedAt = events.length;
      },
      onEvent: (event) => events.push(event.type)
    })
  );

  assert.equal(spawnedAt, 0, "onSpawn fires before the first event");
  assert.equal(result.exitStatus, 0);
  assert.equal(result.payload.finalText, "plan text");
  assert.equal(result.dshSessionId, "session-fake-0001");
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(result.permissionMode, "read-only");
  assert.match(result.rendered, /^plan text\n\ndsh session: session-fake-0001 · model: deepseek-v4-pro · mode: read-only\n$/);

  const [call] = fake.calls();
  assert.deepEqual(call.argv.slice(0, 1), ["--patch"]);
  assert.deepEqual(call.argv.slice(2), ["--profile", "headless", "--json", "-"]);
  assert.equal(call.stdin, "make a plan");
  assert.equal(call.env.DSH_PERMISSION_MODE, "read-only");
  assert.equal(call.env.DSH_COMPANION_CHILD, "1");
  assert.match(call.patch, /mode: read-only/);
  assert.match(call.patch, /deepseek-v4-pro/);
  assert.equal(fs.existsSync(call.argv[1]), false, "patch file is removed when the run ends");
});

test("runHeadless forwards the session id and uses the default model name in the footer", async () => {
  const fake = installFakeDsh();
  const result = await withFakePath(fake, {}, () =>
    runHeadless({ cwd: makeTempDir(), prompt: "go on", permissionMode: "workspace-write", sessionId: "session-abc" })
  );
  const [call] = fake.calls();
  assert.deepEqual(call.argv.slice(-3, -1), ["--session-id", "session-abc"]);
  assert.equal(result.dshSessionId, "session-abc");
  assert.equal(result.model, "deepseek-flash");
  assert.doesNotMatch(call.patch, /agent-default-model/);
});

test("runHeadless turns an error event into exit status 1", async () => {
  const fake = installFakeDsh();
  const result = await withFakePath(fake, { FAKE_DSH_MODE: "error" }, () =>
    runHeadless({ cwd: makeTempDir(), prompt: "x", permissionMode: "read-only" })
  );
  assert.equal(result.exitStatus, 1);
  assert.equal(result.payload.errorMessage, "fake dsh failure");
  assert.match(result.rendered, /dsh failed: fake dsh failure/);
});

test("runHeadless skips non-JSON lines and unknown event types", async () => {
  const fake = installFakeDsh();
  const seen = [];
  await withFakePath(fake, {}, () =>
    runHeadless({ cwd: makeTempDir(), prompt: "x", permissionMode: "read-only", onEvent: (e) => seen.push(e.type) })
  );
  assert.ok(seen.includes("final"));
  assert.ok(seen.every((type) => typeof type === "string"));
});

test("version support range is >=0.2.0-rc.2 <0.3.0", () => {
  assert.equal(isSupportedDshVersion("0.2.0-rc.2"), true);
  assert.equal(isSupportedDshVersion("0.2.0-rc.1"), false);
  assert.equal(isSupportedDshVersion("0.2.0"), true);
  assert.equal(isSupportedDshVersion("0.2.7"), true);
  assert.equal(isSupportedDshVersion("0.3.0"), false);
  assert.equal(isSupportedDshVersion(null), false);
});

test("getDshAvailability reads the version from the dsh binary", async () => {
  const fake = installFakeDsh();
  const availability = await withFakePath(fake, { FAKE_DSH_VERSION: "0.2.4" }, () => getDshAvailability(process.cwd()));
  assert.equal(availability.available, true);
  assert.equal(availability.version, "0.2.4");
  assert.equal(availability.supported, true);
});
