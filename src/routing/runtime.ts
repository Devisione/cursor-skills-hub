import { readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { pathExists, writeJsonAtomic } from "../utils/filesystem";

const ROUTING_PLUGIN_NAME = "skills-hub-routing";

export async function removeInstalledRouting(): Promise<boolean> {
  let changed = false;
  const pluginRoot = path.join(os.homedir(), ".cursor", "plugins", "local", ROUTING_PLUGIN_NAME);
  if (await pathExists(pluginRoot)) {
    await rm(pluginRoot, { recursive: true, force: true });
    changed = true;
  }
  const hooksDirectory = path.join(os.homedir(), ".cursor", "hooks");
  for (const name of ["skills-hub-route.ps1", "skills-hub-route.sh"]) {
    const launcher = path.join(hooksDirectory, name);
    if (await pathExists(launcher)) {
      await rm(launcher, { force: true });
      changed = true;
    }
  }
  const hooksFile = path.join(os.homedir(), ".cursor", "hooks.json");
  if (!(await pathExists(hooksFile))) {
    return changed;
  }
  let current: unknown;
  try {
    current = JSON.parse(await readFile(hooksFile, "utf8")) as unknown;
  } catch {
    return changed;
  }
  const stripped = stripRoutingHooks(current);
  if (!stripped.changed) {
    return changed;
  }
  await writeJsonAtomic(hooksFile, stripped.value);
  return true;
}

export function stripRoutingHooks(current: unknown): { value: Record<string, unknown>; changed: boolean } {
  const source = current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  const incoming = source.hooks && typeof source.hooks === "object" && !Array.isArray(source.hooks)
    ? source.hooks as Record<string, unknown>
    : {};
  const hooks: Record<string, unknown> = {};
  let changed = false;
  for (const [event, value] of Object.entries(incoming)) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const kept = value.filter((item) => !isRoutingCommand(item));
    if (kept.length !== value.length) {
      changed = true;
    }
    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }
  return {
    changed,
    value: {
      ...source,
      version: typeof source.version === "number" ? source.version : 1,
      hooks,
    },
  };
}

function isRoutingCommand(item: unknown): boolean {
  return !!item && typeof item === "object" && typeof (item as { command?: unknown }).command === "string"
    && (item as { command: string }).command.includes("skills-hub-route");
}
