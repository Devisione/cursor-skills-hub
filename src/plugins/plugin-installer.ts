import path from "path";
import { CatalogComponent, CancelFlag, InstallScope } from "../core/types";
import { installRoot, WorkspaceHint } from "../core/paths";
import { HubError } from "../utils/errors";
import { checksumDirectory, copyTree, ensureDir, moveAside, pathExists, removeTree } from "../utils/filesystem";
import { materializeRepo } from "../utils/git";
import { validatePluginDirectory } from "./plugin-validator";

export async function installPlugin(input: {
  component: CatalogComponent;
  scope: InstallScope;
  workspace?: WorkspaceHint;
  ref?: string;
  token?: string;
  backup?: (currentPath: string) => Promise<string | undefined>;
  cancel?: CancelFlag;
}): Promise<{
  name: string;
  description: string;
  version?: string;
  installPath: string;
  commitSha: string;
  checksum: string;
  location: "plugins-local" | "plugins-project";
  scope: InstallScope;
  note: string;
  backupPath?: string;
}> {
  const location = input.scope === "project" ? "plugins-project" : "plugins-local";
  const root = installRoot(input.scope, location, input.workspace);
  await ensureDir(root);
  const materialized = await materializeRepo({
    url: input.component.repositoryUrl,
    ref: input.ref || input.component.commitSha,
    subpath: input.component.pathInRepo || undefined,
    token: input.token,
  });
  let staging: string | undefined;
  try {
    if (input.cancel?.isCancellationRequested) {
      throw new HubError("cancelled", "The installation was cancelled.");
    }
    const source = path.join(materialized.directory, input.component.pathInRepo);
    const manifest = await validatePluginDirectory(source);
    const destination = path.join(root, manifest.name);
    staging = `${destination}.staging`;
    if (await pathExists(staging)) {
      await removeTree(staging, root);
    }
    await copyTree(source, staging);
    await validatePluginDirectory(staging);
    let backupPath: string | undefined;
    if (await pathExists(destination)) {
      backupPath = await input.backup?.(destination);
      const aside = `${destination}.previous`;
      if (await pathExists(aside)) {
        await removeTree(aside, root);
      }
      await moveAside(destination, aside);
    }
    try {
      await moveAside(staging, destination);
    } catch (error) {
      const aside = `${destination}.previous`;
      if (await pathExists(aside) && !(await pathExists(destination))) {
        await moveAside(aside, destination);
      }
      throw error;
    }
    const aside = `${destination}.previous`;
    if (await pathExists(aside)) {
      await removeTree(aside, root);
    }
    return {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      installPath: destination,
      commitSha: materialized.commitSha,
      checksum: await checksumDirectory(destination),
      location,
      scope: input.scope,
      note: "Cursor loads plugins from this directory. Reload the window if the plugin does not appear.",
      backupPath,
    };
  } finally {
    if (staging && await pathExists(staging)) {
      await removeTree(staging, root).catch(() => undefined);
    }
    await materialized.cleanup();
  }
}

export async function uninstallPlugin(installPath: string, scope: InstallScope, location: "plugins-local" | "plugins-project", workspace?: WorkspaceHint): Promise<void> {
  const root = installRoot(scope, location, workspace);
  await removeTree(installPath, root);
}
