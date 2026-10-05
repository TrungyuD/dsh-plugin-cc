import { runCommand } from "./process.mjs";

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
export function ensureGitRepository(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, shell: false });
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}
