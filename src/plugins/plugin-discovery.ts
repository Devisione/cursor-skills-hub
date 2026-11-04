import { createHash } from "crypto";
import { readdir } from "fs/promises";
import path from "path";
import { InstallLocation, InstallScope } from "../core/types";
import { scannedPluginRoots, WorkspaceHint } from "../core/paths";
import { checksumDirectory, pathExists } from "../utils/filesystem";
import { isRoutingPlugin } from "../routing/instruction";
import { validatePluginDirectory } from "./plugin-validator";

export interface DiscoveredPlugin {
  id: string;
  name: string;
  description: string;
  version?: string;
  installPath: string;
  scope: InstallScope;
  location: InstallLocation;
  checksum: string;
}

export async function discoverInstalledPlugins(workspace?: WorkspaceHint): Promise<DiscoveredPlugin[]> {
  const found: DiscoveredPlugin[] = [];
  for (const root of scannedPluginRoots(workspace)) {
    if (!(await pathExists(root.root))) {
      continue;
    }
    const entries = await readdir(root.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || isRoutingPlugin(entry.name)) {
        continue;
      }
      const directory = path.join(root.root, entry.name);
      try {
        const manifest = await validatePluginDirectory(directory);
        found.push({
          id: `local_${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          installPath: directory,
          scope: root.scope,
          location: root.location,
          checksum: await checksumDirectory(directory),
        });
      } catch {
        continue;
      }
    }
  }
  return found;
}
