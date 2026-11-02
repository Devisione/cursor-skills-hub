import * as vscode from "vscode";
import { Hub } from "./core/hub";
import { AuthManager } from "./github/auth-manager";
import { startBridge } from "./mcp/bridge";
import { registerMcp } from "./mcp/register";
import { BackupManager } from "./core/backup-manager";
import { StateManager } from "./core/state-manager";
import { CacheManager } from "./storage/cache-manager";
import { ensureStorage } from "./storage/local-storage";
import { pathExists } from "./utils/filesystem";
import { Logger } from "./utils/logger";
import { registerCommands } from "./ui/commands";
import { SidebarProvider } from "./ui/sidebar-provider";
import { InstallScope } from "./core/types";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("Cursor Skills Hub");
  const logger = new Logger({ append: (line) => channel.appendLine(line) });
  const paths = await ensureStorage(context.globalStorageUri.fsPath);
  const hadState = await pathExists(paths.state);
  const state = await StateManager.open(paths.state, logger);
  const hub = new Hub(
    state,
    new CacheManager(paths.cache),
    new BackupManager(paths.backups),
    new AuthManager(context.secrets, context.globalState, logger),
    logger,
    String(context.extension.packageJSON.version ?? "0.1.0"),
  );
  context.subscriptions.push(
    channel,
    vscode.window.registerWebviewViewProvider("skillsHub.main", new SidebarProvider(hub, context.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => undefined },
  );
  registerCommands(context, hub);
  const bridge = await startBridge(paths.bridge, logger, (name, args) => callTool(hub, name, args));
  context.subscriptions.push(bridge);
  registerMcp(context, paths.bridge);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("skillsHub") && !hub.isWritingConfiguration()) {
      void hub.importFromConfiguration();
    }
  }));
  await hub.start(hadState);
  logger.info("extension", "Skills Hub is ready.");
}

export function deactivate(): void {
  return undefined;
}

async function callTool(hub: Hub, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "search_skills":
      return hub.search(String(args.query ?? ""), typeof args.category === "string" ? args.category : undefined, Number(args.limit ?? 10));
    case "get_skill_info":
      return hub.skillInfo(String(args.skill_id ?? ""));
    case "install_skill": {
      const skillId = String(args.skill_id ?? "");
      hub.skillInfo(skillId);
      const scope = args.installation_scope === "project" || args.installation_scope === "user" ? args.installation_scope as InstallScope : undefined;
      const result = await hub.install(skillId, scope, true, typeof args.version === "string" ? args.version : undefined);
      return {
        status: "installed",
        installPath: result.installPath,
        version: result.version,
        cursorCanDiscover: true,
        note: result.note,
      };
    }
    case "list_installed_skills":
      return hub.listInstalledSkills();
    case "check_skill_updates": {
      await hub.checkUpdates(false);
      return hub.listInstalledSkills().filter((item) => item.status === "update-available" || item.status === "pinned");
    }
    default:
      throw new Error(`Unknown Skills Hub tool "${name}".`);
  }
}
