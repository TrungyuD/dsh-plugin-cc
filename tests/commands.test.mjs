import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "dsh");
const COMMANDS = ["plan", "review-plan", "code-review", "rescue", "status", "result", "cancel", "setup"];

function read(...parts) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, ...parts), "utf8");
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "frontmatter present");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return fields;
}

function companionLines(text) {
  return text.split("\n").filter((line) => /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/dsh-companion\.mjs"/.test(line));
}

test("all eight commands exist, have frontmatter, and call dsh-companion without codex names", () => {
  for (const name of COMMANDS) {
    const text = read("commands", `${name}.md`);
    const fields = frontmatter(text);
    assert.ok(fields.description, `${name} has a description`);
    assert.match(text, /dsh-companion\.mjs/, `${name} calls the companion`);
    assert.doesNotMatch(text, /codex/i, `${name} has no codex identifier`);
  }
});

test("plan, review-plan and code-review have foreground and background flows that use run_in_background", () => {
  for (const name of ["plan", "review-plan", "code-review"]) {
    const text = read("commands", `${name}.md`);
    assert.match(text, /Foreground flow/);
    assert.match(text, /Background flow/);
    assert.match(text, /run_in_background: true/);
  }
});

test("no command forwards --wait or --background to the companion", () => {
  for (const name of COMMANDS) {
    const lines = companionLines(read("commands", `${name}.md`));
    assert.ok(lines.length > 0, `${name} has a companion invocation`);
    for (const line of lines) {
      assert.doesNotMatch(line, /--wait|--background/, `${name}: ${line}`);
    }
  }
});

test("plan, review-plan and code-review return output verbatim and never implement", () => {
  for (const name of ["plan", "review-plan", "code-review"]) {
    const text = read("commands", `${name}.md`);
    assert.match(text, /verbatim/);
    assert.match(text, /Do not (implement|fix)/);
  }
});

test("review-plan documents the two-option picker with the latest plan first", () => {
  const text = read("commands", "review-plan.md");
  assert.match(text, /plan-candidates --json/);
  assert.match(text, /Review which plan\?/);
  assert.match(text, /`<latest> \(Recommended\)`[\s\S]*`Enter a path`/);
  assert.match(text, /at most two pickers/);
});

test("code-review sizes the change first and recommends waiting only for a small one", () => {
  const text = read("commands", "code-review.md");
  assert.match(text, /code-review-target '--json/);
  assert.match(text, /`empty` is true, tell the user there is nothing to review/);
  assert.match(text, /`fileCount` is 2 or less and `truncated` is false/);
  assert.match(text, /`Wait for results`[\s\S]*`Run in background`/);
});

test("rescue routes through the dsh-rescue subagent with the Agent tool and never forwards flags", () => {
  const text = read("commands", "rescue.md");
  assert.match(frontmatter(text)["allowed-tools"], /Agent/);
  assert.match(text, /subagent_type: "dsh:dsh-rescue"/);
  assert.match(text, /Do not forward them to `task`/);
  assert.match(text, /task-resume-candidate --json/);
});

test("the rescue agent is limited to Bash and defaults fresh runs to --write", () => {
  const text = read("agents", "dsh-rescue.md");
  const fields = frontmatter(text);
  assert.equal(fields.tools, "Bash");
  assert.equal(fields.model, "sonnet");
  assert.match(text, /adding `--write`/);
  assert.match(text, /Do not add `--write` or `--read-only` on a resume/);
  assert.doesNotMatch(text, /codex/i);
});

test("commands and the rescue agent put the user's text after a -- and never inside double quotes", () => {
  const plan = read("commands", "plan.md");
  const review = read("commands", "review-plan.md");
  const codeReview = read("commands", "code-review.md");
  const agent = read("agents", "dsh-rescue.md");
  const skill = read("skills", "dsh-cli-runtime", "SKILL.md");
  assert.match(plan, /plan '<flags> -- <request>'/);
  assert.match(review, /review-plan '<flags> <plan-path> -- <focus>'/);
  assert.match(codeReview, /code-review '<flags> -- <focus>'/);
  assert.match(codeReview, /code-review-target '--json </);
  assert.match(agent, /task '<flags> -- <task text>'/);
  assert.match(skill, /task '<flags> -- <task text>'/);
  for (const [name, text] of [["plan", plan], ["review-plan", review], ["code-review", codeReview], ["skill", skill]]) {
    assert.doesNotMatch(text, /(plan|review-plan|code-review|code-review-target|task) "</, `${name} has no double-quoted text placeholder`);
  }
});

test("skills have names and no codex identifiers", () => {
  for (const name of ["dsh-cli-runtime", "dsh-result-handling"]) {
    const text = read("skills", name, "SKILL.md");
    assert.equal(frontmatter(text).name, name);
    assert.doesNotMatch(text, /codex/i);
  }
});

test("hooks only register SessionStart and SessionEnd with no stop gate", () => {
  const hooks = JSON.parse(read("hooks", "hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionEnd", "SessionStart"]);
  for (const entries of Object.values(hooks)) {
    assert.equal(entries[0].hooks[0].timeout, 5);
  }
});

test("manifests parse and agree on the plugin name and version", () => {
  const root = path.join(PLUGIN_ROOT, "..", "..");
  const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(plugin.name, "dsh");
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].version, plugin.version);
  assert.equal(pkg.version, plugin.version);
  assert.equal(pkg.name, "dsh-plugin-cc");
  assert.deepEqual(pkg.files.sort(), [".claude-plugin/", "LICENSE", "NOTICE", "README.md", "plugins/"].sort());
});
