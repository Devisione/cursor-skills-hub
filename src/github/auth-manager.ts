import * as vscode from "vscode";
import { GitHubClient } from "./github-client";
import { HubError, errorMessage } from "../utils/errors";
import { Logger } from "../utils/logger";

const PAT_KEY = "skillsHub.githubPat";

export interface GitHubSession {
  token: string;
  login?: string;
  source: "vscode" | "pat";
  client: GitHubClient;
}

export class AuthManager {
  private disabled = false;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly globalState: vscode.Memento,
    private readonly logger: Logger,
  ) {
    this.disabled = this.globalState.get<boolean>("github.disabled", false);
  }

  async current(interactive: boolean): Promise<GitHubSession | undefined> {
    if (this.disabled && !interactive) {
      return undefined;
    }
    if (interactive) {
      this.disabled = false;
      await this.globalState.update("github.disabled", false);
    }
    const vscodeToken = await this.vscodeToken(interactive);
    if (vscodeToken) {
      return this.finish(vscodeToken, "vscode");
    }
    const stored = await this.secrets.get(PAT_KEY);
    if (stored && !interactive) {
      return this.finish(stored, "pat");
    }
    if (!interactive) {
      return undefined;
    }
    const entered = await vscode.window.showInputBox({
      title: "GitHub personal access token",
      prompt: "Cursor could not open the GitHub sign-in dialog. Paste a token with access to your private configuration repository.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!entered) {
      return undefined;
    }
    await this.secrets.store(PAT_KEY, entered.trim());
    return this.finish(entered.trim(), "pat");
  }

  async disconnect(): Promise<void> {
    this.disabled = true;
    await this.globalState.update("github.disabled", true);
    await this.secrets.delete(PAT_KEY);
    this.logger.info("github", "GitHub connection cleared on this device.");
  }

  private async vscodeToken(interactive: boolean): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession("github", ["repo", "read:user"], {
        createIfNone: interactive,
        silent: !interactive,
      });
      return session?.accessToken;
    } catch (error) {
      this.logger.warn("github", errorMessage(error));
      return undefined;
    }
  }

  private async finish(token: string, source: "vscode" | "pat"): Promise<GitHubSession> {
    try {
      const client = new GitHubClient(token);
      const user = await client.user();
      this.logger.info("github", `Connected as ${user.login} through ${source}.`);
      return { token, login: user.login, source, client };
    } catch (error) {
      if (source === "pat") {
        await this.secrets.delete(PAT_KEY);
      }
      throw new HubError("github-auth", errorMessage(error));
    }
  }
}
