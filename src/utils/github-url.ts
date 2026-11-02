import { createHash } from "crypto";
import { HubError } from "./errors";

export interface ParsedGitUrl {
  raw: string;
  normalized: string;
  host?: string;
  owner?: string;
  repo?: string;
  protocol: "https" | "ssh";
}

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseGitUrl(input: string): ParsedGitUrl {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 500 || /[\s\r\n]/.test(trimmed) || trimmed.startsWith("-")) {
    throw new HubError("invalid-url", "Enter a Git or HTTPS repository URL.");
  }
  if (/^(file|data|javascript):/i.test(trimmed) || trimmed.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new HubError("invalid-url", "Local paths cannot be added as marketplaces.");
  }

  let protocol: "https" | "ssh" = "https";
  let host: string | undefined;
  let owner: string | undefined;
  let repo: string | undefined;
  let normalized = trimmed;

  const ssh = /^git@([^:]+):([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh) {
    protocol = "ssh";
    host = ssh[1];
    owner = ssh[2];
    repo = stripGit(ssh[3] ?? "");
    normalized = `https://${host}/${owner}/${repo}`;
  } else if (OWNER_REPO.test(trimmed)) {
    owner = trimmed.split("/")[0];
    repo = stripGit(trimmed.split("/")[1] ?? "");
    host = "github.com";
    normalized = `https://github.com/${owner}/${repo}`;
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new HubError("invalid-url", "Enter a Git or HTTPS repository URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") {
      throw new HubError("invalid-url", "Only HTTPS and Git SSH URLs are supported.");
    }
    if (url.username || url.password) {
      throw new HubError("invalid-url", "Put credentials in the GitHub connection, not in the URL.");
    }
    protocol = url.protocol === "ssh:" ? "ssh" : "https";
    host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      owner = parts[0];
      repo = stripGit(parts[1] ?? "");
      normalized = `https://${host}/${owner}/${repo}`;
    } else {
      normalized = `https://${host}${url.pathname.replace(/\.git$/, "").replace(/\/$/, "")}`;
    }
  }

  if (host === "github.com" && (!owner || !repo)) {
    throw new HubError("invalid-url", "A GitHub marketplace URL needs an owner and a repository.");
  }

  return { raw: trimmed, normalized: normalized.replace(/\/$/, ""), host, owner, repo, protocol };
}

export function repoSlug(remote: string): string {
  try {
    const parsed = parseGitUrl(remote);
    if (parsed.owner && parsed.repo) {
      return `${parsed.owner}/${parsed.repo}`;
    }
    return parsed.normalized;
  } catch {
    return "unknown";
  }
}

export function marketplaceIdFor(normalizedUrl: string): string {
  return `mkt_${createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 12)}`;
}

export function componentIdFor(marketplaceId: string, type: string, pathInRepo: string): string {
  const hash = createHash("sha256").update(`${marketplaceId}\n${type}\n${pathInRepo}`).digest("hex").slice(0, 16);
  return `${type}_${hash}`;
}

export function isGitHub(parsed: ParsedGitUrl): boolean {
  return parsed.host === "github.com" && !!parsed.owner && !!parsed.repo;
}

function stripGit(value: string): string {
  return value.replace(/\.git$/, "").replace(/\/$/, "");
}
