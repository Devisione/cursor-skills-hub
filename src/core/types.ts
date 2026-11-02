export const SCHEMA_VERSION = 1;

export type ComponentType = "skill" | "plugin";
export type InstallScope = "user" | "project";
export type SkillLocation = "cursor-skills" | "agents-skills";
export type InstallLocation = SkillLocation | "agent-store" | "skills-cursor" | "plugin-skill" | "plugins-local" | "plugins-project";
export type UpdateMode = "manual" | "notify" | "auto";
export type ConflictPolicy = "ask" | "keep-local" | "keep-remote";
export type SyncFrequency = "off" | "startup" | "hourly" | "daily";
export type MarketplaceKind = "cursor-marketplace" | "skills-catalog" | "cursor-plugin" | "agent-plugin";
export type SyncStatus = "disconnected" | "synchronized" | "local-changes" | "remote-changes" | "conflict" | "error";
export type ComponentStatus =
  | "available"
  | "up-to-date"
  | "update-available"
  | "installing"
  | "error"
  | "local-changes"
  | "conflict"
  | "not-synchronized"
  | "pinned";

export interface CatalogComponent {
  id: string;
  type: ComponentType;
  name: string;
  description: string;
  author?: string;
  marketplaceId: string;
  repositoryUrl: string;
  pathInRepo: string;
  version?: string;
  commitSha?: string;
  categories: string[];
  capabilities: string[];
  dependencies: string[];
  checkedAt: string;
}

export interface InstalledComponent {
  id: string;
  type: ComponentType;
  name: string;
  description: string;
  author?: string;
  marketplaceId?: string;
  repositoryUrl?: string;
  pathInRepo?: string;
  version?: string;
  commitSha?: string;
  checksum?: string;
  scope: InstallScope;
  location: InstallLocation;
  installPath: string;
  pinned: boolean;
  pinCommit?: string;
  pinVersion?: string;
  status: ComponentStatus;
  updateAvailable: boolean;
  latestCommit?: string;
  latestVersion?: string;
  lastError?: string;
  installedAt: string;
  updatedAt: string;
  managed: boolean;
  excludeFromSync?: boolean;
  bundleId?: string;
  bundleName?: string;
  bundleUrl?: string;
  enabled?: boolean;
  previous?: {
    version?: string;
    commitSha?: string;
    checksum?: string;
    backupPath: string;
    updatedAt: string;
  };
}

export interface MarketplaceRecord {
  id: string;
  url: string;
  normalizedUrl: string;
  type: MarketplaceKind;
  name?: string;
  autoRefresh: boolean;
  trusted: boolean;
  componentCount: number;
  lastTreeSha?: string;
  lastCommitSha?: string;
  lastError?: string;
  lastRefreshedAt?: string;
  addedAt: string;
  excludeFromSync?: boolean;
}

export interface SettingsState {
  syncFrequency: SyncFrequency;
  automaticMarketplaceRefresh: boolean;
  automaticUpdateChecks: boolean;
  updateMode: UpdateMode;
  updateNotifications: boolean;
  backupBeforeUpdate: boolean;
  conflictResolution: ConflictPolicy;
  installationScope: InstallScope;
  defaultSkillLocation: SkillLocation;
  autoApproveTrustedInstalls: boolean;
  githubRepository: string;
}

export interface SyncState {
  lastRemoteSha?: string;
  lastSyncedAt?: string;
  dirty: boolean;
  status: SyncStatus;
  lastError?: string;
}

export interface HubState {
  schemaVersion: number;
  deviceId: string;
  marketplaces: MarketplaceRecord[];
  installed: InstalledComponent[];
  settings: SettingsState;
  sync: SyncState;
  lastUpdateCheckAt?: string;
  lastMarketplaceRefreshAt?: string;
  gridClaimReleased?: boolean;
  syncExcludedIds?: string[];
}

export interface RemoteInstalled {
  id: string;
  type: ComponentType;
  name: string;
  marketplaceId?: string;
  repositoryUrl?: string;
  pathInRepo?: string;
  version?: string;
  commitSha?: string;
  scope: InstallScope;
  location: InstallLocation;
  pinned: boolean;
  pinCommit?: string;
  pinVersion?: string;
}

export interface RemoteSnapshot {
  schemaVersion: number;
  deviceId?: string;
  updatedAt?: string;
  marketplaces: Array<Pick<MarketplaceRecord, "id" | "url" | "normalizedUrl" | "type" | "name" | "autoRefresh" | "trusted">>;
  installed: RemoteInstalled[];
  settings: SettingsState;
  lock: Record<string, { version?: string; commitSha?: string; checksum?: string; installedAt?: string }>;
}

export const DEFAULT_SETTINGS: SettingsState = {
  syncFrequency: "daily",
  automaticMarketplaceRefresh: true,
  automaticUpdateChecks: true,
  updateMode: "notify",
  updateNotifications: true,
  backupBeforeUpdate: true,
  conflictResolution: "ask",
  installationScope: "user",
  defaultSkillLocation: "cursor-skills",
  autoApproveTrustedInstalls: false,
  githubRepository: "",
};

export interface CancelFlag {
  readonly isCancellationRequested: boolean;
}

export interface UserConsent {
  confirm(message: string, detail?: string): Promise<boolean>;
}
