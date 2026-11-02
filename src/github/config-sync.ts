import {
  DEFAULT_SETTINGS,
  HubState,
  InstalledComponent,
  MarketplaceRecord,
  RemoteInstalled,
  RemoteSnapshot,
  SCHEMA_VERSION,
  SettingsState,
} from "../core/types";
import { buildLock } from "../storage/lock-manager";
import { HubError } from "../utils/errors";

export interface RemoteFiles {
  "config.json": string;
  "marketplaces.json": string;
  "installed.json": string;
  "settings.json": string;
  "lock.json": string;
}

export function includedInSync(state: HubState): { marketplaces: MarketplaceRecord[]; installed: InstalledComponent[] } {
  const hidden = new Set(state.marketplaces.filter((item) => item.excludeFromSync).map((item) => item.id));
  return {
    marketplaces: state.marketplaces.filter((item) => !item.excludeFromSync),
    installed: state.installed.filter((item) => item.managed && !item.excludeFromSync && !hidden.has(item.marketplaceId || "") && !(state.syncExcludedIds ?? []).includes(item.id)),
  };
}

export function buildRemoteFiles(state: HubState, updatedAt = new Date().toISOString()): RemoteFiles {
  const shared = includedInSync(state);
  const installed: RemoteInstalled[] = shared.installed.map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    marketplaceId: item.marketplaceId,
    repositoryUrl: item.repositoryUrl,
    pathInRepo: item.pathInRepo,
    version: item.version,
    commitSha: item.pinCommit || item.commitSha,
    scope: item.scope,
    location: item.location,
    pinned: item.pinned,
    pinCommit: item.pinCommit,
    pinVersion: item.pinVersion,
  }));
  return {
    "config.json": JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      deviceId: state.deviceId,
      updatedAt,
    }, null, 2),
    "marketplaces.json": JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      marketplaces: shared.marketplaces.map(remoteMarketplace),
    }, null, 2),
    "installed.json": JSON.stringify({ schemaVersion: SCHEMA_VERSION, components: installed }, null, 2),
    "settings.json": JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...state.settings }, null, 2),
    "lock.json": JSON.stringify({ schemaVersion: SCHEMA_VERSION, components: buildLock(shared.installed) }, null, 2),
  };
}

export function parseRemoteFiles(files: {
  config?: string;
  marketplaces?: string;
  installed?: string;
  settings?: string;
  lock?: string;
}): RemoteSnapshot {
  if (!files.config && !files.marketplaces && !files.installed && !files.settings) {
    return {
      schemaVersion: SCHEMA_VERSION,
      marketplaces: [],
      installed: [],
      settings: { ...DEFAULT_SETTINGS },
      lock: {},
    };
  }
  const config = parseObject(files.config, "config.json");
  const marketplaces = parseObject(files.marketplaces, "marketplaces.json");
  const installed = parseObject(files.installed, "installed.json");
  const settings = parseObject(files.settings, "settings.json");
  const lock = parseObject(files.lock, "lock.json");
  assertSchema(config.schemaVersion, "config.json");
  assertSchema(marketplaces.schemaVersion, "marketplaces.json");
  assertSchema(installed.schemaVersion, "installed.json");
  assertSchema(settings.schemaVersion, "settings.json");
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: asString(config.deviceId),
    updatedAt: asString(config.updatedAt),
    marketplaces: Array.isArray(marketplaces.marketplaces) ? marketplaces.marketplaces as RemoteSnapshot["marketplaces"] : [],
    installed: Array.isArray(installed.components) ? installed.components as RemoteInstalled[] : [],
    settings: { ...DEFAULT_SETTINGS, ...stripSchema(settings) } as SettingsState,
    lock: (lock.components && typeof lock.components === "object" ? lock.components : {}) as RemoteSnapshot["lock"],
  };
}

export function remoteReadme(): string {
  return `# Cursor Skills Hub

This private repository is the configuration for Cursor Skills Hub.

It records connected marketplaces, installed skills and plugins, update settings, and exact versions.
The marketplace catalogs themselves are indexed on each device and are not stored here.
`;
}

function remoteMarketplace(record: MarketplaceRecord) {
  return {
    id: record.id,
    url: record.url,
    normalizedUrl: record.normalizedUrl,
    type: record.type,
    name: record.name,
    autoRefresh: record.autoRefresh,
    trusted: record.trusted,
  };
}

function parseObject(text: string | undefined, label: string): Record<string, unknown> {
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HubError("corrupt-remote", `${label} in the GitHub repository is not valid configuration.`);
  }
}

function assertSchema(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "number" && value > SCHEMA_VERSION) {
    throw new HubError("unsupported-remote", `${label} was written by a newer Skills Hub and cannot be applied.`);
  }
}

function stripSchema(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.schemaVersion;
  return copy;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
