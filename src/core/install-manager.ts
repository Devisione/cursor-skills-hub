import { BackupManager } from "../core/backup-manager";
import { skillDeleteRoot, WorkspaceHint } from "../core/paths";
import { CancelFlag, CatalogComponent, InstallScope, InstalledComponent, SkillLocation } from "../core/types";
import { installPlugin } from "../plugins/plugin-installer";
import { installSkill, uninstallSkill } from "../skills/skill-installer";
import { uninstallPlugin } from "../plugins/plugin-installer";
import { HubError } from "../utils/errors";

export async function performInstall(input: {
  component: CatalogComponent;
  scope: InstallScope;
  skillLocation: SkillLocation;
  workspace?: WorkspaceHint;
  token?: string;
  backups: BackupManager;
  backupEnabled: boolean;
  existing?: InstalledComponent;
  ref?: string;
  cancel?: CancelFlag;
}): Promise<InstalledComponent> {
  const now = new Date().toISOString();
  const backup = async (currentPath: string) => {
    if (!input.backupEnabled) {
      return undefined;
    }
    return input.backups.keep(input.component.id, currentPath);
  };
  if (input.component.type === "skill") {
    const result = await installSkill({
      component: input.component,
      scope: input.scope,
      skillLocation: input.skillLocation,
      workspace: input.workspace,
      ref: input.ref,
      token: input.token,
      backup,
      cancel: input.cancel,
    });
    return {
      id: input.component.id,
      type: "skill",
      name: result.name,
      description: result.description,
      author: input.component.author,
      marketplaceId: input.component.marketplaceId,
      repositoryUrl: input.component.repositoryUrl,
      pathInRepo: input.component.pathInRepo,
      version: input.component.version || result.commitSha.slice(0, 7),
      commitSha: result.commitSha,
      checksum: result.checksum,
      scope: result.scope,
      location: result.location,
      installPath: result.installPath,
      pinned: input.existing?.pinned ?? false,
      pinCommit: input.existing?.pinned ? result.commitSha : input.existing?.pinCommit,
      pinVersion: input.existing?.pinVersion,
      status: input.existing?.pinned ? "pinned" : "up-to-date",
      updateAvailable: false,
      installedAt: input.existing?.installedAt ?? now,
      updatedAt: now,
      managed: true,
      previous: result.backupPath ? {
        version: input.existing?.version,
        commitSha: input.existing?.commitSha,
        checksum: input.existing?.checksum,
        backupPath: result.backupPath,
        updatedAt: now,
      } : input.existing?.previous,
    };
  }
  const result = await installPlugin({
    component: input.component,
    scope: input.scope,
    workspace: input.workspace,
    ref: input.ref,
    token: input.token,
    backup,
    cancel: input.cancel,
  });
  return {
    id: input.component.id,
    type: "plugin",
    name: result.name,
    description: result.description,
    author: input.component.author,
    marketplaceId: input.component.marketplaceId,
    repositoryUrl: input.component.repositoryUrl,
    pathInRepo: input.component.pathInRepo,
    version: result.version || input.component.version || result.commitSha.slice(0, 7),
    commitSha: result.commitSha,
    checksum: result.checksum,
    scope: result.scope,
    location: result.location,
    installPath: result.installPath,
    pinned: input.existing?.pinned ?? false,
    pinCommit: input.existing?.pinned ? result.commitSha : input.existing?.pinCommit,
    pinVersion: input.existing?.pinVersion,
    status: input.existing?.pinned ? "pinned" : "up-to-date",
    updateAvailable: false,
    installedAt: input.existing?.installedAt ?? now,
    updatedAt: now,
    managed: true,
    previous: result.backupPath ? {
      version: input.existing?.version,
      commitSha: input.existing?.commitSha,
      checksum: input.existing?.checksum,
      backupPath: result.backupPath,
      updatedAt: now,
    } : input.existing?.previous,
  };
}

export async function performUninstall(component: InstalledComponent, workspace?: WorkspaceHint): Promise<void> {
  if (component.location === "skills-cursor" || component.location === "plugin-skill") {
    throw new HubError("protected", component.location === "skills-cursor"
      ? "Built-in Cursor skills stay where Cursor put them."
      : "This skill belongs to a plugin. Remove the plugin, not the skill folder.");
  }
  if (component.type === "skill") {
    await uninstallSkill(component.installPath, skillDeleteRoot(component.installPath, workspace));
    return;
  }
  const location = component.location === "plugins-project" ? "plugins-project" : "plugins-local";
  await uninstallPlugin(component.installPath, component.scope, location, workspace);
}

export function assertKnownSource(component: CatalogComponent | undefined): asserts component is CatalogComponent {
  if (!component) {
    throw new HubError("not-allowed", "Installation is only allowed for components from a connected marketplace.");
  }
}
