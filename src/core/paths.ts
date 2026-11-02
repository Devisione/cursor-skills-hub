import os from "os";
import path from "path";
import { HubError } from "../utils/errors";
import { isInside } from "../utils/filesystem";
import { InstallLocation, InstallScope, SkillLocation } from "./types";

export interface WorkspaceHint {
  workspacePath?: string;
}

export function userSkillRoot(location: SkillLocation): string {
  if (location === "agents-skills") {
    return path.join(os.homedir(), ".agents", "skills");
  }
  return path.join(os.homedir(), ".cursor", "skills");
}

export function projectSkillRoot(workspacePath: string, location: SkillLocation): string {
  if (location === "agents-skills") {
    return path.join(workspacePath, ".agents", "skills");
  }
  return path.join(workspacePath, ".cursor", "skills");
}

export function userPluginRoot(): string {
  return path.join(os.homedir(), ".cursor", "plugins", "local");
}

export function builtinSkillsRoot(): string {
  return path.join(os.homedir(), ".cursor", "skills-cursor");
}

export function userPluginsHome(): string {
  return path.join(os.homedir(), ".cursor", "plugins");
}

export function agentStoreBases(): string[] {
  const bases = [path.join(os.homedir(), ".local", "share", "Cursor", "AgentStores", "cursor_agent_stores")];
  if (process.env.LOCALAPPDATA) {
    bases.unshift(path.join(process.env.LOCALAPPDATA, "Cursor", "AgentStores", "cursor_agent_stores"));
  }
  if (process.platform === "darwin") {
    bases.unshift(path.join(os.homedir(), "Library", "Application Support", "Cursor", "AgentStores", "cursor_agent_stores"));
  }
  return bases;
}

export function projectPluginRoot(workspacePath: string): string {
  return path.join(workspacePath, ".cursor", "plugins");
}

export function installRoot(scope: InstallScope, location: InstallLocation, workspace?: WorkspaceHint): string {
  if (location === "plugins-local") {
    return userPluginRoot();
  }
  if (location === "plugins-project") {
    if (!workspace?.workspacePath) {
      throw new HubError("no-workspace", "Open a folder before installing a plugin into the project.");
    }
    return projectPluginRoot(workspace.workspacePath);
  }
  if (location === "skills-cursor" || location === "plugin-skill" || location === "agent-store") {
    throw new HubError("protected", "New installs go to .cursor/skills or .agents/skills.");
  }
  const skillLocation: SkillLocation = location === "agents-skills" ? "agents-skills" : "cursor-skills";
  if (scope === "project") {
    if (!workspace?.workspacePath) {
      throw new HubError("no-workspace", "Open a folder before installing into the project.");
    }
    return projectSkillRoot(workspace.workspacePath, skillLocation);
  }
  return userSkillRoot(skillLocation);
}

export function locationFor(type: "skill" | "plugin", scope: InstallScope, skillLocation: SkillLocation): InstallLocation {
  if (type === "plugin") {
    return scope === "project" ? "plugins-project" : "plugins-local";
  }
  return skillLocation;
}

export function scannedSkillRoots(workspace?: WorkspaceHint): Array<{ scope: InstallScope; location: SkillLocation; root: string }> {
  const roots: Array<{ scope: InstallScope; location: SkillLocation; root: string }> = [
    { scope: "user", location: "cursor-skills", root: userSkillRoot("cursor-skills") },
    { scope: "user", location: "agents-skills", root: userSkillRoot("agents-skills") },
  ];
  if (workspace?.workspacePath) {
    roots.push(
      { scope: "project", location: "cursor-skills", root: projectSkillRoot(workspace.workspacePath, "cursor-skills") },
      { scope: "project", location: "agents-skills", root: projectSkillRoot(workspace.workspacePath, "agents-skills") },
    );
  }
  return roots;
}

export function scannedPluginRoots(workspace?: WorkspaceHint): Array<{ scope: InstallScope; location: InstallLocation; root: string }> {
  const roots: Array<{ scope: InstallScope; location: InstallLocation; root: string }> = [
    { scope: "user", location: "plugins-local", root: userPluginRoot() },
  ];
  if (workspace?.workspacePath) {
    roots.push({ scope: "project", location: "plugins-project", root: projectPluginRoot(workspace.workspacePath) });
  }
  return roots;
}

export function skillDeleteRoot(installPath: string, workspace?: WorkspaceHint): string {
  const resolved = path.resolve(installPath);
  const roots = [
    userSkillRoot("cursor-skills"),
    userSkillRoot("agents-skills"),
  ];
  if (workspace?.workspacePath) {
    roots.push(projectSkillRoot(workspace.workspacePath, "cursor-skills"), projectSkillRoot(workspace.workspacePath, "agents-skills"));
  }
  const match = roots.find((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedRoot !== resolved && isInside(resolvedRoot, resolved);
  });
  if (match) {
    return path.resolve(match);
  }
  const storeRoot = agentStoreParent(resolved);
  if (storeRoot && path.resolve(storeRoot) !== resolved && isInside(storeRoot, resolved)) {
    return path.resolve(storeRoot);
  }
  throw new HubError("path-traversal", "Refusing to delete a skill outside a known skills directory.");
}

export function agentStoreParent(resolvedPath: string): string | undefined {
  const normalized = path.resolve(resolvedPath).replace(/\\/g, "/");
  const marker = "/cursor_agent_stores/";
  const index = normalized.toLowerCase().indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const parts = normalized.slice(index + marker.length).split("/");
  if (parts.length < 4 || parts[1]?.toLowerCase() !== "files" || parts[2]?.toLowerCase() !== "skills") {
    return undefined;
  }
  return normalized.slice(0, index + marker.length) + parts.slice(0, 3).join("/");
}

export function isReservedInstallRoot(root: string): boolean {
  const resolved = path.resolve(root);
  const blocked = [
    path.join(os.homedir(), ".cursor", "skills-cursor"),
    path.join(os.homedir(), ".cursor"),
    os.homedir(),
  ];
  return blocked.some((item) => path.resolve(item) === resolved);
}
