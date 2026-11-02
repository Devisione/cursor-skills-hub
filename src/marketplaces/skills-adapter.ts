import { CatalogComponent } from "../core/types";
import { componentIdFor } from "../utils/github-url";
import { parseFrontmatter } from "../utils/frontmatter";
import { isSafeComponentName } from "../utils/security";
import { ignoredCatalogPath, posix } from "./marketplace-adapter";

export function indexSkillsRepository(input: {
  marketplaceId: string;
  repositoryUrl: string;
  commitSha: string;
  paths: string[];
  files: Map<string, string>;
  checkedAt: string;
}): CatalogComponent[] {
  const components: CatalogComponent[] = [];
  for (const skillPath of input.paths) {
    const value = posix(skillPath);
    if (ignoredCatalogPath(value) || (value !== "SKILL.md" && !value.endsWith("/SKILL.md"))) {
      continue;
    }
    const text = input.files.get(value);
    if (!text) {
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    if (!frontmatter.name || !isSafeComponentName(frontmatter.name)) {
      continue;
    }
    const directory = value.replace(/\/SKILL\.md$/, "").replace(/^SKILL\.md$/, "");
    components.push({
      id: componentIdFor(input.marketplaceId, "skill", `${input.repositoryUrl}#${directory}#${frontmatter.name}`),
      type: "skill",
      name: frontmatter.name,
      description: (frontmatter.description ?? "").slice(0, 2000),
      author: frontmatter.author,
      marketplaceId: input.marketplaceId,
      repositoryUrl: input.repositoryUrl,
      pathInRepo: directory,
      commitSha: input.commitSha,
      categories: frontmatter.categories,
      capabilities: frontmatter.capabilities,
      dependencies: frontmatter.dependencies,
      checkedAt: input.checkedAt,
    });
  }
  return components;
}

export function skillFiles(paths: string[]): string[] {
  return paths
    .map(posix)
    .filter((item) => !ignoredCatalogPath(item) && (item === "SKILL.md" || item.endsWith("/SKILL.md")));
}
