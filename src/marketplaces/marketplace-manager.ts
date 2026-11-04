import { CatalogComponent, MarketplaceKind } from "../core/types";
import { GitHubClient } from "../github/github-client";
import { HubError, errorMessage } from "../utils/errors";
import { listFiles, pathExists } from "../utils/filesystem";
import { listWorkingTree, materializeRepo } from "../utils/git";
import { isGitHub, parseGitUrl, ParsedGitUrl } from "../utils/github-url";
import { Logger } from "../utils/logger";
import { readFile } from "fs/promises";
import path from "path";
import { detectMarketplaceKind, posix } from "./marketplace-adapter";
import { filesNeededForCursorMarketplace, indexCursorMarketplace, indexPluginRepository, parseMarketplaceManifest, syntheticPlugins } from "./cursor-adapter";
import { indexSkillsRepository, skillFiles } from "./skills-adapter";

export interface IndexedMarketplace {
  url: ParsedGitUrl;
  kind: MarketplaceKind;
  name?: string;
  commitSha: string;
  treeSha?: string;
  components: CatalogComponent[];
}

export async function indexMarketplace(input: {
  url: string;
  marketplaceId: string;
  token?: string;
  logger: Logger;
}): Promise<IndexedMarketplace> {
  const parsed = parseGitUrl(input.url);
  try {
    if (isGitHub(parsed) && input.token) {
      return await indexGitHub(parsed, input.marketplaceId, input.token, input.logger);
    }
  } catch (error) {
    if (error instanceof HubError && (error.code === "unsupported-marketplace" || error.code === "invalid-url")) {
      throw error;
    }
    input.logger.warn("marketplace", `GitHub API index failed, using Git. ${errorMessage(error)}`);
  }
  return indexWithGit(parsed, input.marketplaceId, input.token, input.logger, true);
}

async function indexGitHub(parsed: ParsedGitUrl, marketplaceId: string, token: string, logger: Logger): Promise<IndexedMarketplace> {
  const client = new GitHubClient(token);
  const owner = parsed.owner ?? "";
  const repo = parsed.repo ?? "";
  const info = await client.repo(owner, repo);
  const tree = await client.tree(owner, repo, info.defaultBranch);
  if (tree.truncated) {
    logger.warn("marketplace", `${parsed.normalized} tree is truncated. Indexing from a Git checkout.`);
    return indexWithGit(parsed, marketplaceId, token, logger, true);
  }
  const head = await client.branchSha(owner, repo, info.defaultBranch);
  return buildIndex({
    parsed,
    marketplaceId,
    commitSha: head,
    treeSha: tree.sha,
    paths: tree.paths,
    read: (files) => client.readFiles(owner, repo, files, head),
    logger,
    followExternal: true,
    token,
  });
}

async function indexWithGit(
  parsed: ParsedGitUrl,
  marketplaceId: string,
  token: string | undefined,
  logger: Logger,
  followExternal: boolean,
): Promise<IndexedMarketplace> {
  const materialized = await materializeRepo({ url: parsed.normalized, token });
  try {
    const listed = await listWorkingTree(materialized.directory);
    const paths = listed.length > 0 ? listed : (await listFiles(materialized.directory)).map((file) => path.relative(materialized.directory, file).replace(/\\/g, "/"));
    return await buildIndex({
      parsed,
      marketplaceId,
      commitSha: materialized.commitSha,
      paths,
      read: async (files) => {
        const map = new Map<string, string>();
        for (const file of files) {
          const full = path.join(materialized.directory, file);
          if (await pathExists(full)) {
            map.set(posix(file), await readFile(full, "utf8"));
          }
        }
        return map;
      },
      logger,
      followExternal,
      token,
    });
  } finally {
    await materialized.cleanup();
  }
}

async function buildIndex(input: {
  parsed: ParsedGitUrl;
  marketplaceId: string;
  commitSha: string;
  treeSha?: string;
  paths: string[];
  read: (files: string[]) => Promise<Map<string, string>>;
  logger: Logger;
  followExternal: boolean;
  token?: string;
}): Promise<IndexedMarketplace> {
  const paths = input.paths.map(posix);
  const kind = detectMarketplaceKind(paths);
  if (!kind) {
    throw new HubError(
      "unsupported-marketplace",
      "This repository is not a supported marketplace. It needs a .cursor-plugin/marketplace.json, a plugin manifest, or at least one SKILL.md.",
    );
  }
  const checkedAt = new Date().toISOString();
  const needed = await neededFiles(kind, paths, input.read);
  const files = await input.read(needed);
  let name: string | undefined;
  let components: CatalogComponent[] = [];
  if (kind === "cursor-marketplace") {
    const indexed = indexCursorMarketplace({
      marketplaceId: input.marketplaceId,
      repositoryUrl: input.parsed.normalized,
      commitSha: input.commitSha,
      paths,
      files,
      checkedAt,
    });
    name = indexed.name;
    components = indexed.components;
    components = await enrichExternal(components, input);
  } else if (kind === "skills-catalog") {
    components = indexSkillsRepository({
      marketplaceId: input.marketplaceId,
      repositoryUrl: input.parsed.normalized,
      commitSha: input.commitSha,
      paths,
      files,
      checkedAt,
    });
  } else {
    components = indexPluginRepository({
      marketplaceId: input.marketplaceId,
      repositoryUrl: input.parsed.normalized,
      commitSha: input.commitSha,
      paths,
      files,
      checkedAt,
      kind,
    });
  }
  input.logger.info("marketplace", `Indexed ${components.length} components from ${input.parsed.normalized}.`);
  return {
    url: input.parsed,
    kind,
    name,
    commitSha: input.commitSha,
    treeSha: input.treeSha,
    components,
  };
}

async function neededFiles(
  kind: MarketplaceKind,
  paths: string[],
  read: (files: string[]) => Promise<Map<string, string>>,
): Promise<string[]> {
  if (kind === "skills-catalog") {
    return skillFiles(paths);
  }
  if (kind === "cursor-plugin" || kind === "agent-plugin") {
    const manifests = [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"].filter((item) => paths.includes(item));
    return unique([...manifests, ...skillFiles(paths)]);
  }
  const manifest = await read([".cursor-plugin/marketplace.json"]);
  const text = manifest.get(".cursor-plugin/marketplace.json");
  const plugins = text ? parseMarketplaceManifest(text).plugins : syntheticPlugins(paths);
  return unique([".cursor-plugin/marketplace.json", ...filesNeededForCursorMarketplace(paths, plugins)]);
}

async function enrichExternal(
  components: CatalogComponent[],
  input: { marketplaceId: string; commitSha: string; logger: Logger; followExternal: boolean; token?: string },
): Promise<CatalogComponent[]> {
  if (!input.followExternal) {
    return components;
  }
  const external = components.filter((item) => item.type === "plugin" && item.repositoryUrl && item.pathInRepo === "" && item.commitSha === undefined);
  if (external.length === 0) {
    return components;
  }
  const extras: CatalogComponent[] = [];
  for (const plugin of external) {
    try {
      const indexed = await indexWithGit(parseGitUrl(plugin.repositoryUrl), input.marketplaceId, input.token, input.logger, false);
      extras.push(...indexed.components.filter((item) => item.type === "skill"));
    } catch (error) {
      input.logger.warn("marketplace", `Skipped external plugin ${plugin.name}. ${errorMessage(error)}`);
    }
  }
  return components.concat(extras);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
