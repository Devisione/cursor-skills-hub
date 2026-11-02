import * as vscode from "vscode";

export function registerMcp(context: vscode.ExtensionContext, bridgeFile: string): void {
  const languageModel = vscode.lm as { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider } | undefined;
  const register = languageModel?.registerMcpServerDefinitionProvider;
  if (typeof register !== "function") {
    return;
  }
  const server = context.asAbsolutePath("out/src/mcp/server.js");
  context.subscriptions.push(register("skillsHub.mcp", {
    provideMcpServerDefinitions: () => [
      new vscode.McpStdioServerDefinition(
        "Skills Hub",
        process.execPath,
        [server],
        { SKILLS_HUB_BRIDGE: bridgeFile },
        "0.1.0",
      ),
    ],
  }));
}
