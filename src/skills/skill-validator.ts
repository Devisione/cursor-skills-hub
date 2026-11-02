import { readFile } from "fs/promises";
import path from "path";
import { HubError } from "../utils/errors";
import { isInside } from "../utils/filesystem";
import { parseFrontmatter } from "../utils/frontmatter";
import { isExcludedSkillPath, isUnsafeRelativePath, assertSafeComponentName } from "../utils/security";

export interface ValidatedSkill {
  name: string;
  description: string;
  author?: string;
  categories: string[];
  capabilities: string[];
  dependencies: string[];
  root: string;
}

export async function validateSkillDirectory(root: string): Promise<ValidatedSkill> {
  const skillFile = path.join(root, "SKILL.md");
  const resolvedRoot = path.resolve(root);
  if (!isInside(resolvedRoot, skillFile)) {
    throw new HubError("invalid-skill", "SKILL.md is outside the skill directory.");
  }
  let text: string;
  try {
    text = await readFile(skillFile, "utf8");
  } catch {
    throw new HubError("invalid-skill", "The skill directory does not contain SKILL.md.");
  }
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.name) {
    throw new HubError("invalid-skill", "SKILL.md must start with a name in its frontmatter.");
  }
  assertSafeComponentName(frontmatter.name);
  const { readdir } = await import("fs/promises");
  await rejectUnsafeEntries(resolvedRoot, resolvedRoot, readdir);
  return {
    name: frontmatter.name,
    description: (frontmatter.description ?? "").slice(0, 2000),
    author: frontmatter.author,
    categories: frontmatter.categories,
    capabilities: frontmatter.capabilities,
    dependencies: frontmatter.dependencies,
    root: resolvedRoot,
  };
}

async function rejectUnsafeEntries(
  root: string,
  current: string,
  readdir: typeof import("fs/promises").readdir,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full);
    if (isUnsafeRelativePath(relative)) {
      throw new HubError("path-traversal", `The skill contains an unsafe path "${relative}".`);
    }
    if (isExcludedSkillPath(relative) && entry.isDirectory() && (entry.name === ".git" || entry.name === "node_modules")) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new HubError("symlink-rejected", `The skill contains a symlink at "${relative}".`);
    }
    if (entry.isDirectory()) {
      await rejectUnsafeEntries(root, full, readdir);
    }
  }
}
