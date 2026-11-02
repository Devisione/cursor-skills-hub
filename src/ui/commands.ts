import * as vscode from "vscode";
import { Hub } from "../core/hub";

export function registerCommands(context: vscode.ExtensionContext, hub: Hub): void {
  const commands: Array<[string, () => Promise<void>]> = [
    ["skillsHub.showDiagnostics", async () => {
      const document = await vscode.workspace.openTextDocument({ content: await hub.diagnostics(), language: "markdown" });
      await vscode.window.showTextDocument(document, { preview: true });
    }],
    ["skillsHub.checkUpdates", async () => {
      await hub.checkUpdates(true);
    }],
    ["skillsHub.sync", () => hub.sync()],
    ["skillsHub.pull", () => hub.pull()],
    ["skillsHub.push", () => hub.push()],
    ["skillsHub.refreshMarketplaces", () => hub.refreshMarketplace()],
    ["skillsHub.focus", async () => {
      await vscode.commands.executeCommand("skillsHub.main.focus");
    }],
    ["skillsHub.addMarketplace", async () => {
      const url = await vscode.window.showInputBox({ prompt: "Git or HTTPS URL of a skill or plugin marketplace", ignoreFocusOut: true });
      if (url) {
        await hub.addMarketplace(url);
      }
    }],
  ];
  for (const [id, run] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => run().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(message);
    })));
  }
}
