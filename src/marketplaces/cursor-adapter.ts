import { CatalogComponent } from "../core/types";
import { componentIdFor } from "../utils/github-url";
import { parseFrontmatter } from "../utils/frontmatter";
import { isSafeComponentName } from "../utils/security";
import { ignoredCatalogPath, posix } from "./marketplace-adapter";

export interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  keywords?: string[];
  category?: string;
}

export interface ParsedMarketplace {
  name?: string;
  plugins: MarketplacePluginEntry[];
}

export function parseMarketplaceManifest(text: string): ParsedMarketplace {
  const parsed = JSON.parse(text) as {
    name?: string;
    plugins?: Array<{
      name?: string;
      source?: string | { url?: string; path?: string };
      description?: string;
      keywords?: string[];
      category?: string;
    }>;
  };
  const plugins: MarketplacePluginEntry[] = [];
  for (const plugin of parsed.plugins ?? []) {
    if (!plugin.name) {
      continue;
    }
    const source = sourceOf(plugin.source);
    if (!source) {
      continue;
    }
    plugins.push({
      name: plugin.name,
      source,
      description: plugin.description,
      keywords: plugin.keywords,
      category: plugin.category,
    });
  }
  return { name: parsed.name, plugins };
}

export function indexCursorMarketplace(input: {
  marketplaceId: string;
  repositoryUrl: string;
  commitSha: string;
  paths: string[];
  files: Map<string, string>;
  checkedAt: string;
}): { name?: string; components: CatalogComponent[] } {
  const manifestText = input.files.get(".cursor-plugin/marketplace.json");
  const manifest = manifestText
    ? parseMarketplaceManifest(manifestText)
    : { name: undefined, plugins: syntheticPlugins(input.paths) };
  const components: CatalogComponent[] = [];
  for (const plugin of manifest.plugins) {
    if (isGitSource(plugin.source)) {
      components.push(component({
        marketplaceId: input.marketplaceId,
        type: "plugin",
        name: plugin.name,
        description: plugin.description ?? "",
        repositoryUrl: plugin.source,
        pathInRepo: "",
        commitSha: undefined,
        version: undefined,
        categories: categoriesOf(plugin),
        author: undefined,
        checkedAt: input.checkedAt,
        capabilities: [],
        dependencies: [],
      }));
      continue;
    }
    const prefix = posix(plugin.source);
    const pluginRoot = prefix || ".";
    const manifestPath = [".cursor-plugin/plugin.json", "plugin.json"]
      .map((item) => (prefix ? `${prefix}/${item}` : item))
      .find((item) => input.files.has(item));
    const pluginJson = manifestPath ? readPlugin(input.files.get(manifestPath) ?? "") : undefined;
    components.push(component({
      marketplaceId: input.marketplaceId,
      type: "plugin",
      name: pluginJson?.name || plugin.name,
      description: pluginJson?.description || plugin.description || "",
      author: pluginJson?.author,
      repositoryUrl: input.repositoryUrl,
      pathInRepo: pluginRoot === "." ? "" : pluginRoot,
      version: pluginJson?.version,
      commitSha: input.commitSha,
      categories: [...categoriesOf(plugin), ...(pluginJson?.keywords ?? [])],
      checkedAt: input.checkedAt,
      capabilities: [],
      dependencies: [],
    }));
    for (const skillPath of skillFilesUnder(input.paths, prefix)) {
      const text = input.files.get(skillPath);
      if (!text) {
        continue;
      }
      const skill = skillComponent({
        marketplaceId: input.marketplaceId,
        repositoryUrl: input.repositoryUrl,
        commitSha: input.commitSha,
        skillPath,
        text,
        author: pluginJson?.author,
        categories: categoriesOf(plugin),
        checkedAt: input.checkedAt,
      });
      if (skill) {
        components.push(skill);
      }
    }
  }
  return { name: manifest.name, components: dedupe(components) };
}

export function syntheticPlugins(paths: string[]): MarketplacePluginEntry[] {
  return paths.filter((item) => item.endsWith("/.cursor-plugin/plugin.json")).map((item) => {
    const source = item.replace(/\/\.cursor-plugin\/plugin\.json$/, "");
    const name = source.split("/").pop() || source;
    return { name, source };
  });
}

export function indexPluginRepository(input: {
  marketplaceId: string;
  repositoryUrl: string;
  commitSha: string;
  paths: string[];
  files: Map<string, string>;
  checkedAt: string;
  kind: "cursor-plugin" | "agent-plugin";
}): CatalogComponent[] {
  const manifestPath = input.kind === "cursor-plugin" ? ".cursor-plugin/plugin.json" : "plugin.json";
  const pluginJson = readPlugin(input.files.get(manifestPath) ?? "");
  if (!pluginJson) {
    return [];
  }
  const components: CatalogComponent[] = [component({
    marketplaceId: input.marketplaceId,
    type: "plugin",
    name: pluginJson.name,
    description: pluginJson.description,
    author: pluginJson.author,
    repositoryUrl: input.repositoryUrl,
    pathInRepo: "",
    version: pluginJson.version,
    commitSha: input.commitSha,
    categories: pluginJson.keywords,
    checkedAt: input.checkedAt,
    capabilities: [],
    dependencies: [],
  })];
  for (const skillPath of skillFilesUnder(input.paths, "")) {
    const text = input.files.get(skillPath);
    if (!text) {
      continue;
    }
    const skill = skillComponent({
      marketplaceId: input.marketplaceId,
      repositoryUrl: input.repositoryUrl,
      commitSha: input.commitSha,
      skillPath,
      text,
      author: pluginJson.author,
      categories: pluginJson.keywords,
      checkedAt: input.checkedAt,
    });
    if (skill) {
      components.push(skill);
    }
  }
  return dedupe(components);
}

export function filesNeededForCursorMarketplace(paths: string[], plugins: MarketplacePluginEntry[]): string[] {
  const needed = new Set<string>();
  for (const plugin of plugins) {
    if (isGitSource(plugin.source)) {
      continue;
    }
    const prefix = posix(plugin.source);
    for (const file of skillFilesUnder(paths, prefix)) {
      needed.add(file);
    }
    for (const manifest of [".cursor-plugin/plugin.json", "plugin.json"]) {
      const candidate = prefix ? `${prefix}/${manifest}` : manifest;
      if (paths.includes(candidate)) {
        needed.add(candidate);
      }
    }
  }
  return [...needed];
}

function skillFilesUnder(paths: string[], prefix: string): string[] {
  const needle = prefix ? `${posix(prefix)}/` : "";
  return paths.filter((item) => {
    const value = posix(item);
    if (ignoredCatalogPath(value) || !value.endsWith("/SKILL.md") && value !== "SKILL.md") {
      return false;
    }
    if (!needle) {
      return true;
    }
    return value.startsWith(needle);
  });
}

function skillComponent(input: {
  marketplaceId: string;
  repositoryUrl: string;
  commitSha: string;
  skillPath: string;
  text: string;
  author?: string;
  categories: string[];
  checkedAt: string;
}): CatalogComponent | undefined {
  const frontmatter = parseFrontmatter(input.text);
  if (!frontmatter.name || !isSafeComponentName(frontmatter.name)) {
    return undefined;
  }
  const directory = posix(input.skillPath).replace(/\/SKILL\.md$/, "").replace(/^SKILL\.md$/, "");
  return component({
    marketplaceId: input.marketplaceId,
    type: "skill",
    name: frontmatter.name,
    description: frontmatter.description ?? "",
    author: frontmatter.author || input.author,
    repositoryUrl: input.repositoryUrl,
    pathInRepo: directory,
    commitSha: input.commitSha,
    categories: unique([...input.categories, ...frontmatter.categories]),
    capabilities: frontmatter.capabilities,
    dependencies: frontmatter.dependencies,
    checkedAt: input.checkedAt,
  });
}

function component(input: Omit<CatalogComponent, "id">): CatalogComponent {
  return {
    ...input,
    id: componentIdFor(input.marketplaceId, input.type, `${input.repositoryUrl}#${input.pathInRepo}#${input.name}`),
    categories: unique(input.categories),
    description: input.description.slice(0, 2000),
  };
}

function readPlugin(text: string): { name: string; description: string; version?: string; author?: string; keywords: string[] } | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as {
      name?: string;
      description?: string;
      version?: string;
      author?: { name?: string } | string;
      keywords?: string[];
    };
    if (!parsed.name || !isSafeComponentName(parsed.name)) {
      return undefined;
    }
    return {
      name: parsed.name,
      description: parsed.description ?? "",
      version: parsed.version,
      author: typeof parsed.author === "string" ? parsed.author : parsed.author?.name,
      keywords: parsed.keywords ?? [],
    };
  } catch {
    return undefined;
  }
}

function sourceOf(source: string | { url?: string; path?: string } | undefined): string | undefined {
  if (typeof source === "string" && source.trim()) {
    return source.trim();
  }
  if (source && typeof source === "object") {
    return source.url || source.path;
  }
  return undefined;
}

function isGitSource(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(source);
}

function categoriesOf(plugin: MarketplacePluginEntry): string[] {
  return unique([...(plugin.keywords ?? []), ...(plugin.category ? [plugin.category] : [])]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupe(components: CatalogComponent[]): CatalogComponent[] {
  const seen = new Set<string>();
  return components.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}
