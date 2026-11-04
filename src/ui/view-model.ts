import { CatalogComponent, ComponentStatus, HubState, InstalledComponent, MarketplaceRecord, SettingsState } from "../core/types";
import { ApiProbe } from "../core/api-probe";
import { displayVersion } from "../core/version-manager";

export interface CardModel {
  id: string;
  type: "skill" | "plugin";
  name: string;
  description: string;
  author: string;
  source: string;
  version: string;
  availableVersion: string;
  status: ComponentStatus | "available";
  statusLabel: string;
  installed: boolean;
  pinned: boolean;
  updateAvailable: boolean;
  action: "install" | "update" | "uninstall";
  group: "yours" | "builtin" | "plugin" | "catalog" | "personal";
  place: string;
  readOnly: boolean;
  managed: boolean;
  bundleId: string;
  bundleName: string;
  bundleUrl: string;
  enabled: boolean;
  canToggle: boolean;
  repoUrl: string;
  githubUrl: string;
  pathLabel: string;
  marketplaceId: string;
  syncLocal: boolean;
  marketLocal: boolean;
  canSync: boolean;
}

export interface ExtensionReleaseStatus {
  version: string;
  latest: string;
  phase: "current" | "available" | "installed";
}

export interface ViewModel {
  extension: ExtensionReleaseStatus;
  overview: {
    installed: number;
    updates: number;
    syncLabel: string;
    errors: number;
    marketplaces: number;
    lastCheckedAt: string;
  };
  catalog: CardModel[];
  installed: CardModel[];
  updates: CardModel[];
  marketplaces: Array<MarketplaceRecord & { statusLabel: string }>;
  settings: SettingsState;
  github: { connected: boolean; login?: string; repository: string; syncStatus: string; lastSyncedAt: string; nextSyncAt: string; syncError: string };
  conflict?: { reason: string };
  busy: boolean;
  probe: ApiProbe;
  errors: Array<{ at: string; area: string; message: string }>;
}

export function buildViewModel(input: {
  state: HubState;
  catalog: CatalogComponent[];
  githubConnected: boolean;
  githubLogin?: string;
  busy: boolean;
  probe: ApiProbe;
  conflictReason?: string;
  errors: Array<{ at: string; area: string; message: string }>;
  extension: ExtensionReleaseStatus;
}): ViewModel {
  const installedById = new Map(input.state.installed.map((item) => [item.id, item]));
  const marketplaces = new Map(input.state.marketplaces.map((item) => [item.id, item]));
  const hidden = new Set(input.state.syncExcludedIds ?? []);
  const catalogCards = input.catalog.map((item) => cardFromCatalog(item, installedById.get(item.id), marketplaces.get(item.marketplaceId), hidden.has(item.id)));
  const installedCards = input.state.installed.map((item) => cardFromInstalled(item, marketplaces.get(item.marketplaceId ?? "")));
  catalogCards.sort((left, right) => left.name.localeCompare(right.name));
  installedCards.sort((left, right) => left.name.localeCompare(right.name));
  const updates = installedCards.filter((item) => item.updateAvailable);
  const errors = input.state.installed.filter((item) => item.status === "error" || item.status === "conflict").length + input.state.marketplaces.filter((item) => item.lastError).length;
  return {
    extension: input.extension,
    overview: {
      installed: input.state.installed.length,
      updates: updates.length,
      syncLabel: syncLabel(input.state, input.githubConnected),
      errors,
      marketplaces: input.state.marketplaces.length,
      lastCheckedAt: input.state.lastUpdateCheckAt || "",
    },
    catalog: catalogCards,
    installed: installedCards,
    updates,
    marketplaces: input.state.marketplaces.map((item) => ({
      ...item,
      statusLabel: item.lastError ? "Error" : item.lastRefreshedAt ? `${input.catalog.filter((entry) => entry.marketplaceId === item.id).length} skills` : "Not indexed",
    })),
    settings: input.state.settings,
    github: {
      connected: input.githubConnected,
      login: input.githubLogin,
      repository: input.state.settings.githubRepository,
      syncStatus: input.state.sync.status,
      lastSyncedAt: input.state.sync.lastSyncedAt || "",
      nextSyncAt: nextSyncAt(input.state, input.githubConnected),
      syncError: input.state.sync.lastError || "",
    },
    conflict: input.conflictReason ? { reason: input.conflictReason } : undefined,
    busy: input.busy,
    probe: input.probe,
    errors: input.errors,
  };
}

function cardFromCatalog(item: CatalogComponent, installed: InstalledComponent | undefined, marketplace: MarketplaceRecord | undefined, hidden: boolean): CardModel {
  const updateAvailable = !!installed?.updateAvailable;
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    description: item.description,
    author: item.author || "",
    source: marketplace?.name || marketplace?.url || item.repositoryUrl,
    version: installed ? displayVersion(installed.version, installed.commitSha) : "",
    availableVersion: displayVersion(item.version, item.commitSha),
    status: installed?.status ?? "available",
    statusLabel: installed ? label(installed.status) : "Available",
    installed: !!installed,
    pinned: !!installed?.pinned,
    updateAvailable,
    action: !installed ? "install" : updateAvailable ? "update" : "uninstall",
    group: "catalog",
    place: marketplace?.name || hostOf(item.repositoryUrl),
    readOnly: false,
    managed: false,
    bundleId: item.repositoryUrl ? `repo:${item.repositoryUrl}` : "",
    bundleName: repoName(item.repositoryUrl),
    bundleUrl: item.repositoryUrl || "",
    enabled: true,
    canToggle: false,
    repoUrl: githubFolderUrl(item.repositoryUrl),
    githubUrl: githubFolderUrl(item.repositoryUrl, item.pathInRepo),
    pathLabel: item.pathInRepo || "",
    marketplaceId: item.marketplaceId,
    syncLocal: !!installed?.excludeFromSync || hidden,
    marketLocal: !!marketplace?.excludeFromSync,
    canSync: !marketplace?.excludeFromSync,
  };
}

function cardFromInstalled(item: InstalledComponent, marketplace?: MarketplaceRecord): CardModel {
  const place = placement(item, marketplace);
  const hasVersion = !!(item.version || item.commitSha);
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    description: item.description,
    author: item.author || "",
    source: marketplace?.name || item.repositoryUrl || place.place,
    version: hasVersion ? displayVersion(item.version, item.commitSha) : "",
    availableVersion: item.latestVersion || (item.latestCommit ? displayVersion(undefined, item.latestCommit) : ""),
    status: item.status,
    statusLabel: item.enabled === false ? "Off" : item.updateAvailable ? "Update available" : item.managed ? label(item.status) : "",
    installed: true,
    pinned: item.pinned,
    updateAvailable: item.updateAvailable,
    action: item.updateAvailable ? "update" : "uninstall",
    group: place.group,
    place: place.place,
    readOnly: place.readOnly,
    managed: item.managed,
    bundleId: item.bundleId || "",
    bundleName: item.bundleName || "",
    bundleUrl: item.bundleUrl || "",
    enabled: item.enabled !== false,
    canToggle: item.location === "agents-skills" || item.location === "cursor-skills" || item.location === "agent-store",
    repoUrl: githubFolderUrl(item.bundleUrl || item.repositoryUrl || ""),
    githubUrl: githubFolderUrl(item.bundleUrl || item.repositoryUrl || "", item.pathInRepo),
    pathLabel: item.pathInRepo || "",
    marketplaceId: item.marketplaceId || "",
    syncLocal: !!item.excludeFromSync,
    marketLocal: !!marketplace?.excludeFromSync,
    canSync: !place.readOnly && (place.group === "yours" || place.group === "personal") && !marketplace?.excludeFromSync,
  };
}

function placement(item: InstalledComponent, marketplace?: MarketplaceRecord): { group: "yours" | "builtin" | "plugin" | "personal"; place: string; readOnly: boolean } {
  switch (item.location) {
    case "skills-cursor":
      return { group: "builtin", place: "Built-in", readOnly: true };
    case "plugin-skill":
    case "plugins-local":
    case "plugins-project":
      return { group: "plugin", place: item.type === "plugin" ? "Plugin" : "From plugin", readOnly: item.location === "plugin-skill" };
    default:
      break;
  }
  if (item.bundleId?.startsWith("builtin:")) {
    return { group: "builtin", place: "Built-in", readOnly: true };
  }
  if (item.bundleId?.startsWith("plugin:")) {
    return { group: "plugin", place: item.type === "plugin" ? "Plugin" : "From plugin", readOnly: true };
  }
  if (item.repositoryUrl || item.bundleId?.startsWith("repo:")) {
    return { group: "yours", place: item.bundleName || marketplace?.name || "GitHub", readOnly: false };
  }
  if (marketplace?.name && item.managed) {
    return { group: "yours", place: marketplace.name, readOnly: false };
  }
  switch (item.location) {
    case "agent-store":
      return { group: "personal", place: "Your skills", readOnly: false };
    case "agents-skills":
      return { group: "yours", place: ".agents/skills", readOnly: false };
    default:
      return { group: "yours", place: ".cursor/skills", readOnly: false };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function githubFolderUrl(remote: string, skillPath?: string): string {
  const cleaned = remote.trim().replace(/\.git$/, "").replace(/\/$/, "");
  if (!cleaned) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    return "";
  }
  const repo = `${parsed.origin}${parsed.pathname}`;
  if (!skillPath) {
    return repo;
  }
  const folder = skillPath.replace(/\\/g, "/").replace(/\/SKILL\.md$/i, "").replace(/^\//, "");
  return folder ? `${repo}/tree/main/${folder}` : repo;
}

function repoName(url: string): string {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  try {
    const parsed = new URL(cleaned);
    return parsed.pathname.replace(/^\//, "") || hostOf(url);
  } catch {
    return cleaned;
  }
}

export function label(status: ComponentStatus | "available"): string {
  switch (status) {
    case "up-to-date":
      return "Up to date";
    case "update-available":
      return "Update available";
    case "installing":
      return "Installing";
    case "error":
      return "Error";
    case "local-changes":
      return "Local changes";
    case "conflict":
      return "Conflict";
    case "not-synchronized":
      return "Not synchronized";
    case "pinned":
      return "Pinned";
    default:
      return "Available";
  }
}

function nextSyncAt(state: HubState, connected: boolean): string {
  if (!connected || !state.settings.githubRepository || state.settings.syncFrequency === "off") {
    return "";
  }
  if (state.settings.syncFrequency === "startup") {
    return "Next sync when Cursor starts.";
  }
  const interval = state.settings.syncFrequency === "hourly" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const last = state.sync.lastSyncedAt ? new Date(state.sync.lastSyncedAt).getTime() : 0;
  if (!last || last + interval <= Date.now()) {
    return "Next sync shortly after startup.";
  }
  return `Next sync ${new Date(last + interval).toLocaleString()}.`;
}

function syncLabel(state: HubState, connected: boolean): string {
  if (!connected || !state.settings.githubRepository) {
    return "Not connected";
  }
  switch (state.sync.status) {
    case "synchronized":
      return "Synchronized";
    case "local-changes":
      return "Local changes";
    case "remote-changes":
      return "Remote changes";
    case "conflict":
      return "Conflict";
    case "error":
      return "Sync error";
    default:
      return "Not synchronized";
  }
}

export function searchCatalog(catalog: CatalogComponent[], installed: InstalledComponent[], query: string, category: string | undefined, limit: number): Array<CatalogComponent & { installed: boolean; version?: string }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const installedIds = new Map(installed.map((item) => [item.id, item]));
  return catalog
    .filter((item) => item.type === "skill")
    .map((item) => ({ item, score: score(item, terms, category) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name))
    .slice(0, limit)
    .map(({ item }) => {
      const existing = installedIds.get(item.id);
      return {
        ...item,
        installed: !!existing,
        version: existing?.version,
      };
    });
}

function score(item: CatalogComponent, terms: string[], category?: string): number {
  if (category && !item.categories.some((value) => value.toLowerCase() === category.toLowerCase())) {
    return 0;
  }
  const useful = terms.filter((term) => term.length >= 3);
  if (useful.length === 0) {
    return terms.length === 0 ? 1 : 0;
  }
  const name = item.name.toLowerCase();
  const haystack = `${name} ${item.description} ${item.author ?? ""} ${item.categories.join(" ")}`.toLowerCase();
  let matched = 0;
  let total = 0;
  for (const term of useful) {
    if (!haystack.includes(term)) {
      continue;
    }
    matched += 1;
    total += name.includes(term) ? 5 : 1;
  }
  if (matched === 0) {
    return 0;
  }
  return matched * 10 + total;
}
