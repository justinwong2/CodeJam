#!/usr/bin/env node
// Launcher for `npm run poc`. npm runs package scripts through cmd.exe on
// Windows, which cannot execute a shell script, and a bare `bash` there
// resolves to WSL (C:\Windows\System32\bash.exe) rather than Git Bash. This
// shim finds a real Git Bash and hands off to the one POC script.
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = "scripts/start-local-poc.sh";

function gitBashCandidates() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
  ].filter(Boolean);
  const candidates = roots.map((root) =>
    path.join(root, "Git", "bin", "bash.exe"),
  );
  try {
    const gitExe = execFileSync("where", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    if (gitExe) {
      // ...\Git\cmd\git.exe or ...\Git\bin\git.exe -> ...\Git\bin\bash.exe
      candidates.push(
        path.join(path.dirname(path.dirname(gitExe)), "bin", "bash.exe"),
      );
    }
  } catch {
    // git is not on PATH; fall through to the explicit locations above.
  }
  return candidates;
}

function findWindowsBash() {
  if (process.env.GIT_BASH) return process.env.GIT_BASH;
  const found = gitBashCandidates().find((candidate) => existsSync(candidate));
  if (found) return found;
  console.error(
    [
      "[local-poc] Git Bash was not found.",
      "[local-poc] Install Git for Windows (https://git-scm.com/download/win),",
      "[local-poc] or set GIT_BASH to the full path of bash.exe.",
      "[local-poc] WSL bash is not used: it cannot see the Windows Docker paths",
      "[local-poc] this script mounts.",
    ].join("\n"),
  );
  process.exit(2);
}

// A Git Bash started from cmd.exe or PowerShell is neither login nor
// interactive, so it never sources /etc/profile and inherits only the Windows
// PATH. Most installs put just Git\cmd there, which leaves uname, sed, id, and
// cygpath missing and the script failing on its first line. Prepend the MSYS
// toolchain ourselves rather than relying on a login shell's side effects.
function withMsysToolchain(bashPath, currentPath) {
  const gitRoot = path.dirname(path.dirname(bashPath));
  const toolDirs = ["usr/bin", "mingw64/bin", "mingw32/bin", "bin"]
    .map((relative) => path.join(gitRoot, ...relative.split("/")))
    .filter((directory) => existsSync(directory));
  return [...toolDirs, currentPath].filter(Boolean).join(path.delimiter);
}

const onWindows = process.platform === "win32";
const bash = onWindows ? findWindowsBash() : "bash";
const environment = { ...process.env };
if (onWindows) {
  // Keep MSYS from rewriting container-side paths such as dst=/workspace.
  environment.MSYS_NO_PATHCONV = "1";
  environment.MSYS2_ARG_CONV_EXCL = "*";
  environment.PATH = withMsysToolchain(bash, process.env.PATH ?? "");
}

const child = spawn(bash, [script, ...process.argv.slice(2)], {
  cwd: repoDir,
  env: environment,
  stdio: "inherit",
});

// Ctrl+C reaches the child through the console/process group. Stay alive so
// the script's own cleanup trap can remove Runtime containers before we exit.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

child.on("error", (error) => {
  console.error("[local-poc] Failed to start " + bash + ": " + error.message);
  process.exit(1);
});
child.on("close", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
