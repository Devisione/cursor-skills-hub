import { chmod, readFile, readdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { discoverInstalledPlugins } from "../plugins/plugin-discovery";
import { discoverInstalledSkills } from "../skills/skill-discovery";
import { ensureDir, pathExists, writeJsonAtomic } from "../utils/filesystem";
import { parseFrontmatter } from "../utils/frontmatter";
import { InstallScope } from "../core/types";
import {
  isRoutingCommand,
  isRoutingPlugin,
  mergeRoutingHooks,
  renderSessionContext,
  ROUTING_INSTRUCTIONS,
  ROUTING_PLUGIN_NAME,
  RoutedItem,
  routingRule,
} from "./instruction";

export async function installRouting(hookScript: string, electronPath: string): Promise<{ needsReload: boolean }> {
  const pluginAdded = await writeRoutingPlugin();
  const hookAdded = await writeRoutingHook(hookScript, electronPath);
  return { needsReload: pluginAdded || hookAdded };
}

export async function handleRoutingHook(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (input.hook_event_name !== "sessionStart") {
    return {};
  }
  try {
    const roots = Array.isArray(input.workspace_roots)
      ? input.workspace_roots.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    return { additional_context: renderSessionContext(await loadRoutingCatalog(roots)) };
  } catch {
    return { additional_context: ROUTING_INSTRUCTIONS };
  }
}

async function loadRoutingCatalog(roots: string[]): Promise<RoutedItem[]> {
  const workspaces = roots.length > 0 ? roots : [undefined];
  const items: RoutedItem[] = [];
  const seen = new Set<string>();
  const add = (item: RoutedItem) => {
    const key = item.file.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key) || key.includes(`/${ROUTING_PLUGIN_NAME}/`)) {
      return;
    }
    seen.add(key);
    items.push(item);
  };
  for (const workspacePath of workspaces) {
    const hint = workspacePath ? { workspacePath } : undefined;
    for (const skill of await discoverInstalledSkills(hint)) {
      if (!skill.enabled || skill.location === "skills-cursor" || isRoutingPlugin(skill.installPath)) {
        continue;
      }
      add({
        kind: "skill",
        name: skill.name,
        description: skill.description,
        file: path.join(skill.installPath, "SKILL.md"),
        scope: skill.scope,
      });
    }
    for (const plugin of await discoverInstalledPlugins(hint)) {
      if (isRoutingPlugin(plugin.installPath)) {
        continue;
      }
      for (const item of await markdownComponents(path.join(plugin.installPath, "commands"), "command", plugin.scope)) {
        add(item);
      }
      for (const item of await markdownComponents(path.join(plugin.installPath, "agents"), "agent", plugin.scope)) {
        add(item);
      }
    }
  }
  return items;
}

async function markdownComponents(directory: string, kind: "command" | "agent", scope: InstallScope): Promise<RoutedItem[]> {
  if (!(await pathExists(directory))) {
    return [];
  }
  const items: RoutedItem[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(md|mdc|markdown|txt)$/i.test(entry.name)) {
      continue;
    }
    const file = path.join(directory, entry.name);
    const frontmatter = parseFrontmatter(await readFile(file, "utf8"));
    items.push({
      kind,
      name: frontmatter.name || entry.name.replace(/\.(md|mdc|markdown|txt)$/i, ""),
      description: frontmatter.description ?? "",
      file,
      scope,
    });
  }
  return items;
}

async function writeRoutingPlugin(): Promise<boolean> {
  const root = path.join(os.homedir(), ".cursor", "plugins", "local", ROUTING_PLUGIN_NAME);
  const created = !(await pathExists(root));
  await ensureDir(path.join(root, ".cursor-plugin"));
  await writeJsonAtomic(path.join(root, ".cursor-plugin", "plugin.json"), {
    name: ROUTING_PLUGIN_NAME,
    displayName: "Skills Hub routing",
    description: "Follow installed skills and plugin flows on every message.",
    version: "1.0.0",
    rules: "rules",
  });
  const rule = path.join(root, "rules", "use-skills.mdc");
  await ensureDir(path.dirname(rule));
  await writeFile(rule, routingRule(), "utf8");
  return created;
}

async function writeRoutingHook(hookScript: string, electronPath: string): Promise<boolean> {
  const directory = path.join(os.homedir(), ".cursor", "hooks");
  await ensureDir(directory);
  const launcher = path.join(directory, process.platform === "win32" ? "skills-hub-route.ps1" : "skills-hub-route.sh");
  const body = process.platform === "win32"
    ? `\uFEFF$env:ELECTRON_RUN_AS_NODE = '1'\r\n& ${psQuote(electronPath)} ${psQuote(hookScript)}\r\n`
    : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shQuote(electronPath)} ${shQuote(hookScript)}\n`;
  await writeFile(launcher, body, "utf8");
  if (process.platform !== "win32") {
    await chmod(launcher, 0o755);
  }
  const hooksFile = path.join(os.homedir(), ".cursor", "hooks.json");
  let current: unknown = { version: 1, hooks: {} };
  if (await pathExists(hooksFile)) {
    current = JSON.parse(await readFile(hooksFile, "utf8")) as unknown;
  }
  const had = hasRoutingHook(current);
  await writeJsonAtomic(hooksFile, mergeRoutingHooks(current, hookCommand(launcher)));
  return !had;
}

function hasRoutingHook(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = (value as { hooks?: { sessionStart?: unknown } }).hooks?.sessionStart;
  return Array.isArray(session) && session.some((item) => !!item && typeof item === "object" && isRoutingCommand(item as Record<string, unknown>));
}

function hookCommand(launcher: string): string {
  if (process.platform === "win32") {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcher.replace(/"/g, '\\"')}"`;
  }
  return `/bin/sh ${shQuote(launcher)}`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let result: Record<string, unknown> = {};
  try {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    const input = text ? JSON.parse(text) as Record<string, unknown> : {};
    result = await handleRoutingHook(input);
  } catch {
    result = {};
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  void main();
}
