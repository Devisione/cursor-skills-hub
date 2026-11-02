import { DiscoveredPlugin } from "../plugins/plugin-discovery";
import { DiscoveredSkill } from "../skills/skill-discovery";
import { repoSlug } from "../utils/github-url";
import { ComponentStatus, HubState, InstalledComponent } from "./types";

export function reconcileInstalled(state: HubState, skills: DiscoveredSkill[], plugins: DiscoveredPlugin[]): void {
  const seen = new Set<string>();
  for (const disk of [...skills, ...plugins]) {
    const managed = state.installed.find((item) => item.managed && pathsEqual(item.installPath, disk.installPath));
    if (managed) {
      seen.add(managed.id);
      managed.checksum = managed.checksum ?? disk.checksum;
      managed.description = managed.description || disk.description;
      applyOrigin(managed, disk);
      applyDiskStatus(managed, disk.checksum, false);
      continue;
    }
    const unmanaged = state.installed.find((item) => !item.managed && pathsEqual(item.installPath, disk.installPath));
    if (unmanaged) {
      seen.add(unmanaged.id);
      unmanaged.checksum = disk.checksum;
      unmanaged.name = disk.name;
      unmanaged.description = disk.description;
      applyOrigin(unmanaged, disk);
      applyDiskStatus(unmanaged, disk.checksum, false);
      continue;
    }
    const now = new Date().toISOString();
    const isPlugin = disk.location === "plugins-local" || disk.location === "plugins-project";
    const version = "version" in disk && typeof disk.version === "string" ? disk.version : undefined;
    state.installed.push({
      id: disk.id,
      type: isPlugin ? "plugin" : "skill",
      name: disk.name,
      description: disk.description,
      version,
      checksum: disk.checksum,
      scope: disk.scope,
      location: disk.location,
      installPath: disk.installPath,
      pinned: false,
      status: "not-synchronized",
      updateAvailable: false,
      installedAt: now,
      updatedAt: now,
      managed: false,
      ...originOf(disk),
    });
    seen.add(disk.id);
  }
  for (const item of state.installed) {
    if (seen.has(item.id)) {
      continue;
    }
    if (!item.managed) {
      continue;
    }
    const stillThere = [...skills, ...plugins].some((disk) => pathsEqual(disk.installPath, item.installPath));
    if (!stillThere) {
      item.status = "error";
      item.lastError = "Installed files are missing.";
    }
  }
  state.installed = state.installed.filter((item) => item.managed || seen.has(item.id));
}

function applyOrigin(item: InstalledComponent, disk: DiscoveredSkill | DiscoveredPlugin): void {
  const origin = originOf(disk);
  if (origin.bundleId) {
    item.bundleId = origin.bundleId;
    item.bundleName = origin.bundleName;
    item.bundleUrl = origin.bundleUrl;
  } else if (item.repositoryUrl) {
    const slug = repoSlug(item.repositoryUrl);
    item.bundleId = `repo:${slug}`;
    item.bundleName = slug;
    item.bundleUrl = item.repositoryUrl;
  } else {
    item.bundleId = undefined;
    item.bundleName = undefined;
    item.bundleUrl = undefined;
  }
  item.enabled = origin.enabled;
  if (origin.pathInRepo) {
    item.pathInRepo = origin.pathInRepo;
  }
}

function originOf(disk: DiscoveredSkill | DiscoveredPlugin): Pick<InstalledComponent, "bundleId" | "bundleName" | "bundleUrl" | "pathInRepo" | "enabled"> {
  if (!("enabled" in disk)) {
    return { enabled: true };
  }
  return {
    bundleId: disk.bundleId,
    bundleName: disk.bundleName,
    bundleUrl: disk.bundleUrl,
    pathInRepo: disk.pathInRepo,
    enabled: disk.enabled,
  };
}

function applyDiskStatus(item: InstalledComponent, diskChecksum: string, missing: boolean): void {
  if (missing) {
    item.status = "error";
    item.lastError = "Installed files are missing.";
    return;
  }
  item.lastError = undefined;
  if (item.checksum && diskChecksum && item.checksum !== diskChecksum) {
    item.status = "local-changes";
    return;
  }
  item.status = statusFromFlags(item);
}

export function statusFromFlags(item: Pick<InstalledComponent, "pinned" | "updateAvailable" | "managed" | "status">): ComponentStatus {
  if (item.status === "installing") {
    return "installing";
  }
  if (item.pinned) {
    return "pinned";
  }
  if (item.updateAvailable) {
    return "update-available";
  }
  if (!item.managed) {
    return "not-synchronized";
  }
  return "up-to-date";
}

function pathsEqual(left: string, right: string): boolean {
  return left.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === right.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}
