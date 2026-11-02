import { readFile } from "fs/promises";
import path from "path";
import { HubError } from "../utils/errors";
import { isInside } from "../utils/filesystem";
import { isSafeComponentName } from "../utils/security";

export interface PluginManifest {
  name: string;
  description: string;
  version?: string;
  author?: string;
  keywords: string[];
  format: "cursor-plugin" | "agent-plugin";
  root: string;
}

export async function validatePluginDirectory(root: string): Promise<PluginManifest> {
  const resolved = path.resolve(root);
  const cursorManifest = path.join(resolved, ".cursor-plugin", "plugin.json");
  const agentManifest = path.join(resolved, "plugin.json");
  const cursor = await readManifest(cursorManifest, resolved);
  const agent = cursor ? undefined : await readManifest(agentManifest, resolved);
  const manifest = cursor ?? agent;
  if (!manifest) {
    throw new HubError("invalid-plugin", "The directory has no .cursor-plugin/plugin.json or plugin.json manifest.");
  }
  if (!isSafeComponentName(manifest.name)) {
    throw new HubError("invalid-plugin", `Plugin name "${manifest.name}" must be a lowercase kebab-case identifier.`);
  }
  return {
    ...manifest,
    format: cursor ? "cursor-plugin" : "agent-plugin",
    root: resolved,
  };
}

async function readManifest(file: string, root: string): Promise<Omit<PluginManifest, "format" | "root"> | undefined> {
  if (!isInside(root, file)) {
    return undefined;
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(text) as {
    name?: string;
    description?: string;
    version?: string;
    author?: { name?: string } | string;
    keywords?: string[];
  };
  if (!parsed.name) {
    throw new HubError("invalid-plugin", "plugin.json is missing a name.");
  }
  const author = typeof parsed.author === "string" ? parsed.author : parsed.author?.name;
  return {
    name: parsed.name,
    description: (parsed.description ?? "").slice(0, 2000),
    version: parsed.version,
    author,
    keywords: parsed.keywords ?? [],
  };
}
