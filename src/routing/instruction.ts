export const ROUTING_PLUGIN_NAME = "skills-hub-routing";

export const ROUTING_INSTRUCTIONS = [
  "On every user message that asks for work, including a follow-up in the same chat, do this before any other tool or answer.",
  "Skip it only when the message is just an acknowledgement, or a clarification of a skill you already loaded for this same request.",
  "The user does not have to mention a skill, a plugin, or a marketplace.",
  "Compare the latest message with the skill descriptions already in the prompt, and with any installed skills, plugin commands, and plugin agents listed after this instruction.",
  "Call search_skills with a short description of that latest message.",
  "Search only marketplaces already connected in Skills Hub.",
  "The search returns every matching skill and a hit score. It does not cut the list. The score only counts shared words.",
  "Decide which returned skills this task needs. Drop a skill when the score comes from an unrelated meaning, such as a shader or Swift skill matching the words write or text.",
  "When more than one skill fits, read each matching SKILL.md and follow all of them before doing the task.",
  "For each skill that fits, install it when installed is false, then read its SKILL.md and follow it.",
  "If nothing fits, do the task and do not install a skill.",
  "An earlier search does not cover a later message.",
].join(" ");

export const SEARCH_SKILLS_DESCRIPTION = "Search skills in marketplaces connected to Cursor Skills Hub. Call this on every user message that asks for work, including follow-ups, before other work. The user does not need to ask for a skill. This does not install anything. Every match is returned with a hit score, and the list is not cut. The score counts shared words and does not decide which skill is needed. Keep only the skills this task needs, and drop a match that comes from an unrelated use of the same word. Each result says whether that skill is already installed and, when it is, includes installPath.";

export interface RoutedItem {
  kind: "skill" | "command" | "agent";
  name: string;
  description: string;
  file: string;
  scope: "user" | "project";
}

export function isRoutingPlugin(installPath: string): boolean {
  const parts = installPath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]?.toLowerCase() === ROUTING_PLUGIN_NAME;
}

export function routingRule(): string {
  return `---
description: Follow installed skills and plugin flows on every user message
alwaysApply: true
---

${ROUTING_INSTRUCTIONS}
`;
}

export function renderSessionContext(items: RoutedItem[]): string {
  const parts = [ROUTING_INSTRUCTIONS];
  let used = 0;
  for (const group of groups(items)) {
    const room = 40 - used;
    if (room <= 0) {
      break;
    }
    const shown = group.items.slice(0, room);
    used += shown.length;
    const lines = shown.map((item) => `- ${item.name}: ${oneLine(item.description)} File: ${item.file}`);
    const hidden = group.items.length - shown.length;
    parts.push(`\n${group.title}:\n${lines.join("\n")}${hidden > 0 ? `\n${hidden} more are already listed in the chat.` : ""}`);
  }
  return parts.join("\n");
}

export function mergeRoutingHooks(current: unknown, command: string): Record<string, unknown> {
  const source = current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  const existing = source.hooks && typeof source.hooks === "object" ? source.hooks as Record<string, unknown> : {};
  for (const [event, value] of Object.entries(existing)) {
    hooks[event] = Array.isArray(value) ? value.filter(isRecord) : [];
  }
  const session = hooks.sessionStart ?? [];
  hooks.sessionStart = [...session.filter((item) => !isRoutingCommand(item)), { command, timeout: 20 }];
  return {
    ...source,
    version: typeof source.version === "number" ? source.version : 1,
    hooks,
  };
}

export function isRoutingCommand(item: Record<string, unknown>): boolean {
  return typeof item.command === "string" && item.command.includes("skills-hub-route");
}

function groups(items: RoutedItem[]): Array<{ title: string; items: RoutedItem[] }> {
  const order = [
    ["Installed skills", "skill"],
    ["Plugin commands", "command"],
    ["Plugin agents", "agent"],
  ] as const;
  return order.map(([title, kind]) => ({
    title,
    items: items.filter((item) => item.kind === kind).sort(byScopeThenName),
  })).filter((group) => group.items.length > 0);
}

function byScopeThenName(left: RoutedItem, right: RoutedItem): number {
  if (left.scope !== right.scope) {
    return left.scope === "project" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    return "Follow this file.";
  }
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
