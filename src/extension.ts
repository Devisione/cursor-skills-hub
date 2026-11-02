import { rm } from "fs/promises";
import os from "os";
import path from "path";
import * as vscode from "vscode";
import { Hub } from "./core/hub";
import { AuthManager } from "./github/auth-manager";
import { startBridge } from "./mcp/bridge";
import { registerMcp } from "./mcp/register";
import { BackupManager } from "./core/backup-manager";
import { StateManager } from "./core/state-manager";
import { downloadExtensionVsix, extensionUpdateAvailable, fetchLatestExtensionRelease, ExtensionRelease } from "./core/extension-updater";
import { CacheManager } from "./storage/cache-manager";
import { ensureStorage } from "./storage/local-storage";
import { pathExists } from "./utils/filesystem";
import { errorMessage } from "./utils/errors";
import { Logger } from "./utils/logger";
import { registerCommands } from "./ui/commands";
import { SidebarProvider } from "./ui/sidebar-provider";
import { InstallScope } from "./core/types";

const EXTENSION_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const PENDING_EXTENSION_VERSION = "skillsHub.pendingExtensionVersion";

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
  watchExtensionUpdates(context, logger, hub);
  logger.info("extension", "Skills Hub is ready.");
}

export function deactivate(): void {
  return undefined;
}

function watchExtensionUpdates(context: vscode.ExtensionContext, logger: Logger, hub: Hub): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let promptedFor = "";
  let notifiedFor = "";
  let reportedFailure = "";

  const check = async (manual: boolean) => {
    if (running) {
      if (manual) {
        throw new Error("An extension update is already running.");
      }
      return;
    }
    running = true;
    try {
      await checkExtensionRelease(context, logger, hub, manual, (version, force) => promptReload(version, force), askToUpdate);
    } finally {
      running = false;
    }
  };

  const promptReload = async (version: string, force: boolean) => {
    if (!force && promptedFor === version) {
      return;
    }
    promptedFor = version;
    const choice = await vscode.window.showInformationMessage(
      `Skills Hub ${version} is installed. Reload Cursor to finish the update.`,
      "Reload",
    );
    if (choice === "Reload") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  };

  const askToUpdate = async (version: string): Promise<boolean> => {
    if (notifiedFor === version) {
      return false;
    }
    notifiedFor = version;
    const choice = await vscode.window.showInformationMessage(`Skills Hub ${version} is available.`, "Update", "Later");
    return choice === "Update";
  };

  const runAutomatic = () => check(false).catch((error) => {
    const message = errorMessage(error);
    logger.error("extension", message);
    if (reportedFailure === message) {
      return;
    }
    reportedFailure = message;
    void vscode.window.showErrorMessage(`Skills Hub could not install the update. ${message}`);
  });

  context.subscriptions.push(vscode.commands.registerCommand("skillsHub.updateExtension", () => check(true).catch((error) => {
    void vscode.window.showErrorMessage(errorMessage(error));
  })));

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    logger.info("extension", "Automatic extension updates are skipped in development.");
    return;
  }

  const schedule = () => {
    timer = setTimeout(() => {
      void runAutomatic().finally(schedule);
    }, EXTENSION_CHECK_INTERVAL);
  };
  const kick = setTimeout(() => {
    void runAutomatic().finally(schedule);
  }, 8000);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(kick);
      if (timer) {
        clearTimeout(timer);
      }
    },
  });
}

async function checkExtensionRelease(
  context: vscode.ExtensionContext,
  logger: Logger,
  hub: Hub,
  manual: boolean,
  promptReload: (version: string, force: boolean) => Promise<void>,
  askToUpdate: (version: string) => Promise<boolean>,
): Promise<void> {
  const current = String(context.extension.packageJSON.version ?? "0.0.0");
  const pending = context.globalState.get<string>(PENDING_EXTENSION_VERSION);
  if (pending && !extensionUpdateAvailable(current, pending)) {
    await context.globalState.update(PENDING_EXTENSION_VERSION, undefined);
  }
  let release: ExtensionRelease;
  try {
    release = await fetchLatestExtensionRelease();
  } catch (error) {
    if (manual) {
      throw error;
    }
    logger.error("extension", errorMessage(error));
    return;
  }
  if (!extensionUpdateAvailable(current, release.version)) {
    hub.setExtensionStatus({ version: current, latest: current, phase: "current" });
    if (manual) {
      void vscode.window.showInformationMessage(`Skills Hub ${current} is the latest release.`);
    } else {
      logger.info("extension", `Skills Hub ${current} is the latest release.`);
    }
    return;
  }
  const installed = context.globalState.get<string>(PENDING_EXTENSION_VERSION) === release.version;
  if (installed) {
    hub.setExtensionStatus({ version: current, latest: release.version, phase: "installed" });
    await promptReload(release.version, manual);
    return;
  }
  if (!manual) {
    hub.setExtensionStatus({ version: current, latest: release.version, phase: "available" });
    logger.info("extension", `Skills Hub ${release.version} is available.`);
    if (!(await askToUpdate(release.version))) {
      return;
    }
  }
  await installExtensionRelease(context, logger, hub, release, current, promptReload);
}

async function installExtensionRelease(
  context: vscode.ExtensionContext,
  logger: Logger,
  hub: Hub,
  release: ExtensionRelease,
  current: string,
  promptReload: (version: string, force: boolean) => Promise<void>,
): Promise<void> {
  const destination = path.join(os.tmpdir(), "cursor-skills-hub", `cursor-skills-hub-${release.version}.vsix`);
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Updating Skills Hub to ${release.version}`,
    }, async () => {
      await downloadExtensionVsix(release.vsixUrl, destination);
      try {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(destination));
      } finally {
        await rm(destination, { force: true }).catch(() => undefined);
      }
    });
  } catch (error) {
    hub.setExtensionStatus({ version: current, latest: release.version, phase: "available" });
    throw error;
  }
  await context.globalState.update(PENDING_EXTENSION_VERSION, release.version);
  hub.setExtensionStatus({ version: current, latest: release.version, phase: "installed" });
  logger.info("extension", `Installed Skills Hub ${release.version}. Reload to finish.`);
  await promptReload(release.version, true);
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
