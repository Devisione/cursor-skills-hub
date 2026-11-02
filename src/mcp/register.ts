import * as vscode from "vscode";
import { Logger } from "../utils/logger";

const SERVER_NAME = "Skills Hub";

interface CursorMcpApi {
  registerServer(config: {
    name: string;
    server: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  }): void;
  unregisterServer?(name: string): void;
}

export function registerMcp(context: vscode.ExtensionContext, bridgeFile: string, logger: Logger): void {
  const server = context.asAbsolutePath("out/src/mcp/server.js");
  const cursorMcp = cursorMcpApi();
  if (cursorMcp) {
    ignore(() => cursorMcp.unregisterServer?.(SERVER_NAME));
    cursorMcp.registerServer({
      name: SERVER_NAME,
      server: {
        command: process.execPath,
        args: [server],
        env: serverEnvironment(bridgeFile),
      },
    });
    context.subscriptions.push({ dispose: () => ignore(() => cursorMcp.unregisterServer?.(SERVER_NAME)) });
    logger.info("mcp", "Registered the Skills Hub MCP server with Cursor.");
    return;
  }
  if (registerWithEditor(context, server, bridgeFile)) {
    logger.info("mcp", "Registered the Skills Hub MCP server through the editor API.");
    return;
  }
  logger.error("mcp", "This Cursor build has no MCP registration API. The agent cannot search marketplace skills.");
}

function cursorMcpApi(): CursorMcpApi | undefined {
  const cursor = (vscode as typeof vscode & { cursor?: { mcp?: CursorMcpApi } }).cursor;
  if (typeof cursor?.mcp?.registerServer !== "function") {
    return undefined;
  }
  return cursor.mcp;
}

function serverEnvironment(bridgeFile: string): Record<string, string> {
  const env: Record<string, string> = {
    SKILLS_HUB_BRIDGE: bridgeFile,
    ELECTRON_RUN_AS_NODE: "1",
  };
  for (const key of ["SYSTEMROOT", "PATH", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function registerWithEditor(context: vscode.ExtensionContext, server: string, bridgeFile: string): boolean {
  const languageModel = vscode.lm as { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider } | undefined;
  const register = languageModel?.registerMcpServerDefinitionProvider;
  if (typeof register !== "function") {
    return false;
  }
  context.subscriptions.push(register("skillsHub.mcp", {
    provideMcpServerDefinitions: () => [
      new vscode.McpStdioServerDefinition(
        SERVER_NAME,
        process.execPath,
        [server],
        { SKILLS_HUB_BRIDGE: bridgeFile, ELECTRON_RUN_AS_NODE: "1" },
        "0.1.0",
      ),
    ],
  }));
  return true;
}

function ignore(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
}
