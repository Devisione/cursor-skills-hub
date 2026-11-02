import { InstalledComponent } from "../core/types";

export interface LockEntry {
  version?: string;
  commitSha?: string;
  checksum?: string;
  installedAt?: string;
}

export function buildLock(installed: InstalledComponent[]): Record<string, LockEntry> {
  const lock: Record<string, LockEntry> = {};
  for (const item of installed.filter((entry) => entry.managed)) {
    lock[item.id] = {
      version: item.pinVersion || item.version,
      commitSha: item.pinCommit || item.commitSha,
      checksum: item.checksum,
      installedAt: item.installedAt,
    };
  }
  return lock;
}
