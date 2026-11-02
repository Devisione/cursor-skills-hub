import path from "path";
import { CatalogComponent, CancelFlag, InstallScope, SkillLocation } from "../core/types";
import { installRoot, locationFor, WorkspaceHint } from "../core/paths";
import { HubError } from "../utils/errors";
import { checksumDirectory, copyTree, ensureDir, moveAside, pathExists, removeTree } from "../utils/filesystem";
import { materializeRepo } from "../utils/git";
import { assertSafeComponentName } from "../utils/security";
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
}): Promise<SkillInstallResult> {
  assertSafeComponentName(input.component.name);
  const root = installRoot(input.scope, locationFor("skill", input.scope, input.skillLocation), input.workspace);
  await ensureDir(root);
  const destination = path.join(root, input.component.name);
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

function throwIfCancelled(cancel?: CancelFlag): void {
  if (cancel?.isCancellationRequested) {
    throw new HubError("cancelled", "The installation was cancelled.");
  }
}
