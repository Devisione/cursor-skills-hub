import * as vscode from "vscode";
import { Hub } from "../core/hub";
import { errorMessage } from "../utils/errors";

export class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly hub: Hub,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = html(webview, this.extensionUri);
    const send = () => webview.postMessage({ type: "state", model: this.hub.getViewModel() });
    const subscription = this.hub.onDidChange(send);
    webviewView.onDidDispose(() => subscription.dispose());
    webview.onDidReceiveMessage(async (message: { type: string; [key: string]: unknown }) => {
      try {
        await this.handle(webview, message);
      } catch (error) {
        webview.postMessage({ type: "error", message: errorMessage(error) });
      }
      send();
    });
    send();
  }

  private async handle(webview: vscode.Webview, message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case "install":
        await this.hub.install(String(message.id));
        return;
      case "installMany":
        await this.hub.installMany(Array.isArray(message.ids) ? message.ids.map(String) : []);
        return;
      case "uninstall":
        await this.hub.uninstall(String(message.id));
        return;
      case "enable":
        await this.hub.setEnabled(String(message.id), Boolean(message.enabled));
        return;
      case "removeBundle":
        await this.hub.removeBundle(String(message.bundleId ?? ""));
        return;
      case "updateBundle":
        await this.hub.updateBundle(String(message.bundleId ?? ""));
        return;
      case "updateSkill":
        await this.hub.updateSkill(String(message.id ?? ""));
        return;
      case "openLink":
        await this.hub.openLink(String(message.url ?? ""));
        return;
      case "update":
        await this.hub.update(String(message.id));
        return;
      case "updateAll":
        await this.hub.updateAll();
        return;
      case "pin":
        await this.hub.pin(String(message.id), Boolean(message.pinned));
        return;
      case "rollback":
        await this.hub.rollback(String(message.id));
        return;
      case "addMarketplace":
        await this.hub.addMarketplace(String(message.url ?? ""));
        return;
      case "removeMarketplace":
        await this.hub.removeMarketplace(String(message.id));
        return;
      case "trust":
        await this.hub.setTrusted(String(message.id), Boolean(message.trusted));
        return;
      case "refresh":
        await this.hub.refreshMarketplace();
        return;
      case "refreshOne":
        await this.hub.refreshMarketplace(String(message.id));
        return;
      case "connect":
        await this.hub.connectGitHub();
        return;
      case "disconnect":
        await this.hub.disconnectGitHub();
        return;
      case "listRepos":
        webview.postMessage({ type: "repos", repos: await this.hub.listRepositories() });
        return;
      case "selectRepo":
        await this.hub.selectRepository(String(message.fullName ?? ""));
        webview.postMessage({ type: "done" });
        return;
      case "createRepo":
        await this.hub.createRepository(String(message.name ?? ""));
        webview.postMessage({ type: "done" });
        return;
      case "pull":
        await this.hub.pull();
        return;
      case "push":
        await this.hub.push();
        return;
      case "sync":
        await this.hub.sync();
        return;
      case "resolve":
        await this.hub.resolveConflict(message.choice === "remote" ? "remote" : "local");
        return;
      case "syncVisibility":
        await this.hub.setSyncVisibility(
          message.kind === "marketplace" || message.kind === "bundle" ? message.kind : "skill",
          String(message.id ?? ""),
          Boolean(message.excluded),
        );
        return;
      case "settings":
        await this.hub.updateSettings((message.patch ?? {}) as Parameters<Hub["updateSettings"]>[0]);
        return;
      case "open":
        await this.hub.openSource(String(message.id));
        return;
      case "reveal":
        await this.hub.reveal(String(message.id));
        return;
      case "diff":
        await this.hub.viewChanges(String(message.id));
        return;
      case "check":
        await this.hub.checkUpdates(true);
        return;
      case "updateExtension":
        await vscode.commands.executeCommand("skillsHub.updateExtension");
        return;
      case "reloadWindow":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return;
      case "donate":
        await vscode.env.openExternal(vscode.Uri.parse("https://www.donationalerts.com/r/link_it"));
        return;
      default:
        return;
    }
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = Math.random().toString(36).slice(2);
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.css"));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${css}" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
