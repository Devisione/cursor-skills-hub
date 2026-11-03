import { InstalledComponent, RemoteInstalled, RemoteSnapshot, SettingsState } from "./types";

export interface SyncPlan {
  action: "in-sync" | "push" | "pull" | "conflict" | "choose-repository";
  reason: string;
  toInstall: RemoteInstalled[];
  toUpdate: Array<{ remote: RemoteInstalled; local?: InstalledComponent }>;
  localOnly: InstalledComponent[];
  absentOnDisk: RemoteInstalled[];
}

export function planSync(input: {
  repository?: string;
  dirty: boolean;
  lastRemoteSha?: string;
  remoteSha?: string;
  remote?: RemoteSnapshot;
  localManaged: InstalledComponent[];
}): SyncPlan {
  if (!input.repository) {
    return empty("choose-repository", "Connect GitHub and choose a private repository.");
  }
  if (!input.remote) {
    return empty("conflict", "The GitHub configuration could not be read.");
  }
  const remoteChanged = !!input.lastRemoteSha && input.remoteSha !== input.lastRemoteSha;
  const firstContact = !input.lastRemoteSha;
  const localHasManaged = input.localManaged.length > 0;
  const remoteHasInstalled = input.remote.installed.length > 0 || input.remote.marketplaces.length > 0;
  const compared = compare(input.localManaged, input.remote);

  if (firstContact && remoteHasInstalled && localHasManaged) {
    return { ...compared, action: "conflict", reason: "This device and the GitHub repository both already contain components." };
  }
  if (firstContact && remoteHasInstalled) {
    return { ...compared, action: "pull", reason: "The GitHub configuration can be applied on this device." };
  }
  if (input.dirty && remoteChanged) {
    return { ...compared, action: "conflict", reason: "This device and another device both changed the configuration." };
  }
  if ((input.dirty || localHasManaged) && !remoteChanged && (firstContact || input.dirty)) {
    return { ...compared, action: "push", reason: firstContact ? "This device can publish the current configuration." : "Local changes are ready to send." };
  }
  if (!input.dirty && remoteChanged) {
    return { ...compared, action: "pull", reason: "The GitHub configuration has changes to apply." };
  }
  return { ...compared, action: "in-sync", reason: "This device matches GitHub." };
}

function compare(local: InstalledComponent[], remote: RemoteSnapshot): Omit<SyncPlan, "action" | "reason"> {
  const localById = new Map(local.filter((item) => item.managed).map((item) => [item.id, item]));
  const remoteIds = new Set(remote.installed.map((item) => item.id));
  const toInstall: RemoteInstalled[] = [];
  const toUpdate: SyncPlan["toUpdate"] = [];
  for (const item of remote.installed) {
    const existing = localById.get(item.id);
    if (!existing) {
      toInstall.push(item);
      continue;
    }
    if ((item.commitSha && item.commitSha !== existing.commitSha) || (item.version && item.version !== existing.version && !item.commitSha)) {
      toUpdate.push({ remote: item, local: existing });
    }
  }
  const localOnly = local.filter((item) => item.managed && !remoteIds.has(item.id));
  const absentOnDisk = remote.installed.filter((item) => {
    const existing = localById.get(item.id);
    return existing?.status === "error";
  });
  return { toInstall, toUpdate, localOnly, absentOnDisk };
}

export function describePlan(plan: SyncPlan): string {
  return `${plan.reason} To install: ${plan.toInstall.length}. To update: ${plan.toUpdate.length}. Only on this device: ${plan.localOnly.length}.`;
}

function empty(action: SyncPlan["action"], reason: string): SyncPlan {
  return { action, reason, toInstall: [], toUpdate: [], localOnly: [], absentOnDisk: [] };
}

export function settingsEqual(left: SettingsState, right: SettingsState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function nextSyncDelay(input: {
  now: number;
  interval: number;
  lastSyncedAt?: number;
  lastAttemptAt?: number;
}): number {
  const anchor = Math.max(finiteTime(input.lastSyncedAt), finiteTime(input.lastAttemptAt));
  if (!anchor) {
    return input.interval;
  }
  return Math.max(1000, anchor + input.interval - input.now);
}

export function remoteSnapshotHandled(sync: { declinedSha?: string; lastAttemptedSha?: string }, sha?: string): boolean {
  return !!sha && (sync.declinedSha === sha || sync.lastAttemptedSha === sha);
}

export function sameCommit(local?: string, remote?: string): boolean {
  if (!remote) {
    return true;
  }
  if (!local) {
    return false;
  }
  const left = local.toLowerCase();
  const right = remote.toLowerCase();
  if (left === right) {
    return true;
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

function finiteTime(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
