import * as vscode from "vscode";

export interface ApiProbe {
  cursorNamespace: boolean;
  pluginsNamespace: boolean;
  registerPath: "present" | "missing";
  conclusion: string;
}

export function probeCursorApis(): ApiProbe {
  const cursor = (vscode as unknown as { cursor?: { plugins?: { registerPath?: unknown } } }).cursor;
  const registerPath = cursor?.plugins?.registerPath;
  const present = typeof registerPath === "function";
  return {
    cursorNamespace: !!cursor,
    pluginsNamespace: !!cursor?.plugins,
    registerPath: present ? "present" : "missing",
    conclusion: present
      ? "vscode.cursor.plugins.registerPath() is present, but Skills Hub does not call it. Components are installed into directories Cursor already scans."
      : "vscode.cursor.plugins.registerPath() is not available in this Cursor build. Skills Hub installs into directories Cursor already scans: .cursor/skills, .agents/skills, and .cursor/plugins/local.",
  };
}
