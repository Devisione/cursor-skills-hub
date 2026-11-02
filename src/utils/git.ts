import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { HubError, errorMessage } from "./errors";
import { ensureDir } from "./filesystem";
import { parseGitUrl } from "./github-url";
import { redactSecrets, assertGitHubToken, isUnsafeRelativePath } from "./security";

export interface GitResult {
  stdout: string;
  stderr: string;
}

const EMPTY_HOOKS = path.join(os.tmpdir(), "cursor-skills-hub-no-hooks");

export async function ensureNoHooksDir(): Promise<string> {
  await ensureDir(EMPTY_HOOKS);
  return EMPTY_HOOKS;
}

export async function runGit(args: string[], options: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  if (options.token) {
    assertGitHubToken(options.token);
  }
  const hooks = await ensureNoHooksDir();
  const prefix = ["-c", `core.hooksPath=${hooks}`, "-c", "core.autocrlf=false", "-c", "advice.detachedHead=false"];
  if (options.token) {
    // The linked account is the only credential. A second helper or Authorization header
    // makes GitHub reject the request with "invalid credentials".
    const helper = `!f() { echo username=x-access-token; echo password=${options.token}; }; f`;
    prefix.push(
      "-c", "credential.helper=",
      "-c", `credential.helper=${helper}`,
      "-c", "credential.https://github.com.helper=",
      "-c", `credential.https://github.com.helper=${helper}`,
    );
  }
  return runProcess("git", [...prefix, ...args], options.cwd, options.timeoutMs ?? 60_000, options.token);
}

function gitProcessEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  if (token) {
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
  }
  return env;
}

function runProcess(command: string, args: string[], cwd: string | undefined, timeoutMs: number, token?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: gitProcessEnv(token),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new HubError("git-timeout", "Git took too long and was stopped."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Git is not available on PATH. Skills Hub needs Git for repository installs."
        : redact(errorMessage(error), token);
      reject(new HubError("git-missing", message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new HubError("git-failed", redact(`${stderr || stdout || "Git failed."}`.trim(), token)));
    });
  });
}

function redact(value: string, token?: string): string {
  const cleaned = token ? value.split(token).join("[redacted]") : value;
  return redactSecrets(cleaned).slice(0, 2000);
}

export async function gitVersion(): Promise<string | undefined> {
  try {
    const result = await runGit(["--version"], { timeoutMs: 10_000 });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

export interface MaterializedRepo {
  directory: string;
  commitSha: string;
  cleanup: () => Promise<void>;
}

export function cloneUrl(input: string): string {
  const parsed = parseGitUrl(input);
  if (!parsed.normalized.startsWith("https://")) {
    throw new HubError("invalid-url", "Only HTTPS repository URLs can be cloned.");
  }
  return parsed.normalized;
}

const SAFE_REF = /^(?:HEAD|[0-9a-f]{7,40}|refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+|[A-Za-z0-9][A-Za-z0-9._/-]{0,200})$/;

export function assertGitRef(ref: string): string {
  if (!SAFE_REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) {
    throw new HubError("invalid-url", "That Git ref is not a branch, tag, or commit.");
  }
  return ref;
}

function checkoutSubpath(subpath: string | undefined): string | undefined {
  if (!subpath || subpath === "." || subpath === "") {
    return undefined;
  }
  const normalized = subpath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (isUnsafeRelativePath(normalized) || normalized.split("/").some((part) => part.startsWith("-"))) {
    throw new HubError("path-traversal", "The component path cannot be checked out.");
  }
  return normalized;
}

export async function materializeRepo(input: {
  url: string;
  ref?: string;
  subpath?: string;
  token?: string;
}): Promise<MaterializedRepo> {
  const url = cloneUrl(input.url);
  const explicitRef = input.ref && input.ref !== "HEAD" ? assertGitRef(input.ref) : undefined;
  const subpath = checkoutSubpath(input.subpath);
  const directory = await mkdtemp(path.join(os.tmpdir(), "skills-hub-"));
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await runGit(["init"], { cwd: directory, token: input.token });
    await runGit(["remote", "add", "origin", url], { cwd: directory, token: input.token });
    const ref = explicitRef ?? assertGitRef(await defaultRef(url, input.token));
    if (subpath) {
      await runGit(["sparse-checkout", "init", "--cone"], { cwd: directory, token: input.token });
      await runGit(["sparse-checkout", "set", "--", subpath], { cwd: directory, token: input.token });
    }
    await runGit(["fetch", "--depth", "1", "origin", ref], { cwd: directory, token: input.token, timeoutMs: 120_000 });
    await runGit(["checkout", "--detach", "FETCH_HEAD"], { cwd: directory, token: input.token });
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: directory, token: input.token })).stdout.trim();
    return { directory, commitSha: sha, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function defaultRef(url: string, token?: string): Promise<string> {
  const result = await runGit(["ls-remote", "--symref", url, "HEAD"], { token, timeoutMs: 30_000 });
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(result.stdout);
  return match?.[1] ?? "HEAD";
}

export async function remoteHead(url: string, token?: string): Promise<{ commitSha: string; ref: string }> {
  const result = await runGit(["ls-remote", "--symref", cloneUrl(url), "HEAD"], { token, timeoutMs: 30_000 });
  const refMatch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(result.stdout);
  const shaMatch = /^([0-9a-f]{40})\s+HEAD/m.exec(result.stdout);
  if (!shaMatch) {
    throw new HubError("git-failed", "The repository did not return a commit for HEAD.");
  }
  return { commitSha: shaMatch[1], ref: refMatch?.[1] ?? "HEAD" };
}

export async function listWorkingTree(root: string): Promise<string[]> {
  const result = await runGit(["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, timeoutMs: 20_000 });
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/\\/g, "/"));
}
