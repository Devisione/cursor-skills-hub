import { readFileSync } from "fs";
import { request } from "http";
import { ROUTING_INSTRUCTIONS, SEARCH_SKILLS_DESCRIPTION } from "../routing/instruction";

interface BridgeFile {
  port: number;
  token: string;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
  };
}

const instructions = ROUTING_INSTRUCTIONS;

const tools = [
  {
    name: "search_skills",
    description: SEARCH_SKILLS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's task, in a few words." },
        category: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_skill_info",
    description: "Get metadata for one skill from a connected marketplace.",
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "string" } },
      required: ["skill_id"],
    },
  },
  {
    name: "install_skill",
    description: "Install one skill returned by search_skills into a directory Cursor scans. Refuses an id that is not in a connected marketplace. After it returns, read SKILL.md inside installPath and follow it.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
        version: { type: "string" },
        installation_scope: { type: "string", enum: ["user", "project"] },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "list_installed_skills",
    description: "List skills currently installed on this device, including the directory of each skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_skill_updates",
    description: "Check installed skills for updates.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Frame = "line" | "lsp";

const pending = { current: Buffer.alloc(0) };
let frame: Frame | undefined;

if (require.main === module) {
  process.stdin.on("data", (chunk: Buffer) => {
    pending.current = Buffer.concat([pending.current, chunk]);
    drain();
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
}

function drain(): void {
  while (pending.current.length) {
    if (!frame) {
      const detected = detectFrame(pending.current);
      if (!detected) {
        return;
      }
      frame = detected;
      const skip = leadingWhitespace(pending.current);
      if (skip) {
        pending.current = pending.current.slice(skip);
      }
    }
    if (frame === "line") {
      const newline = pending.current.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = pending.current.slice(0, newline).toString("utf8").replace(/\r$/, "");
      pending.current = pending.current.slice(newline + 1);
      if (line.trim()) {
        void handle(line);
      }
      continue;
    }
    const body = readContentLength();
    if (body === undefined) {
      return;
    }
    if (body) {
      void handle(body);
    }
  }
}

function detectFrame(buffer: Buffer): Frame | undefined {
  const start = leadingWhitespace(buffer);
  if (start >= buffer.length) {
    return undefined;
  }
  return buffer[start] === 0x7b ? "line" : "lsp";
}

function leadingWhitespace(buffer: Buffer): number {
  let index = 0;
  while (index < buffer.length && (buffer[index] === 0x20 || buffer[index] === 0x09 || buffer[index] === 0x0d || buffer[index] === 0x0a)) {
    index += 1;
  }
  return index;
}

function readContentLength(): string | undefined {
  const headerEnd = pending.current.indexOf("\r\n\r\n");
  const newlineEnd = pending.current.indexOf("\n\n");
  const splitAt = headerEnd >= 0 ? headerEnd : newlineEnd;
  const separator = headerEnd >= 0 ? 4 : 2;
  if (splitAt < 0) {
    return undefined;
  }
  const header = pending.current.slice(0, splitAt).toString("utf8");
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) {
    pending.current = pending.current.slice(splitAt + separator);
    return "";
  }
  const length = Number(match[1]);
  const start = splitAt + separator;
  if (pending.current.length < start + length) {
    return undefined;
  }
  const body = pending.current.slice(start, start + length).toString("utf8");
  pending.current = pending.current.slice(start + length);
  return body;
}

async function handle(body: string): Promise<void> {
  let message: RpcMessage;
  try {
    message = JSON.parse(body) as RpcMessage;
  } catch {
    return;
  }
  if (!message.method || message.id === undefined) {
    return;
  }
  try {
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      reply(message.id, {
        protocolVersion: typeof requested === "string" && requested ? requested : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "skills-hub", version: "0.1.0" },
        instructions,
      });
      return;
    }
    if (message.method === "tools/list") {
      reply(message.id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name ?? "";
      const args = message.params?.arguments ?? {};
      const result = await callBridge(name, args);
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
      return;
    }
    if (message.method === "ping") {
      reply(message.id, {});
      return;
    }
    replyError(message.id, -32601, `Unknown method ${message.method}`);
  } catch (error) {
    reply(message.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

function callBridge(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bridgePath = process.env.SKILLS_HUB_BRIDGE;
  if (!bridgePath) {
    return Promise.reject(new Error("Skills Hub bridge is not configured."));
  }
  const bridge = JSON.parse(readFileSync(bridgePath, "utf8")) as BridgeFile;
  const payload = JSON.stringify({ name, arguments: args });
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: bridge.port,
      path: "/v1/call",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${bridge.token}`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; result?: unknown; error?: string };
        if (!parsed.ok) {
          reject(new Error(parsed.error || "Skills Hub request failed."));
          return;
        }
        resolve(parsed.result);
      });
    });
    req.on("error", reject);
    req.setTimeout(110_000, () => {
      req.destroy(new Error("Skills Hub took too long to respond."));
    });
    req.end(payload);
  });
}

function reply(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message: unknown): void {
  const json = JSON.stringify(message);
  if (frame === "lsp") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    return;
  }
  process.stdout.write(`${json}\n`);
}
