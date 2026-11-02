import path from "path";
import { copyTree, ensureDir, isInside, moveAside, pathExists, removeTree } from "../utils/filesystem";

export class BackupManager {
  constructor(private readonly root: string) {}

  directory(): string {
    return this.root;
  }

  async keep(componentId: string, sourceDirectory: string): Promise<string> {
    const destination = path.join(this.root, safeId(componentId), new Date().toISOString().replace(/[:.]/g, "-"));
    await ensureDir(path.dirname(destination));
    if (!(await pathExists(sourceDirectory))) {
      throw new Error("Nothing to back up.");
    }
    await copyTree(sourceDirectory, destination);
    return destination;
  }

  async restore(backupPath: string, destination: string, allowedRoot: string): Promise<void> {
    if (!(await pathExists(backupPath))) {
      throw new Error("The backup for this component is missing.");
    }
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedDestination = path.resolve(destination);
    if (!isInside(resolvedRoot, resolvedDestination) || resolvedRoot === resolvedDestination) {
      throw new Error("Refusing to restore outside the install root.");
    }
    const staging = `${resolvedDestination}.restore`;
    if (await pathExists(staging)) {
      await removeTree(staging, resolvedRoot);
    }
    await copyTree(backupPath, staging);
    try {
      if (await pathExists(resolvedDestination)) {
        await removeTree(resolvedDestination, resolvedRoot);
      }
      await moveAside(staging, resolvedDestination);
    } catch (error) {
      if (await pathExists(staging)) {
        await removeTree(staging, resolvedRoot).catch(() => undefined);
      }
      throw error;
    }
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
