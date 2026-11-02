import { HubError } from "../utils/errors";
import { assertGitHubToken, redactSecrets } from "../utils/security";

interface GitHubErrorBody {
  message?: string;
}

export class GitHubClient {
  constructor(private readonly token: string) {
    assertGitHubToken(token);
  }

  async user(): Promise<{ login: string }> {
    return this.request("GET", "/user");
  }

  async listRepos(): Promise<Array<{ fullName: string; private: boolean; description: string }>> {
    const repos: Array<{ full_name: string; private: boolean; description: string | null }> = [];
    for (let page = 1; page <= 3; page += 1) {
      const batch = await this.request<Array<{ full_name: string; private: boolean; description: string | null }>>(
        "GET",
        `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner`,
      );
      repos.push(...batch);
      if (batch.length < 100) {
        break;
      }
    }
    return repos.map((repo) => ({
      fullName: repo.full_name,
      private: repo.private,
      description: repo.description ?? "",
    }));
  }

  async createPrivateRepo(name: string): Promise<{ fullName: string; defaultBranch: string }> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
      throw new HubError("invalid-repo", "Repository name contains unsupported characters.");
    }
    const created = await this.request<{ full_name: string; default_branch: string }>("POST", "/user/repos", {
      name,
      private: true,
      description: "Cursor Skills Hub configuration",
      auto_init: true,
    });
    return { fullName: created.full_name, defaultBranch: created.default_branch || "main" };
  }

  async repo(owner: string, name: string): Promise<{ defaultBranch: string; private: boolean }> {
    const result = await this.request<{ default_branch: string; private: boolean }>("GET", `/repos/${owner}/${name}`);
    return { defaultBranch: result.default_branch || "main", private: result.private };
  }

  async branchSha(owner: string, name: string, branch: string): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>("GET", `/repos/${owner}/${name}/git/ref/heads/${branch}`);
    return ref.object.sha;
  }

  async tree(owner: string, name: string, branch: string): Promise<{ sha: string; truncated: boolean; paths: string[] }> {
    const result = await this.request<{ sha: string; truncated?: boolean; tree: Array<{ path: string; type: string }> }>(
      "GET",
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    return {
      sha: result.sha,
      truncated: !!result.truncated,
      paths: result.tree.filter((item) => item.type === "blob").map((item) => item.path),
    };
  }

  async readFile(owner: string, name: string, file: string, ref?: string): Promise<string | undefined> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    try {
      const result = await this.request<{ content?: string; encoding?: string }>(
        "GET",
        `/repos/${owner}/${name}/contents/${encodePath(file)}${query}`,
      );
      if (!result.content || result.encoding !== "base64") {
        return undefined;
      }
      return Buffer.from(result.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof HubError && error.code === "github-404") {
        return undefined;
      }
      throw error;
    }
  }

  async readFiles(owner: string, name: string, files: string[], ref?: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        const file = files[index];
        if (!file) {
          continue;
        }
        const text = await this.readFile(owner, name, file, ref);
        if (typeof text === "string") {
          map.set(file, text);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, () => worker()));
    return map;
  }

  async commitFiles(input: {
    owner: string;
    name: string;
    branch: string;
    message: string;
    files: Array<{ path: string; content: string }>;
    expectedSha?: string;
  }): Promise<string> {
    const current = await this.branchSha(input.owner, input.name, input.branch);
    if (input.expectedSha && input.expectedSha !== current) {
      throw new HubError("sync-conflict", "GitHub changed before the update could be saved.");
    }
    const base = await this.request<{ tree: { sha: string } }>("GET", `/repos/${input.owner}/${input.name}/git/commits/${current}`);
    const blobs = await Promise.all(input.files.map(async (file) => {
      const blob = await this.request<{ sha: string }>("POST", `/repos/${input.owner}/${input.name}/git/blobs`, {
        content: file.content,
        encoding: "utf-8",
      });
      return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
    }));
    const tree = await this.request<{ sha: string }>("POST", `/repos/${input.owner}/${input.name}/git/trees`, {
      base_tree: base.tree.sha,
      tree: blobs,
    });
    const commit = await this.request<{ sha: string }>("POST", `/repos/${input.owner}/${input.name}/git/commits`, {
      message: input.message,
      tree: tree.sha,
      parents: [current],
    });
    await this.request("PATCH", `/repos/${input.owner}/${input.name}/git/refs/heads/${input.branch}`, {
      sha: commit.sha,
      force: false,
    });
    return commit.sha;
  }

  async createInitialFile(owner: string, name: string, file: string, content: string): Promise<void> {
    await this.request("PUT", `/repos/${owner}/${name}/contents/${encodePath(file)}`, {
      message: "Start Skills Hub configuration",
      content: Buffer.from(content, "utf8").toString("base64"),
    });
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "cursor-skills-hub",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404) {
      throw new HubError("github-404", "GitHub could not find that repository or file.");
    }
    if (!response.ok) {
      const text = await response.text();
      let message = `GitHub request failed (${response.status}).`;
      try {
        const parsed = JSON.parse(text) as GitHubErrorBody;
        if (parsed.message) {
          message = parsed.message;
        }
      } catch {
        message = text.slice(0, 300) || message;
      }
      throw new HubError(response.status === 409 ? "sync-conflict" : "github-error", redactSecrets(message));
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return await response.json() as T;
  }
}

function encodePath(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}
