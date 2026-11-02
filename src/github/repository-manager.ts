import { GitHubClient } from "./github-client";
import { HubError } from "../utils/errors";

export function splitRepo(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split("/");
  if (!owner || !name || fullName.split("/").length !== 2) {
    throw new HubError("invalid-repo", "Choose a repository in owner/name form.");
  }
  return { owner, name };
}

export async function createConfigRepo(client: GitHubClient, name: string): Promise<string> {
  const created = await client.createPrivateRepo(name);
  return created.fullName;
}
