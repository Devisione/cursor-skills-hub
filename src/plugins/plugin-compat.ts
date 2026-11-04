import { rename } from "fs/promises";
import path from "path";
import { pathExists, readJson, writeJsonAtomic } from "../utils/filesystem";
import { isUnsafeRelativePath } from "../utils/security";

const CLAUDE_EVENTS: Record<string, string> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  UserPromptSubmit: "beforeSubmitPrompt",
  Stop: "stop",
  SubagentStop: "subagentStop",
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  PreCompact: "preCompact",
};

const TOOL_MATCHERS: Record<string, string> = {
  Bash: "Shell",
  Edit: "Write",
};

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdc", ".markdown", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".ps1", ".yml", ".yaml", ".toml", ".html", ".css",
]);

export async function preparePluginDirectory(root: string): Promise<boolean> {
  let changed = await ensureCursorManifest(root);
  changed = await retireAgentManifest(root) || changed;
  changed = await normalizeHooks(root) || changed;
  changed = await normalizeMcp(root) || changed;
  changed = await replaceTokensInTree(root) || changed;
  return changed;
}

export function cursorHooksFrom(value: unknown): { version: number; hooks: Record<string, Array<Record<string, unknown>>> } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { version?: unknown; hooks?: unknown };
  if (!record.hooks || typeof record.hooks !== "object" || Array.isArray(record.hooks)) {
    return undefined;
  }
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const [name, entries] of Object.entries(record.hooks as Record<string, unknown>)) {
    const event = CLAUDE_EVENTS[name] ?? (/^[a-z]/.test(name) ? name : "");
    if (!event) {
      continue;
    }
    const list = flattenHooks(entries);
    if (list.length === 0) {
      continue;
    }
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  return {
    version: typeof record.version === "number" ? record.version : 1,
    hooks,
  };
}

export function replaceCursorTokens(value: string): string {
  return value
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", "${CURSOR_PLUGIN_ROOT}")
    .replaceAll("${PLUGIN_ROOT}", "${CURSOR_PLUGIN_ROOT}");
}

async function ensureCursorManifest(root: string): Promise<boolean> {
  const cursorFile = path.join(root, ".cursor-plugin", "plugin.json");
  if (await pathExists(cursorFile)) {
    return false;
  }
  const source = await readJson<Record<string, unknown>>(path.join(root, ".claude-plugin", "plugin.json"))
    ?? await readJson<Record<string, unknown>>(path.join(root, "plugin.json"));
  if (!source || typeof source.name !== "string" || !source.name) {
    return false;
  }
  const manifest = { ...source };
  if (!manifest.skills && await pathExists(path.join(root, "skills"))) {
    manifest.skills = "skills";
  }
  if (!manifest.agents && await pathExists(path.join(root, "agents"))) {
    manifest.agents = "agents";
  }
  if (!manifest.hooks && await pathExists(path.join(root, "hooks", "hooks.json"))) {
    manifest.hooks = "hooks/hooks.json";
  }
  await writeJsonAtomic(cursorFile, manifest);
  return true;
}

async function retireAgentManifest(root: string): Promise<boolean> {
  const cursorFile = path.join(root, ".cursor-plugin", "plugin.json");
  const agentFile = path.join(root, "plugin.json");
  const aside = path.join(root, "plugin.agent.json");
  if (!(await pathExists(cursorFile)) || !(await pathExists(agentFile)) || await pathExists(aside)) {
    return false;
  }
  await rename(agentFile, aside);
  return true;
}

async function normalizeHooks(root: string): Promise<boolean> {
  const manifest = await readJson<Record<string, unknown>>(path.join(root, ".cursor-plugin", "plugin.json"));
  const relative = typeof manifest?.hooks === "string" && !isUnsafeRelativePath(manifest.hooks) ? manifest.hooks : "hooks/hooks.json";
  const file = path.join(root, relative);
  const current = await readJson<unknown>(file);
  if (!current) {
    return false;
  }
  const converted = cursorHooksFrom(current);
  if (!converted) {
    return false;
  }
  return writeJsonIfChanged(file, converted);
}

async function normalizeMcp(root: string): Promise<boolean> {
  const target = path.join(root, "mcp.json");
  if (!(await pathExists(target))) {
    const claude = await readJson<unknown>(path.join(root, ".mcp.json"));
    if (!claude) {
      return false;
    }
    await writeJsonAtomic(target, JSON.parse(replaceCursorTokens(JSON.stringify(claude))));
    return true;
  }
  const current = await readJson<unknown>(target);
  if (!current) {
    return false;
  }
  const next = JSON.parse(replaceCursorTokens(JSON.stringify(current))) as unknown;
  return writeJsonIfChanged(target, next);
}

async function replaceTokensInTree(root: string): Promise<boolean> {
  const { readdir, readFile, writeFile } = await import("fs/promises");
  let changed = false;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !isTextFile(entry.name)) {
        continue;
      }
      const content = await readFile(full);
      if (content.includes(0) || content.length > 512_000) {
        continue;
      }
      const text = content.toString("utf8");
      const next = replaceCursorTokens(text);
      if (next === text) {
        continue;
      }
      await writeFile(full, next, "utf8");
      changed = true;
    }
  };
  if (await pathExists(root)) {
    await visit(root);
  }
  return changed;
}

function flattenHooks(entries: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(entries)) {
    return [];
  }
  const result: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const groupMatcher = mapMatcher(typeof item.matcher === "string" ? item.matcher : undefined);
    if (Array.isArray(item.hooks)) {
      for (const inner of item.hooks) {
        const hook = oneHook(inner, groupMatcher);
        if (hook) {
          result.push(hook);
        }
      }
      continue;
    }
    const hook = oneHook(item, groupMatcher);
    if (hook) {
      result.push(hook);
    }
  }
  return result;
}

function oneHook(value: unknown, groupMatcher: string | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  const command = typeof item.command === "string" ? replaceCursorTokens(item.command) : undefined;
  const prompt = typeof item.prompt === "string" ? replaceCursorTokens(item.prompt) : undefined;
  if (!command && !prompt) {
    return undefined;
  }
  const hook: Record<string, unknown> = { ...item };
  delete hook.hooks;
  if (command) {
    hook.command = command;
  }
  if (prompt) {
    hook.prompt = prompt;
  }
  const matcher = mapMatcher(typeof item.matcher === "string" ? item.matcher : undefined) ?? groupMatcher;
  if (matcher) {
    hook.matcher = matcher;
  }
  return hook;
}

function mapMatcher(matcher: string | undefined): string | undefined {
  if (!matcher) {
    return undefined;
  }
  return matcher.split("|").map((part) => TOOL_MATCHERS[part] ?? part).join("|");
}

async function writeJsonIfChanged(file: string, value: unknown): Promise<boolean> {
  const next = JSON.stringify(value);
  const current = await readJson<unknown>(file);
  if (current && JSON.stringify(current) === next) {
    return false;
  }
  await writeJsonAtomic(file, value);
  return true;
}

function isTextFile(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  return extension === "" || TEXT_EXTENSIONS.has(extension);
}
