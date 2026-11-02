import path from "path";
import { CatalogComponent, CancelFlag, InstallScope, SkillLocation } from "../core/types";
import { installRoot, locationFor, WorkspaceHint } from "../core/paths";
import { HubError } from "../utils/errors";
import { checksumDirectory, copyTree, ensureDir, moveAside, pathExists, removeTree } from "../utils/filesystem";
import { materializeRepo } from "../utils/git";
import { repoSlug } from "../utils/github-url";
import { assertSafeComponentName, isSafeComponentName } from "../utils/security";
import { validateSkillDirectory } from "./skill-validator";

export interface SkillInstallResult {
  name: string;
  description: string;
  installPath: string;
  commitSha: string;
  checksum: string;
  location: ReturnType<typeof locationFor>;
  scope: InstallScope;
  discovery: "scanned-directory";
  note: string;
  backupPath?: string;
}

export async function installSkill(input: {
  component: CatalogComponent;
  scope: InstallScope;
  skillLocation: SkillLocation;
  workspace?: WorkspaceHint;
  ref?: string;
  token?: string;
  backup?: (currentPath: string) => Promise<string | undefined>;
  cancel?: CancelFlag;
  siblingPaths?: string[];
  folderName?: string;
}): Promise<SkillInstallResult> {
  assertSafeComponentName(input.component.name);
  const folder = input.folderName || installFolderName(input.component.name, input.component.pathInRepo, input.siblingPaths);
  const root = installRoot(input.scope, locationFor("skill", input.scope, input.skillLocation), input.workspace);
  await ensureDir(root);
  const destination = path.join(root, folder);
  const materialized = await materializeRepo({
    url: input.component.repositoryUrl,
    ref: input.ref || input.component.commitSha,
    subpath: input.component.pathInRepo || undefined,
    token: input.token,
  });
  const staging = `${destination}.staging`;
  try {
    throwIfCancelled(input.cancel);
    const source = path.join(materialized.directory, input.component.pathInRepo);
    const validated = await validateSkillDirectory(source);
    if (validated.name !== input.component.name) {
      throw new HubError("invalid-skill", `SKILL.md name "${validated.name}" does not match the catalog entry "${input.component.name}".`);
    }
    if (await pathExists(staging)) {
      await removeTree(staging, root);
    }
    await copyTree(source, staging);
    await validateSkillDirectory(staging);
    throwIfCancelled(input.cancel);
    let backupPath: string | undefined;
    if (await pathExists(destination)) {
      backupPath = await input.backup?.(destination);
      const aside = `${destination}.previous`;
      if (await pathExists(aside)) {
        await removeTree(aside, root);
      }
      await moveAside(destination, aside);
    }
    try {
      await moveAside(staging, destination);
    } catch (error) {
      const aside = `${destination}.previous`;
      if (await pathExists(aside) && !(await pathExists(destination))) {
        await moveAside(aside, destination);
      }
      throw error;
    }
    const aside = `${destination}.previous`;
    if (await pathExists(aside)) {
      await removeTree(aside, root);
    }
    const checksum = await checksumDirectory(destination);
    if (!(await pathExists(path.join(destination, "SKILL.md")))) {
      throw new HubError("invalid-skill", "The skill was copied, but SKILL.md is not in a directory Cursor scans.");
    }
    return {
      name: validated.name,
      description: validated.description,
      installPath: destination,
      commitSha: materialized.commitSha,
      checksum,
      location: locationFor("skill", input.scope, input.skillLocation),
      scope: input.scope,
      discovery: "scanned-directory",
      note: "Read SKILL.md inside the install directory and follow it for this task. A new agent chat lists the skill automatically.",
      backupPath,
    };
  } finally {
    if (await pathExists(staging)) {
      await removeTree(staging, root).catch(() => undefined);
    }
    await materialized.cleanup();
  }
}

export async function uninstallSkill(installPath: string, allowedRoot: string): Promise<void> {
  await removeTree(installPath, allowedRoot);
}

export function installFolderName(name: string, pathInRepo?: string, siblingPaths: string[] = []): string {
  const own = skillDirectory(pathInRepo);
  const paths = [...new Set([own, ...siblingPaths.map(skillDirectory)])];
  const used = new Set<string>();
  const folders = new Map<string, string>();
  const ordered = [...paths].sort((left, right) => folderPreference(name, left) - folderPreference(name, right) || left.localeCompare(right));
  for (const directory of ordered) {
    let folder = folderCandidate(name, directory);
    if (used.has(folder)) {
      folder = folderFromPath(name, directory, used);
    }
    folders.set(directory, folder);
    used.add(folder);
  }
  return folders.get(own) ?? name;
}

export function separateMarketplaceFolder(folder: string, repositoryUrl: string | undefined, reserved: string[]): string {
  const taken = new Set(reserved);
  if (!taken.has(folder)) {
    return folder;
  }
  const slug = repositoryUrl ? repoSlug(repositoryUrl) : "other";
  const repo = folderSuffix(slug.split("/").pop() || slug);
  const ownerRepo = folderSuffix(slug);
  for (const suffix of [repo, ownerRepo]) {
    if (!suffix) {
      continue;
    }
    const next = fitFolder(`${folder}--${suffix}`, "");
    if (next && !taken.has(next)) {
      return next;
    }
  }
  let count = 2;
  while (taken.has(`${folder}--${count}`)) {
    count += 1;
  }
  return fitFolder(`${folder}--${count}`, folder);
}

function skillDirectory(pathInRepo?: string): string {
  return (pathInRepo || "").replace(/\\/g, "/").replace(/\/$/, "").replace(/\/SKILL\.md$/i, "");
}

function folderPreference(name: string, directory: string): number {
  if (directory === `skills/${name}` || directory === name) {
    return 0;
  }
  if (directory === "") {
    return 1;
  }
  if (directory.startsWith("skills/")) {
    return 2;
  }
  return 3;
}

function folderCandidate(name: string, directory: string): string {
  if (directory.includes("cli/assets/skills")) {
    return fitFolder(`${name}--cli`, name);
  }
  const parts = directory.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "";
  if (parts.length <= 2 && (leaf === name || leaf === "")) {
    return name;
  }
  const skillsAt = parts.lastIndexOf("skills");
  const raw = skillsAt > 0 ? parts[skillsAt - 1] : parts[parts.length - 2] ?? "";
  const suffix = folderSuffix(raw);
  if (!suffix || suffix === name || suffix === "skills") {
    return name;
  }
  return fitFolder(`${name}--${suffix}`, name);
}

function folderFromPath(name: string, directory: string, used: Set<string>): string {
  if (!directory) {
    const root = fitFolder(`${name}--root`, name);
    if (!used.has(root)) {
      return root;
    }
  }
  const parts = directory.split("/").filter(Boolean);
  const bits: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const suffix = folderSuffix(parts[index] ?? "");
    if (!suffix || suffix === name || suffix === "skills") {
      continue;
    }
    bits.push(suffix);
    const folder = fitFolder(`${name}--${bits.join("-")}`, "");
    if (folder && !used.has(folder)) {
      return folder;
    }
  }
  let count = 2;
  while (used.has(`${name}--${count}`)) {
    count += 1;
  }
  return fitFolder(`${name}--${count}`, name);
}

function folderSuffix(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^\.+|\.+$/g, "");
}

function fitFolder(folder: string, fallback: string): string {
  const trimmed = folder.slice(0, 81).replace(/[.-]+$/g, "");
  return isSafeComponentName(trimmed) ? trimmed : fallback;
}

function throwIfCancelled(cancel?: CancelFlag): void {
  if (cancel?.isCancellationRequested) {
    throw new HubError("cancelled", "The installation was cancelled.");
  }
}
