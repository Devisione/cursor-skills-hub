import { MarketplaceKind } from "../core/types";

export function detectMarketplaceKind(paths: string[]): MarketplaceKind | undefined {
  const normalized = paths.map((item) => item.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (normalized.includes(".cursor-plugin/marketplace.json")) {
    return "cursor-marketplace";
  }
  if (normalized.includes(".cursor-plugin/plugin.json") || normalized.includes(".claude-plugin/plugin.json")) {
    return "cursor-plugin";
  }
  if (normalized.includes("plugin.json")) {
    return "agent-plugin";
  }
  if (normalized.some((item) => item.endsWith("/.cursor-plugin/plugin.json") || item.endsWith("/.claude-plugin/plugin.json"))) {
    return "cursor-marketplace";
  }
  if (normalized.some((item) => item === "SKILL.md" || item.endsWith("/SKILL.md"))) {
    return "skills-catalog";
  }
  return undefined;
}

export function posix(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function ignoredCatalogPath(value: string): boolean {
  return posix(value).split("/").some((part) => part === ".git" || part === "node_modules");
}
