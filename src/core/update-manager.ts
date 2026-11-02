import { statusFromFlags } from "./reconcile";
import { InstalledComponent } from "./types";
import { remoteHead } from "../utils/git";
import { Logger } from "../utils/logger";
import { errorMessage } from "../utils/errors";
import { shortSha } from "./version-manager";

export async function checkInstalledUpdates(input: {
  installed: InstalledComponent[];
  token?: string;
  logger: Logger;
}): Promise<void> {
  const groups = new Map<string, InstalledComponent[]>();
  for (const item of input.installed) {
    if (!item.managed || !item.repositoryUrl) {
      continue;
    }
    const list = groups.get(item.repositoryUrl) ?? [];
    list.push(item);
    groups.set(item.repositoryUrl, list);
  }
  for (const [url, items] of groups) {
    try {
      const head = await remoteHead(url, input.token);
      for (const item of items) {
        const current = item.pinCommit || item.commitSha;
        item.latestCommit = head.commitSha;
        item.latestVersion = shortSha(head.commitSha);
        item.updateAvailable = !!current && current !== head.commitSha;
        if (item.status !== "local-changes" && item.status !== "error" && item.status !== "installing") {
          item.status = statusFromFlags(item);
        }
      }
    } catch (error) {
      input.logger.error("update", `${url}: ${errorMessage(error)}`);
      for (const item of items) {
        item.lastError = errorMessage(error);
      }
    }
  }
}

export function updatesFor(installed: InstalledComponent[], includePinned = false): InstalledComponent[] {
  return installed.filter((item) => item.managed && item.updateAvailable && item.status !== "local-changes" && item.status !== "error" && (includePinned || !item.pinned));
}
