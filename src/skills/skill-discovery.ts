import { createHash } from "crypto";
import { readdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { InstallLocation, InstallScope } from "../core/types";
import { agentStoreBases, builtinSkillsRoot, scannedSkillRoots, userPluginsHome, WorkspaceHint } from "../core/paths";
import { checksumDirectory, copyTree, ensureDir, moveAside, pathExists, removeTree } from "../utils/filesystem";
import { parseFrontmatter } from "../utils/frontmatter";
import { errorMessage } from "../utils/errors";
import { materializeRepo } from "../utils/git";
import { installFolderName } from "./skill-installer";
import { isSafeComponentName } from "../utils/security";

export interface SkillLockEntry {
  source: string;
  sourceUrl?: string;
  skillPath?: string;
}

export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  installPath: string;
  scope: InstallScope;
  location: InstallLocation;
  checksum: string;
  bundleId?: string;
  bundleName?: string;
  bundleUrl?: string;
  pathInRepo?: string;
  enabled: boolean;
}

export async function discoverInstalledSkills(workspace?: WorkspaceHint): Promise<DiscoveredSkill[]> {
  const roots: Array<{ scope: InstallScope; location: InstallLocation; root: string; depth: number }> = [
    ...scannedSkillRoots(workspace).map((root) => ({ ...root, depth: 2 })),
    { scope: "user", location: "skills-cursor", root: builtinSkillsRoot(), depth: 2 },
    { scope: "user", location: "plugin-skill", root: userPluginsHome(), depth: 6 },
  ];
  if (workspace?.workspacePath) {
    roots.push({ scope: "project", location: "plugin-skill", root: path.join(workspace.workspacePath, ".cursor", "plugins"), depth: 5 });
  }
  for (const root of await agentStoreSkillRoots()) {
    roots.push({ scope: "user", location: "agent-store", root, depth: 2 });
  }
  const found: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!(await pathExists(root.root))) {
      continue;
    }
    const lock = locksFor(root.location) ? await readSkillLock(root.root) : new Map<string, SkillLockEntry>();
    const directories = await skillDirectories(root.root, root.depth);
    for (const directory of directories) {
      const key = path.resolve(directory).toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const marker = await skillMarker(directory);
      if (!marker) {
        continue;
      }
      const frontmatter = parseFrontmatter(await readFile(marker.file, "utf8"));
      const folder = path.basename(directory);
      const name = frontmatter.name || folder;
      const origin = await originFor(root.location, directory, lock.get(folder) ?? lock.get(name));
      found.push({
        id: `local_${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`,
        name,
        description: (frontmatter.description ?? "").slice(0, 2000),
        installPath: directory,
        scope: root.scope,
        location: root.location,
        checksum: await checksumDirectory(directory),
        bundleId: origin?.id,
        bundleName: origin?.name,
        bundleUrl: origin?.url,
        pathInRepo: origin?.path,
        enabled: marker.enabled,
      });
    }
  }
  return found;
}

export async function readSkillLock(skillsRoot: string): Promise<Map<string, SkillLockEntry>> {
  const map = new Map<string, SkillLockEntry>();
  const file = path.join(path.dirname(skillsRoot), ".skill-lock.json");
  if (!(await pathExists(file))) {
    return map;
  }
  let parsed: { skills?: Record<string, { source?: string; sourceUrl?: string; skillPath?: string }> };
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
  } catch {
    return map;
  }
  for (const [name, entry] of Object.entries(parsed.skills ?? {})) {
    if (entry && typeof entry.source === "string" && entry.source) {
      map.set(name, {
        source: entry.source,
        sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : undefined,
        skillPath: typeof entry.skillPath === "string" ? entry.skillPath : undefined,
      });
    }
  }
  return map;
}

export async function restoreSkillFromAgentGrid(installPath: string): Promise<void> {
  if (await pathExists(path.join(installPath, "SKILL.md")) || await pathExists(path.join(installPath, "SKILL.md.off"))) {
    return;
  }
  const grid = await userAgentSkillGrid();
  if (!grid) {
    return;
  }
  const source = path.join(grid, path.basename(installPath));
  if (!(await pathExists(path.join(source, "SKILL.md")))) {
    return;
  }
  await replaceSkillDirectory(path.dirname(installPath), source, installPath);
}

export async function agentGridSkillPath(skillName: string): Promise<string | undefined> {
  const grid = await userAgentSkillGrid();
  if (!grid || !isSafeComponentName(skillName)) {
    return undefined;
  }
  return path.join(grid, skillName);
}

export async function publishSkillToAgentGrid(skillDir: string, folderName = path.basename(skillDir)): Promise<void> {
  const grid = await userAgentSkillGrid();
  if (!grid || !isSafeComponentName(folderName)) {
    return;
  }
  const destination = path.join(grid, folderName);
  if (path.resolve(destination).toLowerCase() === path.resolve(skillDir).toLowerCase()) {
    return;
  }
  await replaceSkillDirectory(grid, skillDir, destination);
}

async function userAgentSkillGrid(): Promise<string | undefined> {
  for (const base of agentStoreBases()) {
    if (!(await pathExists(base))) {
      continue;
    }
    const stores = await readdir(base, { withFileTypes: true });
    const directories = stores.filter((entry) => entry.isDirectory());
    const store = directories.find((entry) => entry.name.startsWith("u")) ?? directories[0];
    if (!store) {
      continue;
    }
    const skills = path.join(base, store.name, "files", "skills");
    await ensureDir(skills);
    return skills;
  }
  return undefined;
}

export async function recordSkillSource(installPath: string, source: string, sourceUrl: string, skillPath: string): Promise<void> {
  const relative = skillPath.replace(/\\/g, "/");
  const file = relative.endsWith("SKILL.md") ? relative : `${relative.replace(/\/$/, "")}/SKILL.md`;
  await rememberLockedSkills(path.dirname(installPath), source, sourceUrl, [{ name: path.basename(installPath), skillPath: file }]);
}

export async function forgetLockedSkills(installPaths: string[]): Promise<void> {
  const grouped = new Map<string, Set<string>>();
  for (const installPath of installPaths) {
    const file = path.join(path.dirname(path.dirname(installPath)), ".skill-lock.json");
    const names = grouped.get(file) ?? new Set<string>();
    names.add(path.basename(installPath));
    grouped.set(file, names);
  }
  for (const [file, names] of grouped) {
    if (!(await pathExists(file))) {
      continue;
    }
    let parsed: { skills?: Record<string, unknown> };
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.skills) {
      continue;
    }
    for (const name of names) {
      delete parsed.skills[name];
    }
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
}

export async function updateLockedBundle(input: {
  sourceUrl: string;
  skillsRoot: string;
  sourceName: string;
  onlyNames?: string[];
  addNew?: boolean;
}): Promise<{ updated: number; added: number; failures: string[] }> {
  const materialized = await materializeRepo({ url: input.sourceUrl });
  try {
    const lock = await readSkillLock(input.skillsRoot);
    const onlyNames = input.onlyNames ? new Set(input.onlyNames) : undefined;
    const directories = (await skillDirectories(materialized.directory, 6)).sort((left, right) => skillSourceRank(left) - skillSourceRank(right));
    const entries: Array<{ name: string; skillPath: string }> = [];
    const failures: string[] = [];
    let updated = 0;
    let added = 0;
    for (const directory of directories) {
      const name = path.basename(directory);
      if (!isSafeComponentName(name)) {
        continue;
      }
      const relative = path.relative(materialized.directory, directory).split(path.sep).join("/");
      const linked = [...lock.entries()].filter(([, entry]) => entry.source === input.sourceName && sameSkillPath(entry.skillPath, relative));
      const siblings = directories
        .map((item) => path.relative(materialized.directory, item).split(path.sep).join("/"))
        .filter((item) => path.posix.basename(item) === name);
      const folders = linked.length ? linked.map(([folder]) => folder) : [installFolderName(name, relative, siblings)];
      for (const folder of folders) {
        if (!isSafeComponentName(folder)) {
          continue;
        }
        const existing = lock.get(folder);
        if (existing && existing.source !== input.sourceName) {
          continue;
        }
        const selected = onlyNames ? onlyNames.has(folder) : !!existing;
        if (!selected && !(input.addNew && !existing)) {
          continue;
        }
        const destination = path.join(input.skillsRoot, folder);
        const existed = await pathExists(destination);
        const wasOff = existed && await pathExists(path.join(destination, "SKILL.md.off")) && !(await pathExists(path.join(destination, "SKILL.md")));
        try {
          await replaceSkillDirectory(input.skillsRoot, directory, destination);
        } catch (error) {
          failures.push(`${folder}: ${errorMessage(error)}`);
          continue;
        }
        if (wasOff) {
          const enabledFile = path.join(destination, "SKILL.md");
          if (await pathExists(enabledFile)) {
            await rename(enabledFile, path.join(destination, "SKILL.md.off"));
          }
        }
        entries.push({ name: folder, skillPath: `${relative}/SKILL.md` });
        if (existed) {
          updated += 1;
        } else {
          added += 1;
        }
      }
    }
    await rememberLockedSkills(input.skillsRoot, input.sourceName, input.sourceUrl, entries);
    return { updated, added, failures };
  } finally {
    await materialized.cleanup();
  }
}

async function replaceSkillDirectory(skillsRoot: string, source: string, destination: string): Promise<void> {
  const staging = `${destination}.hub-staging`;
  const aside = `${destination}.hub-previous`;
  if (await pathExists(staging)) {
    await removeTree(staging, skillsRoot);
  }
  try {
    await copyTree(source, staging);
    const existed = await pathExists(destination);
    if (existed) {
      if (await pathExists(aside)) {
        await removeTree(aside, skillsRoot);
      }
      await moveAside(destination, aside);
    }
    try {
      await moveAside(staging, destination);
    } catch (error) {
      if (existed && await pathExists(aside) && !(await pathExists(destination))) {
        await moveAside(aside, destination);
      }
      throw error;
    }
    if (await pathExists(aside)) {
      await removeTree(aside, skillsRoot);
    }
  } finally {
    if (await pathExists(staging)) {
      await removeTree(staging, skillsRoot).catch(() => undefined);
    }
  }
}

async function rememberLockedSkills(skillsRoot: string, source: string, sourceUrl: string, entries: Array<{ name: string; skillPath: string }>): Promise<void> {
  if (!entries.length) {
    return;
  }
  const file = path.join(path.dirname(skillsRoot), ".skill-lock.json");
  let parsed: { version?: number; skills?: Record<string, Record<string, unknown>> } = { version: 3, skills: {} };
  if (await pathExists(file)) {
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
    } catch {
      parsed = { version: 3, skills: {} };
    }
  }
  parsed.skills = parsed.skills ?? {};
  const now = new Date().toISOString();
  for (const entry of entries) {
    const current = parsed.skills[entry.name] ?? {};
    parsed.skills[entry.name] = {
      ...current,
      source,
      sourceType: "github",
      sourceUrl,
      skillPath: entry.skillPath,
      installedAt: typeof current.installedAt === "string" ? current.installedAt : now,
      updatedAt: now,
    };
  }
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function agentStoreSkillRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const base of agentStoreBases()) {
    if (!(await pathExists(base))) {
      continue;
    }
    const stores = await readdir(base, { withFileTypes: true });
    for (const store of stores) {
      if (!store.isDirectory()) {
        continue;
      }
      const skills = path.join(base, store.name, "files", "skills");
      if (await pathExists(skills)) {
        roots.push(skills);
      }
    }
  }
  return roots;
}

function sameSkillPath(skillPath: string | undefined, directory: string): boolean {
  const file = (skillPath || "").replace(/\\/g, "/").replace(/\/SKILL\.md$/i, "").replace(/^\//, "");
  return file === directory;
}

function skillSourceRank(skillPath: string): number {
  const normalized = skillPath.replace(/\\/g, "/");
  if (normalized.includes(".claude/skills")) {
    return 2;
  }
  if (normalized.includes("cli/assets/skills")) {
    return 0;
  }
  return 1;
}

async function skillDirectories(root: string, depth: number): Promise<string[]> {
  const result: string[] = [];
  await walkSkills(root, depth, result);
  return result;
}

async function walkSkills(directory: string, depth: number, result: string[]): Promise<void> {
  if (depth < 0) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    if (entry.name.startsWith(".") && entry.name !== ".claude" && entry.name !== ".agents" && entry.name !== ".cursor") {
      continue;
    }
    const next = path.join(directory, entry.name);
    if (await skillMarker(next)) {
      result.push(next);
      continue;
    }
    await walkSkills(next, depth - 1, result);
  }
}

function locksFor(location: InstallLocation): boolean {
  return location === "agents-skills" || location === "cursor-skills" || location === "agent-store";
}

async function skillMarker(directory: string): Promise<{ file: string; enabled: boolean } | undefined> {
  const enabled = path.join(directory, "SKILL.md");
  if (await pathExists(enabled)) {
    return { file: enabled, enabled: true };
  }
  const disabled = path.join(directory, "SKILL.md.off");
  if (await pathExists(disabled)) {
    return { file: disabled, enabled: false };
  }
  return undefined;
}

async function originFor(
  location: InstallLocation,
  directory: string,
  locked?: SkillLockEntry,
): Promise<{ id: string; name: string; url?: string; path?: string } | undefined> {
  if (locked) {
    return { id: `repo:${locked.source}`, name: locked.source, url: locked.sourceUrl, path: locked.skillPath };
  }
  if (location === "skills-cursor") {
    return { id: "builtin:cursor", name: "Cursor" };
  }
  if (location === "plugin-skill") {
    return pluginOrigin(directory);
  }
  return undefined;
}

async function pluginOrigin(directory: string): Promise<{ id: string; name: string; url?: string } | undefined> {
  const fromPath = pluginKeyFromPath(directory);
  let current = directory;
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = await readPluginLabel(current);
    if (manifest) {
      return { id: fromPath ?? `plugin:${manifest.name}`, name: manifest.label, url: manifest.repository };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (!fromPath) {
    return undefined;
  }
  const parts = fromPath.split("/");
  return { id: fromPath, name: parts[parts.length - 1] || fromPath };
}

function pluginKeyFromPath(directory: string): string | undefined {
  const normalized = directory.replace(/\\/g, "/");
  const cached = normalized.match(/\/plugins\/cache\/([^/]+)\/([^/]+)/i);
  if (cached) {
    return `plugin:${cached[1]}/${cached[2]}`;
  }
  const local = normalized.match(/\/plugins\/local\/([^/]+)/i);
  if (local) {
    return `plugin:local/${local[1]}`;
  }
  return undefined;
}

async function readPluginLabel(directory: string): Promise<{ name: string; label: string; repository?: string } | undefined> {
  for (const relative of [path.join(".cursor-plugin", "plugin.json"), "plugin.json"]) {
    const file = path.join(directory, relative);
    if (!(await pathExists(file))) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { name?: string; displayName?: string; repository?: string | { url?: string } };
      if (!parsed.name) {
        continue;
      }
      const repository = typeof parsed.repository === "string" ? parsed.repository : parsed.repository?.url;
      return { name: parsed.name, label: parsed.displayName || parsed.name, repository };
    } catch {
      continue;
    }
  }
  return undefined;
}
