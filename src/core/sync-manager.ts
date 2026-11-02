import { GitHubClient } from "../github/github-client";
import { buildRemoteFiles, parseRemoteFiles, remoteReadme } from "../github/config-sync";
import { splitRepo } from "../github/repository-manager";
import { HubState, RemoteSnapshot } from "./types";
import { HubError } from "../utils/errors";

const FILES = ["config.json", "marketplaces.json", "installed.json", "settings.json", "lock.json"] as const;

export interface RemoteRead {
  sha: string;
  branch: string;
  snapshot: RemoteSnapshot;
  empty: boolean;
}

export async function readRemote(client: GitHubClient, fullName: string): Promise<RemoteRead> {
  const { owner, name } = splitRepo(fullName);
  const repo = await client.repo(owner, name);
  let sha = "";
  try {
    sha = await client.branchSha(owner, name, repo.defaultBranch);
  } catch (error) {
    if (error instanceof HubError && error.code === "github-404") {
      return {
        sha: "",
        branch: repo.defaultBranch,
        snapshot: parseRemoteFiles({}),
        empty: true,
      };
    }
    throw error;
  }
  const contents = await client.readFiles(owner, name, [...FILES], sha);
  const snapshot = parseRemoteFiles({
    config: contents.get("config.json"),
    marketplaces: contents.get("marketplaces.json"),
    installed: contents.get("installed.json"),
    settings: contents.get("settings.json"),
    lock: contents.get("lock.json"),
  });
  const empty = !contents.get("installed.json") && !contents.get("marketplaces.json");
  return { sha, branch: repo.defaultBranch, snapshot, empty };
}

export async function pushRemote(client: GitHubClient, fullName: string, state: HubState, expectedSha?: string): Promise<string> {
  const { owner, name } = splitRepo(fullName);
  const repo = await client.repo(owner, name);
  const files = buildRemoteFiles(state);
  let base = expectedSha;
  try {
    base = await client.branchSha(owner, name, repo.defaultBranch);
  } catch (error) {
    if (!(error instanceof HubError) || error.code !== "github-404") {
      throw error;
    }
    await client.commitFiles({
      owner,
      name,
      branch: repo.defaultBranch,
      message: "Start Skills Hub configuration",
      files: [{ path: "README.md", content: remoteReadme() }, ...Object.entries(files).map(([path, content]) => ({ path, content }))],
    }).catch(async () => {
      await client.createInitialFile(owner, name, "README.md", remoteReadme());
    });
    base = await client.branchSha(owner, name, repo.defaultBranch);
  }
  if (expectedSha && base !== expectedSha) {
    throw new HubError("sync-conflict", "GitHub changed before the update could be saved.");
  }
  return client.commitFiles({
    owner,
    name,
    branch: repo.defaultBranch,
    message: "Update Skills Hub configuration",
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    expectedSha: base,
  });
}
