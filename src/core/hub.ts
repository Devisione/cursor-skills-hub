import * as vscode from "vscode";
import { probeCursorApis, ApiProbe } from "./api-probe";
import { BackupManager } from "./backup-manager";
import { performInstall, performUninstall, assertKnownSource } from "./install-manager";
import { reconcileInstalled, statusFromFlags } from "./reconcile";
import { StateManager } from "./state-manager";
import { planSync, describePlan } from "./sync-plan";
import { pushRemote, readRemote } from "./sync-manager";
import { includedInSync } from "../github/config-sync";
import { CatalogComponent, InstallScope, InstalledComponent, SettingsState } from "./types";
import { checkInstalledUpdates, updatesFor } from "./update-manager";
import { AuthManager } from "../github/auth-manager";
import { createConfigRepo } from "../github/repository-manager";
import { indexMarketplace } from "../marketplaces/marketplace-manager";
import { discoverInstalledPlugins } from "../plugins/plugin-discovery";
import { agentGridSkillPath, discoverInstalledSkills, forgetLockedSkills, publishSkillToAgentGrid, recordSkillSource, updateLockedBundle } from "../skills/skill-discovery";
import { uninstallSkill } from "../skills/skill-installer";
import { CacheManager } from "../storage/cache-manager";
import { HubError, errorCode, errorMessage } from "../utils/errors";
import { marketplaceIdFor, parseGitUrl, repoSlug } from "../utils/github-url";
import { Logger } from "../utils/logger";
import { buildViewModel, ExtensionReleaseStatus, searchCatalog, ViewModel } from "../ui/view-model";
import { installRoot, skillDeleteRoot } from "./paths";
import { checksumDirectory, pathExists } from "../utils/filesystem";
import { mkdtemp, rename, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { gitVersion, materializeRepo } from "../utils/git";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export class Hub {
  private catalog: CatalogComponent[] = [];
  private busy = false;
  private login?: string;
  private connected = false;
  private conflictReason?: string;
  private probe: ApiProbe;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private writingConfig = false;
  private operation?: vscode.CancellationTokenSource;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private extensionStatus: ExtensionReleaseStatus;

  constructor(
    private readonly state: StateManager,
    private readonly cache: CacheManager,
    private readonly backups: BackupManager,
    private readonly auth: AuthManager,
    private readonly logger: Logger,
    private readonly extensionVersion: string,
  ) {
    this.probe = probeCursorApis();
    this.extensionStatus = { version: extensionVersion, latest: extensionVersion, phase: "current" };
    this.logger.info("probe", this.probe.conclusion);
  }

  setExtensionStatus(status: ExtensionReleaseStatus): void {
    const same = this.extensionStatus.version === status.version
      && this.extensionStatus.latest === status.latest
      && this.extensionStatus.phase === status.phase;
    this.extensionStatus = status;
    if (!same) {
      this.emit();
    }
  }

  async start(hadState: boolean): Promise<void> {
    this.catalog = await this.cache.loadCatalog();
    if (!hadState) {
      await this.importFromConfiguration(false);
    } else {
      await this.exportToConfiguration();
    }
    await this.refreshLocal();
    const session = await this.auth.current(false).catch(() => undefined);
    this.connected = !!session;
    this.login = session?.login;
    this.emit();
    setTimeout(() => {
      void this.background()
        .catch((error) => this.logger.error("background", errorMessage(error)))
        .finally(() => this.scheduleSync());
    }, 8000);
  }

  getViewModel(): ViewModel {
    return buildViewModel({
      state: this.state.snapshot(),
      catalog: this.catalog,
      githubConnected: this.connected,
      githubLogin: this.login,
      busy: this.busy,
      probe: this.probe,
      conflictReason: this.conflictReason,
      errors: this.logger.recentErrors(),
      extension: this.extensionStatus,
    });
  }

  isWritingConfiguration(): boolean {
    return this.writingConfig;
  }

  async importFromConfiguration(markDirty = true): Promise<void> {
    const settings = readSettings();
    await this.state.update((state) => {
      state.settings = settings;
      if (markDirty) {
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      }
    });
    this.emit();
  }

  async setSyncVisibility(kind: "skill" | "marketplace" | "bundle", id: string, excluded: boolean): Promise<void> {
    await this.state.update((state) => {
      if (kind === "marketplace") {
        const marketplace = state.marketplaces.find((item) => item.id === id);
        if (marketplace) {
          marketplace.excludeFromSync = excluded;
        }
      } else if (kind === "bundle") {
        for (const item of state.installed) {
          if (item.bundleId === id) {
            item.excludeFromSync = excluded;
          }
        }
      } else {
        const item = state.installed.find((entry) => entry.id === id);
        if (item) {
          item.excludeFromSync = excluded;
        } else {
          const ids = new Set(state.syncExcludedIds ?? []);
          if (excluded) {
            ids.add(id);
          } else {
            ids.delete(id);
          }
          state.syncExcludedIds = [...ids];
        }
      }
      state.sync.dirty = true;
      state.sync.status = "local-changes";
    });
    this.emit();
  }

  async updateSettings(patch: Partial<SettingsState>): Promise<void> {
    await this.state.update((state) => {
      state.settings = { ...state.settings, ...patch };
      state.sync.dirty = true;
      state.sync.status = "local-changes";
    });
    await this.exportToConfiguration();
    this.scheduleSync();
    this.emit();
  }

  async addMarketplace(url: string): Promise<void> {
    const parsed = parseGitUrl(url);
    const snapshot = this.state.snapshot();
    if (snapshot.marketplaces.some((item) => item.normalizedUrl === parsed.normalized)) {
      throw new HubError("duplicate", "That marketplace is already connected.");
    }
    const confirmed = await this.confirm(
      `Add marketplace ${parsed.normalized}?`,
      "Skills Hub will index this source. Nothing is installed until you or the agent asks for a component.",
      "Add",
    );
    if (!confirmed) {
      return;
    }
    await this.run("Indexing marketplace", async (cancel) => {
      const id = marketplaceIdFor(parsed.normalized);
      const token = await this.token();
      const indexed = await indexMarketplace({ url: parsed.normalized, marketplaceId: id, token, logger: this.logger });
      if (cancel.isCancellationRequested) {
        throw new HubError("cancelled", "Marketplace indexing was cancelled.");
      }
      await this.state.update((state) => {
        state.marketplaces.push({
          id,
          url: parsed.raw,
          normalizedUrl: parsed.normalized,
          type: indexed.kind,
          name: indexed.name,
          autoRefresh: true,
          trusted: false,
          componentCount: indexed.components.length,
          lastTreeSha: indexed.treeSha,
          lastCommitSha: indexed.commitSha,
          lastRefreshedAt: new Date().toISOString(),
          addedAt: new Date().toISOString(),
        });
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      });
      this.catalog = await this.cache.replaceMarketplace(id, indexed.components);
      this.logger.info("marketplace", `Connected ${parsed.normalized} with ${indexed.components.length} components. None were installed.`);
    });
  }

  async removeMarketplace(id: string): Promise<void> {
    const marketplace = this.state.snapshot().marketplaces.find((item) => item.id === id);
    if (!marketplace) {
      return;
    }
    const confirmed = await this.confirm(`Remove ${marketplace.name || marketplace.url}?`, "Installed components stay on disk.", "Remove");
    if (!confirmed) {
      return;
    }
    await this.state.update((state) => {
      state.marketplaces = state.marketplaces.filter((item) => item.id !== id);
      state.sync.dirty = true;
      state.sync.status = "local-changes";
    });
    this.catalog = await this.cache.removeMarketplace(id);
    this.emit();
  }

  async setTrusted(id: string, trusted: boolean): Promise<void> {
    await this.state.update((state) => {
      const marketplace = state.marketplaces.find((item) => item.id === id);
      if (marketplace) {
        marketplace.trusted = trusted;
      }
      state.sync.dirty = true;
      state.sync.status = "local-changes";
    });
    this.emit();
  }

  async refreshMarketplace(id?: string): Promise<void> {
    const records = this.state.snapshot().marketplaces.filter((item) => !id || item.id === id);
    await this.run("Refreshing marketplaces", async () => {
      const token = await this.token();
      for (const record of records) {
        try {
          const indexed = await indexMarketplace({
            url: record.normalizedUrl,
            marketplaceId: record.id,
            token,
            logger: this.logger,
          });
          this.catalog = await this.cache.replaceMarketplace(record.id, indexed.components);
          await this.state.update((state) => {
            const target = state.marketplaces.find((item) => item.id === record.id);
            if (!target) {
              return;
            }
            target.type = indexed.kind;
            target.name = indexed.name ?? target.name;
            target.componentCount = indexed.components.length;
            target.lastCommitSha = indexed.commitSha;
            target.lastTreeSha = indexed.treeSha;
            target.lastRefreshedAt = new Date().toISOString();
            target.lastError = undefined;
          });
        } catch (error) {
          const message = errorMessage(error);
          this.logger.error("marketplace", `${record.normalizedUrl}: ${message}`);
          await this.state.update((state) => {
            const target = state.marketplaces.find((item) => item.id === record.id);
            if (target) {
              target.lastError = message;
            }
          });
        }
      }
    });
  }

  async install(id: string, scope?: InstallScope, fromAgent = false, version?: string, alreadyConfirmed = false): Promise<{ installPath: string; version: string; note: string }> {
    const component = this.catalog.find((item) => item.id === id);
    assertKnownSource(component);
    const snapshot = this.state.snapshot();
    const marketplace = snapshot.marketplaces.find((item) => item.id === component.marketplaceId);
    if (!marketplace) {
      throw new HubError("not-allowed", "The source marketplace is not connected.");
    }
    const trusted = marketplace.trusted && snapshot.settings.autoApproveTrustedInstalls;
    if (!trusted && !alreadyConfirmed) {
      const confirmed = await this.confirm(
        `Install ${component.name} from ${marketplace.name || marketplace.url}?`,
        fromAgent
          ? "The agent requested this skill. Scripts inside the skill are not executed."
          : "Scripts inside the component are not executed.",
        "Install",
      );
      if (!confirmed) {
        throw new HubError("cancelled", "Installation was not confirmed.");
      }
    }
    const existing = snapshot.installed.find((item) => item.id === component.id);
    const chosenScope = scope ?? snapshot.settings.installationScope;
    const result = await this.run(`Installing ${component.name}`, async (cancel) => {
      const token = await this.token();
      return performInstall({
        component,
        scope: chosenScope,
        skillLocation: snapshot.settings.defaultSkillLocation,
        workspace: this.workspace(),
        token,
        backups: this.backups,
        backupEnabled: snapshot.settings.backupBeforeUpdate && !!existing,
        existing,
        ref: version,
        cancel,
      });
    });
    const placed = await this.placeRepositorySkill(result);
    await this.rememberInstalled(placed.component, placed.removedPaths, true);
    this.logger.info("install", `${result.name} installed at ${result.installPath}`);
    return {
      installPath: result.installPath,
      version: result.version || result.commitSha || "",
      note: "Cursor scans this directory. Start a new agent chat if the current conversation does not list the skill yet.",
    };
  }

  async installMany(ids: string[]): Promise<void> {
    const snapshot = this.state.snapshot();
    const installed = new Set(snapshot.installed.map((item) => item.id));
    const pending = ids
      .map((id) => this.catalog.find((item) => item.id === id))
      .filter((item): item is CatalogComponent => !!item && !installed.has(item.id))
      .sort((left, right) => skillPathRank(left.pathInRepo) - skillPathRank(right.pathInRepo));
    if (!pending.length) {
      return;
    }
    const source = snapshot.marketplaces.find((item) => item.id === pending[0].marketplaceId);
    const label = source?.name || source?.url || "this repository";
    const confirmed = await this.confirm(`Install ${pending.length} skills from ${label}?`, "Scripts inside skills are not executed.", "Install all");
    if (!confirmed) {
      return;
    }
    const failures: string[] = [];
    for (const component of pending) {
      try {
        await this.install(component.id, undefined, false, undefined, true);
      } catch (error) {
        if (errorCode(error) === "cancelled" || errorCode(error) === "busy") {
          throw error;
        }
        const message = errorMessage(error);
        this.logger.error("install", `${component.name}: ${message}`);
        failures.push(`${component.name}: ${message}`);
      }
    }
    if (failures.length) {
      throw new HubError("install-failed", failures.join("\n"));
    }
  }

  async uninstall(id: string): Promise<void> {
    const component = this.state.snapshot().installed.find((item) => item.id === id);
    if (!component) {
      return;
    }
    if (component.location === "skills-cursor" || component.location === "plugin-skill") {
      throw new HubError("protected", component.location === "skills-cursor"
        ? "Built-in Cursor skills stay where Cursor put them."
        : "This skill belongs to a plugin. Remove the plugin, not the skill folder.");
    }
    const confirmed = await this.confirm(`Uninstall ${component.name}?`, component.installPath, "Uninstall");
    if (!confirmed) {
      return;
    }
    await this.run(`Uninstalling ${component.name}`, async () => {
      await performUninstall(component, this.workspace());
    });
    await this.state.update((state) => {
      state.installed = state.installed.filter((item) => item.id !== id);
      if (component.managed) {
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      }
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const component = this.state.snapshot().installed.find((item) => item.id === id);
    if (!component || component.type !== "skill") {
      return;
    }
    if (component.location === "skills-cursor" || component.location === "plugin-skill") {
      throw new HubError("protected", "Cursor manages this skill. It cannot be turned off here.");
    }
    const on = path.join(component.installPath, "SKILL.md");
    const off = path.join(component.installPath, "SKILL.md.off");
    if (enabled) {
      if (await pathExists(off) && !(await pathExists(on))) {
        await rename(off, on);
      }
    } else if (await pathExists(on)) {
      await rename(on, off);
    }
    await this.refreshLocal();
  }

  async removeBundle(bundleId: string): Promise<void> {
    const items = this.state.snapshot().installed.filter((item) => item.bundleId === bundleId);
    if (!items.length) {
      return;
    }
    if (items.some((item) => item.location === "skills-cursor" || item.location === "plugin-skill")) {
      throw new HubError("protected", "This package belongs to Cursor or a plugin. Open it to see the skills, but it cannot be deleted here.");
    }
    const name = packageTitle(items[0].bundleName || bundleId);
    const confirmed = await this.confirm(`Remove ${name}?`, `This deletes all ${items.length} skills from this device.`, "Remove");
    if (!confirmed) {
      return;
    }
    await this.run(`Removing ${name}`, async () => {
      for (const item of items) {
        await performUninstall(item, this.workspace());
      }
      await forgetLockedSkills(items.map((item) => item.installPath));
    });
    const ids = new Set(items.map((item) => item.id));
    await this.state.update((state) => {
      const removedManaged = state.installed.some((item) => ids.has(item.id) && item.managed);
      state.installed = state.installed.filter((item) => !ids.has(item.id));
      if (removedManaged) {
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      }
    });
    await this.refreshLocal();
  }

  async updateBundle(bundleId: string): Promise<void> {
    const items = this.state.snapshot().installed.filter((item) => item.bundleId === bundleId);
    if (!items.length) {
      return;
    }
    if (items.some((item) => item.location === "skills-cursor" || item.location === "plugin-skill")) {
      throw new HubError("protected", "Cursor updates plugins and built-in skills itself.");
    }
    const url = items.find((item) => item.bundleUrl)?.bundleUrl;
    if (!url) {
      throw new HubError("not-found", "This package has no GitHub repository.");
    }
    const name = packageTitle(items[0].bundleName || bundleId);
    const confirmed = await this.confirm(`Update ${name}?`, "Downloads the repository, refreshes installed skills, and adds skills that appeared there. Skills you turned off stay off.", "Update");
    if (!confirmed) {
      return;
    }
    const skillsRoot = path.dirname(items[0].installPath);
    const sourceName = items[0].bundleName || bundleId;
    await this.run(`Updating ${name}`, async () => {
      const result = await updateLockedBundle({ sourceUrl: url, skillsRoot, sourceName, addNew: true });
      await this.refreshLocal();
      if (result.failures.length) {
        throw new HubError("install-failed", result.failures.join("\n"));
      }
      void vscode.window.showInformationMessage(`Skills Hub: ${result.updated} updated, ${result.added} new.`);
    });
  }

  async updateSkill(id: string): Promise<void> {
    const item = this.state.snapshot().installed.find((entry) => entry.id === id);
    if (!item?.bundleUrl || !item.bundleId) {
      throw new HubError("not-found", "This skill has no saved GitHub repository, so it cannot be checked for updates.");
    }
    if (item.location === "skills-cursor" || item.location === "plugin-skill") {
      throw new HubError("protected", "Cursor updates plugins and built-in skills itself.");
    }
    const confirmed = await this.confirm(`Update ${item.name}?`, "Downloads that skill from GitHub and replaces the local copy if it differs. Other skills in the repository are left alone.", "Update");
    if (!confirmed) {
      return;
    }
    await this.run(`Updating ${item.name}`, async () => {
      const result = await updateLockedBundle({
        sourceUrl: item.bundleUrl || "",
        skillsRoot: path.dirname(item.installPath),
        sourceName: item.bundleName || item.bundleId || "",
        onlyNames: [path.basename(item.installPath)],
        addNew: false,
      });
      await this.refreshLocal();
      if (result.failures.length) {
        throw new HubError("install-failed", result.failures.join("\n"));
      }
      void vscode.window.showInformationMessage(result.updated === 0 ? `Skills Hub: ${item.name} was not found in the repository.` : `Skills Hub: ${item.name} is updated.`);
    });
  }

  async openLink(raw: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HubError("not-found", "That is not a GitHub link.");
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      throw new HubError("not-found", "Only GitHub links can be opened from here.");
    }
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }

  async pin(id: string, pinned: boolean): Promise<void> {
    await this.state.update((state) => {
      const item = state.installed.find((entry) => entry.id === id);
      if (!item) {
        return;
      }
      item.pinned = pinned;
      item.pinCommit = pinned ? item.commitSha : undefined;
      item.pinVersion = pinned ? item.version : undefined;
      item.status = statusFromFlags(item);
      state.sync.dirty = true;
      state.sync.status = "local-changes";
    });
    this.emit();
  }

  async checkUpdates(manual = false): Promise<number> {
    await this.refreshLocal();
    const token = await this.token();
    const installed = this.state.snapshot().installed;
    await checkInstalledUpdates({ installed, token, logger: this.logger });
    await this.state.update((state) => {
      state.installed = installed;
      state.lastUpdateCheckAt = new Date().toISOString();
    });
    const available = updatesFor(this.state.snapshot().installed);
    if (manual) {
      void vscode.window.showInformationMessage(available.length === 0 ? "Skills Hub: everything is up to date." : `Skills Hub: ${available.length} update${available.length === 1 ? "" : "s"} available.`);
    }
    this.emit();
    return available.length;
  }

  async update(id: string, forcePinned = false): Promise<void> {
    const snapshot = this.state.snapshot();
    const installed = snapshot.installed.find((item) => item.id === id);
    const component = this.catalog.find((item) => item.id === id);
    if (!installed || !component) {
      throw new HubError("not-found", "That component is not managed by Skills Hub.");
    }
    if (installed.status === "local-changes") {
      const confirmed = await this.confirm(`Replace local changes in ${installed.name}?`, "The current files will be backed up when backups are enabled.", "Update");
      if (!confirmed) {
        return;
      }
    }
    if (installed.pinned && !forcePinned) {
      const confirmed = await this.confirm(`${installed.name} is pinned.`, "Updating changes the pinned commit to the latest one.", "Update");
      if (!confirmed) {
        return;
      }
    }
    await this.run(`Updating ${installed.name}`, async (cancel) => {
      const token = await this.token();
      const updated = await performInstall({
        component: { ...component, commitSha: installed.latestCommit || component.commitSha },
        scope: installed.scope,
        skillLocation: snapshot.settings.defaultSkillLocation,
        workspace: this.workspace(),
        token,
        backups: this.backups,
        backupEnabled: snapshot.settings.backupBeforeUpdate,
        existing: installed,
        ref: installed.latestCommit,
        cancel,
      });
      if (!(await pathExists(updated.installPath))) {
        throw new HubError("invalid-skill", "The update did not leave a readable install directory.");
      }
      await this.state.update((state) => {
        const index = state.installed.findIndex((item) => item.id === id);
        if (index >= 0) {
          state.installed[index] = updated;
        }
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      });
    });
  }

  async updateAll(): Promise<void> {
    const targets = updatesFor(this.state.snapshot().installed);
    if (targets.length === 0) {
      return;
    }
    const confirmed = await this.confirm(`Update ${targets.length} component${targets.length === 1 ? "" : "s"}?`, "Pinned components and local edits are left alone.", "Update");
    if (!confirmed) {
      return;
    }
    const failures: string[] = [];
    for (const target of targets) {
      try {
        await this.update(target.id, false);
      } catch (error) {
        if (errorCode(error) === "cancelled" || errorCode(error) === "busy") {
          throw error;
        }
        const message = errorMessage(error);
        this.logger.error("update", `${target.name}: ${message}`);
        failures.push(`${target.name}: ${message}`);
      }
    }
    if (failures.length) {
      throw new HubError("install-failed", failures.join("\n"));
    }
  }

  async rollback(id: string): Promise<void> {
    const item = this.state.snapshot().installed.find((entry) => entry.id === id);
    if (!item?.previous) {
      throw new HubError("no-backup", "There is no backup for this component.");
    }
    const confirmed = await this.confirm(`Restore the previous version of ${item.name}?`, item.previous.backupPath, "Rollback");
    if (!confirmed) {
      return;
    }
    const previous = item.previous;
    await this.run(`Restoring ${item.name}`, async () => {
      await this.backups.restore(previous.backupPath, item.installPath, installRoot(item.scope, item.location, this.workspace()));
      const checksum = await checksumDirectory(item.installPath);
      await this.state.update((state) => {
        const target = state.installed.find((entry) => entry.id === id);
        if (!target) {
          return;
        }
        target.version = previous.version;
        target.commitSha = previous.commitSha;
        target.checksum = checksum;
        target.previous = undefined;
        target.updateAvailable = true;
        target.status = statusFromFlags({ ...target, pinned: target.pinned, updateAvailable: true, managed: true, status: "up-to-date" });
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      });
    });
  }

  async connectGitHub(): Promise<void> {
    const session = await this.auth.current(true);
    this.connected = !!session;
    this.login = session?.login;
    if (!session) {
      throw new HubError("github-auth", "GitHub was not connected.");
    }
    this.emit();
  }

  async disconnectGitHub(): Promise<void> {
    await this.auth.disconnect();
    this.connected = false;
    this.login = undefined;
    await this.state.update((state) => {
      state.sync.status = "disconnected";
    });
    this.emit();
  }

  async listRepositories(): Promise<Array<{ fullName: string; private: boolean; description: string }>> {
    const session = await this.requireSession();
    return session.client.listRepos();
  }

  async selectRepository(fullName: string): Promise<void> {
    await this.updateSettings({ githubRepository: fullName });
    await this.sync();
  }

  async createRepository(name: string): Promise<void> {
    const session = await this.requireSession();
    const fullName = await createConfigRepo(session.client, name);
    await this.updateSettings({ githubRepository: fullName });
    await this.push();
  }

  async pull(): Promise<void> {
    const remote = await this.loadRemote();
    const plan = this.currentPlan(remote.snapshot, remote.sha);
    if (plan.action === "conflict") {
      this.conflictReason = describePlan(plan);
      await this.state.update((state) => {
        state.sync.status = "conflict";
        state.sync.lastError = plan.reason;
      });
      this.emit();
      return;
    }
    await this.applyRemote(remote.snapshot, remote.sha, plan.reason);
  }

  async push(): Promise<void> {
    const session = await this.requireSession();
    const snapshot = this.state.snapshot();
    if (!snapshot.settings.githubRepository) {
      throw new HubError("choose-repository", "Choose a GitHub repository first.");
    }
    const sha = await this.run("Pushing configuration", async () => pushRemote(session.client, snapshot.settings.githubRepository, this.state.snapshot(), snapshot.sync.lastRemoteSha));
    await this.state.update((state) => {
      state.sync.lastRemoteSha = sha;
      state.sync.lastSyncedAt = new Date().toISOString();
      state.sync.dirty = false;
      state.sync.status = "synchronized";
      state.sync.lastError = undefined;
    });
    this.conflictReason = undefined;
    this.logger.info("sync", `Pushed configuration ${sha.slice(0, 7)}.`);
    this.scheduleSync();
  }

  async sync(): Promise<void> {
    const remote = await this.loadRemote();
    const plan = this.currentPlan(remote.snapshot, remote.sha);
    if (plan.action === "push") {
      await this.push();
      return;
    }
    if (plan.action === "pull") {
      const confirmed = await this.confirm("Apply the GitHub configuration on this device?", plan.reason, "Apply");
      if (!confirmed) {
        await this.state.update((state) => {
          state.sync.status = "remote-changes";
        });
        this.emit();
        return;
      }
      await this.applyRemote(remote.snapshot, remote.sha, plan.reason);
      return;
    }
    if (plan.action === "conflict") {
      this.conflictReason = describePlan(plan);
      await this.state.update((state) => {
        state.sync.status = "conflict";
        state.sync.lastError = plan.reason;
      });
      const policy = this.state.snapshot().settings.conflictResolution;
      if (policy === "keep-local") {
        await this.resolveConflict("local");
      } else if (policy === "keep-remote") {
        await this.resolveConflict("remote");
      }
      this.emit();
      return;
    }
    await this.state.update((state) => {
      state.sync.status = "synchronized";
      state.sync.lastRemoteSha = remote.sha || state.sync.lastRemoteSha;
      state.sync.lastSyncedAt = new Date().toISOString();
    });
    this.emit();
    this.scheduleSync();
  }

  async resolveConflict(choice: "local" | "remote"): Promise<void> {
    if (choice === "local") {
      const session = await this.requireSession();
      const snapshot = this.state.snapshot();
      const remote = await readRemote(session.client, snapshot.settings.githubRepository);
      const sha = await pushRemote(session.client, snapshot.settings.githubRepository, snapshot, remote.sha || undefined);
      await this.state.update((state) => {
        state.sync.lastRemoteSha = sha;
        state.sync.dirty = false;
        state.sync.status = "synchronized";
        state.sync.lastSyncedAt = new Date().toISOString();
        state.sync.lastError = undefined;
      });
      this.conflictReason = undefined;
      this.emit();
      this.scheduleSync();
      return;
    }
    const remote = await this.loadRemote();
    await this.applyRemote(remote.snapshot, remote.sha, "Kept the GitHub configuration.");
    this.conflictReason = undefined;
  }

  async openSource(id: string): Promise<void> {
    const item = this.catalog.find((entry) => entry.id === id) ?? this.state.snapshot().installed.find((entry) => entry.id === id);
    const url = item && "repositoryUrl" in item ? item.repositoryUrl : undefined;
    if (!url) {
      throw new HubError("not-found", "This component has no source URL.");
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async reveal(id: string): Promise<void> {
    const item = this.state.snapshot().installed.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(item.installPath));
  }

  async viewChanges(id: string): Promise<void> {
    const installed = this.state.snapshot().installed.find((item) => item.id === id);
    if (!installed?.commitSha || !installed.repositoryUrl || !installed.latestCommit) {
      throw new HubError("no-diff", "Check for updates before viewing changes.");
    }
    const relative = installed.type === "skill" ? path.posix.join(installed.pathInRepo || "", "SKILL.md") : path.posix.join(installed.pathInRepo || "", ".cursor-plugin", "plugin.json");
    const token = await this.token();
    const left = await readRepoFile(installed.repositoryUrl, installed.commitSha, relative, token);
    const right = await readRepoFile(installed.repositoryUrl, installed.latestCommit, relative, token);
    const directory = await mkdtemp(path.join(os.tmpdir(), "skills-hub-diff-"));
    const leftFile = path.join(directory, "installed");
    const rightFile = path.join(directory, "available");
    await writeFile(leftFile, left);
    await writeFile(rightFile, right);
    await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(leftFile), vscode.Uri.file(rightFile), `${installed.name}: installed ↔ available`);
  }

  search(query: string, category?: string, limit = 10) {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    return searchCatalog(this.catalog, this.state.snapshot().installed, query, category, safeLimit).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      source: item.repositoryUrl,
      installed: item.installed,
      version: item.version || item.commitSha,
    }));
  }

  skillInfo(id: string) {
    const item = this.catalog.find((entry) => entry.id === id && entry.type === "skill");
    if (!item) {
      throw new HubError("not-found", "That skill is not in a connected marketplace.");
    }
    const installed = this.state.snapshot().installed.find((entry) => entry.id === id);
    return {
      ...item,
      installed: !!installed,
      installedVersion: installed?.version,
      status: installed?.status ?? "available",
      requirements: item.dependencies.length > 0 ? item.dependencies : ["No declared dependencies."],
    };
  }

  listInstalledSkills() {
    return this.state.snapshot().installed.filter((item) => item.type === "skill").map((item) => ({
      id: item.id,
      name: item.name,
      version: item.version,
      scope: item.scope,
      status: item.status,
      installPath: item.installPath,
    }));
  }

  async diagnostics(): Promise<string> {
    const state = this.state.snapshot();
    const git = await gitVersion();
    return [
      "# Skills Hub diagnostics",
      "",
      `- Extension: ${this.extensionVersion}`,
      `- Extension release: ${this.extensionStatus.phase}`,
      `- Cursor: ${vscode.version}`,
      `- Git: ${git ?? "not found"}`,
      `- GitHub: ${this.connected ? this.login ?? "connected" : "disconnected"}`,
      `- Repository: ${state.settings.githubRepository || "not chosen"}`,
      `- Sync: ${state.sync.status}`,
      `- Installed: ${state.installed.length}`,
      `- Marketplaces: ${state.marketplaces.length}`,
      `- Catalog: ${this.catalog.length}`,
      `- registerPath: ${this.probe.registerPath}`,
      `- ${this.probe.conclusion}`,
      "",
      "## Recent errors",
      ...(this.logger.recentErrors().length === 0 ? ["None."] : this.logger.recentErrors().map((item) => `- ${item.at} ${item.area}: ${item.message}`)),
    ].join("\n");
  }

  private async background(): Promise<void> {
    const state = this.state.snapshot();
    const cadence = state.settings.syncFrequency === "off" ? "daily" : state.settings.syncFrequency;
    const due = this.due(state.lastUpdateCheckAt, cadence);
    if (state.settings.automaticMarketplaceRefresh && this.due(state.lastMarketplaceRefreshAt, cadence)) {
      await this.refreshMarketplace();
      await this.state.update((current) => {
        current.lastMarketplaceRefreshAt = new Date().toISOString();
      });
    }
    if (state.settings.automaticUpdateChecks && (due || state.settings.syncFrequency === "startup")) {
      const count = await this.checkUpdates(false);
      if (count > 0 && state.settings.updateMode === "auto") {
        for (const item of updatesFor(this.state.snapshot().installed)) {
          try {
            await this.update(item.id, false);
          } catch (error) {
            this.logger.error("update", errorMessage(error));
          }
        }
      } else if (count > 0 && state.settings.updateMode === "notify" && state.settings.updateNotifications) {
        const choice = await vscode.window.showInformationMessage(`Skills Hub found ${count} update${count === 1 ? "" : "s"}.`, "Show");
        if (choice === "Show") {
          await vscode.commands.executeCommand("skillsHub.main.focus");
        }
      }
    }
    if (state.settings.githubRepository && state.settings.syncFrequency !== "off" && this.due(state.sync.lastSyncedAt, state.settings.syncFrequency)) {
      await this.sync().catch((error) => this.logger.error("sync", errorMessage(error)));
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    const state = this.state.snapshot();
    const frequency = state.settings.syncFrequency;
    if (!state.settings.githubRepository || frequency === "off" || frequency === "startup") {
      return;
    }
    const interval = frequency === "hourly" ? HOUR : DAY;
    const last = state.sync.lastSyncedAt ? new Date(state.sync.lastSyncedAt).getTime() : 0;
    const wait = last ? Math.max(1000, last + interval - Date.now()) : 1000;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.sync()
        .catch((error) => this.logger.error("sync", errorMessage(error)))
        .finally(() => this.scheduleSync());
    }, wait);
  }

  private due(last: string | undefined, frequency: SettingsState["syncFrequency"]): boolean {
    if (frequency === "off") {
      return false;
    }
    if (!last || frequency === "startup") {
      return true;
    }
    const elapsed = Date.now() - new Date(last).getTime();
    if (frequency === "hourly") {
      return elapsed >= HOUR;
    }
    return elapsed >= DAY;
  }

  private async applyRemote(snapshotRemote: Awaited<ReturnType<typeof readRemote>>["snapshot"], sha: string, reason: string): Promise<void> {
    await this.state.update((state) => {
      const kept = state.marketplaces.filter((item) => item.excludeFromSync);
      const incoming = snapshotRemote.marketplaces.filter((item) => !kept.some((local) => local.id === item.id));
      state.marketplaces = [
        ...incoming.map((item) => ({
          ...item,
          componentCount: state.marketplaces.find((existing) => existing.id === item.id)?.componentCount ?? 0,
          lastRefreshedAt: state.marketplaces.find((existing) => existing.id === item.id)?.lastRefreshedAt,
          addedAt: state.marketplaces.find((existing) => existing.id === item.id)?.addedAt ?? new Date().toISOString(),
        })),
        ...kept,
      ];
      state.settings = { ...state.settings, ...snapshotRemote.settings, githubRepository: state.settings.githubRepository };
      state.sync.status = "remote-changes";
      state.sync.lastError = undefined;
    });
    await this.exportToConfiguration();
    await this.refreshMarketplace();
    let failed = 0;
    for (const remoteItem of snapshotRemote.installed) {
      const current = this.state.snapshot();
      const hiddenMarkets = new Set(current.marketplaces.filter((item) => item.excludeFromSync).map((item) => item.id));
      const localItem = current.installed.find((item) => item.id === remoteItem.id);
      if (localItem?.excludeFromSync || current.syncExcludedIds?.includes(remoteItem.id) || hiddenMarkets.has(remoteItem.marketplaceId || "") || hiddenMarkets.has(localItem?.marketplaceId || "")) {
        continue;
      }
      const exists = localItem && localItem.commitSha === remoteItem.commitSha && localItem.status !== "error";
      if (exists) {
        continue;
      }
      const component = this.catalog.find((item) => item.id === remoteItem.id);
      if (!component) {
        failed += 1;
        this.logger.warn("sync", `No catalog entry for ${remoteItem.name}. Refresh the marketplace and sync again.`);
        continue;
      }
      try {
        await this.run(`Restoring ${remoteItem.name}`, async (cancel) => {
          const token = await this.token();
          const installed = await performInstall({
            component,
            scope: remoteItem.scope,
            skillLocation: remoteItem.location === "agents-skills" ? "agents-skills" : "cursor-skills",
            workspace: this.workspace(),
            token,
            backups: this.backups,
            backupEnabled: true,
            ref: remoteItem.commitSha,
            cancel,
          });
          installed.pinned = remoteItem.pinned;
          installed.pinCommit = remoteItem.pinCommit;
          installed.pinVersion = remoteItem.pinVersion;
          installed.status = remoteItem.pinned ? "pinned" : "up-to-date";
          await this.state.update((state) => {
            state.installed = state.installed.filter((item) => item.id !== installed.id);
            state.installed.push(installed);
          });
        });
      } catch (error) {
        failed += 1;
        this.logger.error("sync", `${remoteItem.name}: ${errorMessage(error)}`);
      }
    }
    await this.state.update((state) => {
      if (failed === 0) {
        state.sync.lastRemoteSha = sha;
        state.sync.dirty = false;
        state.sync.status = "synchronized";
        state.sync.lastSyncedAt = new Date().toISOString();
        state.sync.lastError = undefined;
      } else {
        state.sync.status = "error";
        state.sync.lastError = `${failed} component${failed === 1 ? "" : "s"} could not be restored.`;
      }
    });
    this.logger.info("sync", reason);
    this.emit();
    this.scheduleSync();
  }

  private currentPlan(snapshotRemote: Awaited<ReturnType<typeof readRemote>>["snapshot"], sha: string) {
    const state = this.state.snapshot();
    return planSync({
      repository: state.settings.githubRepository,
      dirty: state.sync.dirty,
      lastRemoteSha: state.sync.lastRemoteSha,
      remoteSha: sha || state.sync.lastRemoteSha,
      remote: snapshotRemote,
      localManaged: includedInSync(state).installed,
    });
  }

  private async loadRemote() {
    const session = await this.requireSession();
    const repository = this.state.snapshot().settings.githubRepository;
    if (!repository) {
      throw new HubError("choose-repository", "Choose a GitHub repository first.");
    }
    return readRemote(session.client, repository);
  }

  private async requireSession() {
    const session = await this.auth.current(false) ?? await this.auth.current(true);
    if (!session) {
      throw new HubError("github-auth", "Connect GitHub first.");
    }
    this.connected = true;
    this.login = session.login;
    return session;
  }

  private async token(): Promise<string | undefined> {
    const session = await this.auth.current(false).catch(() => undefined);
    this.connected = !!session;
    this.login = session?.login;
    return session?.token;
  }

  private workspace() {
    return { workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
  }

  private async refreshLocal(): Promise<void> {
    if (!this.state.snapshot().gridClaimReleased) {
      await this.releaseAutoClaimedGridSkills();
    }
    const workspace = this.workspace();
    const skills = await discoverInstalledSkills(workspace);
    const plugins = await discoverInstalledPlugins(workspace);
    await this.state.update((state) => reconcileInstalled(state, skills, plugins));
  }

  private async releaseAutoClaimedGridSkills(): Promise<void> {
    const claimed = this.state.snapshot().installed.filter((item) => item.type === "skill" && item.location === "agent-store" && item.managed && !!item.repositoryUrl);
    await forgetLockedSkills(claimed.map((item) => item.installPath));
    const drop = new Set(claimed.map((item) => item.id));
    await this.state.update((state) => {
      state.installed = state.installed.filter((item) => !drop.has(item.id));
      state.gridClaimReleased = true;
    });
  }

  private async placeRepositorySkill(component: InstalledComponent): Promise<{ component: InstalledComponent; removedPaths: string[] }> {
    if (component.type !== "skill" || !component.repositoryUrl) {
      return { component, removedPaths: [] };
    }
    const slug = repoSlug(component.repositoryUrl);
    component.bundleId = `repo:${slug}`;
    component.bundleName = slug;
    component.bundleUrl = component.repositoryUrl;
    const removed: string[] = [];
    if (component.scope === "user") {
      const gridPath = await agentGridSkillPath(catalogFolderName(component.name, component.pathInRepo));
      if (gridPath && !pathsEqual(gridPath, component.installPath)) {
        const ready = await pathExists(path.join(component.installPath, "SKILL.md")) || await pathExists(path.join(component.installPath, "SKILL.md.off"));
        if (ready) {
          await publishSkillToAgentGrid(component.installPath, path.basename(gridPath));
          await forgetLockedSkills([component.installPath]);
          await this.deleteSkillDirectory(component.installPath);
          removed.push(component.installPath);
          component.installPath = gridPath;
          component.location = "agent-store";
        }
      }
    }
    await recordSkillSource(component.installPath, slug, component.repositoryUrl, component.pathInRepo || component.name);
    const personal = this.state.snapshot().installed.filter((item) => this.isPersonalCopy(item, component.name, component.installPath));
    for (const copy of personal) {
      await forgetLockedSkills([copy.installPath]);
      await this.deleteSkillDirectory(copy.installPath);
      removed.push(copy.installPath);
    }
    return { component, removedPaths: removed };
  }

  private isPersonalCopy(item: InstalledComponent, name: string, keepPath: string): boolean {
    if (item.type !== "skill" || item.name !== name || (keepPath && pathsEqual(item.installPath, keepPath))) {
      return false;
    }
    if (item.repositoryUrl || item.bundleId) {
      return false;
    }
    return item.location === "agent-store" || item.location === "cursor-skills";
  }

  private async deleteSkillDirectory(installPath: string): Promise<void> {
    if (!(await pathExists(installPath))) {
      return;
    }
    await uninstallSkill(installPath, skillDeleteRoot(installPath, this.workspace()));
  }

  private async rememberInstalled(component: InstalledComponent, removedPaths: string[], dirty: boolean): Promise<void> {
    await this.state.update((state) => {
      state.installed = state.installed.filter((item) => {
        if (item.id === component.id || pathsEqual(item.installPath, component.installPath)) {
          return false;
        }
        if (removedPaths.some((removed) => pathsEqual(item.installPath, removed))) {
          return false;
        }
        return !this.isPersonalCopy(item, component.name, component.installPath);
      });
      const market = state.marketplaces.find((item) => item.id === component.marketplaceId);
      if (market?.excludeFromSync || state.syncExcludedIds?.includes(component.id)) {
        component.excludeFromSync = true;
      }
      if (state.syncExcludedIds?.includes(component.id)) {
        state.syncExcludedIds = state.syncExcludedIds.filter((item) => item !== component.id);
      }
      state.installed.push(component);
      if (dirty) {
        state.sync.dirty = true;
        state.sync.status = "local-changes";
      }
    });
  }

  private async exportToConfiguration(): Promise<void> {
    this.writingConfig = true;
    try {
      const config = vscode.workspace.getConfiguration("skillsHub");
      const settings = this.state.snapshot().settings;
      for (const [key, value] of Object.entries(settings)) {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
      }
    } finally {
      this.writingConfig = false;
    }
  }

  private async run<T>(title: string, work: (cancel: { isCancellationRequested: boolean }) => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new HubError("busy", "Another Skills Hub operation is still running.");
    }
    this.busy = true;
    this.operation = new vscode.CancellationTokenSource();
    this.emit();
    try {
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      }, async (_progress, token) => work({
        get isCancellationRequested() {
          return token.isCancellationRequested;
        },
      }));
    } finally {
      this.busy = false;
      this.operation.dispose();
      this.operation = undefined;
      this.emit();
    }
  }

  private async confirm(message: string, detail: string, action: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
    return choice === action;
  }

  private emit(): void {
    this.emitter.fire();
  }
}

function packageTitle(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1] || name;
}

function readSettings(): SettingsState {
  const config = vscode.workspace.getConfiguration("skillsHub");
  return {
    syncFrequency: config.get("syncFrequency", "daily"),
    automaticMarketplaceRefresh: config.get("automaticMarketplaceRefresh", true),
    automaticUpdateChecks: config.get("automaticUpdateChecks", true),
    updateMode: config.get("updateMode", "notify"),
    updateNotifications: config.get("updateNotifications", true),
    backupBeforeUpdate: config.get("backupBeforeUpdate", true),
    conflictResolution: config.get("conflictResolution", "ask"),
    installationScope: config.get("installationScope", "user"),
    defaultSkillLocation: config.get("defaultSkillLocation", "cursor-skills"),
    autoApproveTrustedInstalls: config.get("autoApproveTrustedInstalls", false),
    githubRepository: config.get("githubRepository", ""),
  };
}

function catalogFolderName(name: string, pathInRepo?: string): string {
  const normalized = (pathInRepo || "").replace(/\\/g, "/");
  if (normalized.includes("cli/assets/skills")) {
    return `${name}--cli`;
  }
  return name;
}

function skillPathRank(skillPath: string): number {
  const normalized = skillPath.replace(/\\/g, "/");
  if (normalized.includes(".claude/skills")) {
    return 2;
  }
  if (normalized.includes("cli/assets/skills")) {
    return 0;
  }
  return 1;
}

function pathsEqual(left: string, right: string): boolean {
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

async function readRepoFile(url: string, ref: string, relative: string, token?: string): Promise<string> {
  const materialized = await materializeRepo({ url, ref, subpath: path.posix.dirname(relative) === "." ? undefined : path.posix.dirname(relative), token });
  try {
    const { readFile } = await import("fs/promises");
    return await readFile(path.join(materialized.directory, relative), "utf8");
  } finally {
    await materialized.cleanup();
  }
}
