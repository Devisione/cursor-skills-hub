import { readFileSync } from "fs";
import { request } from "http";

interface BridgeFile {
  port: number;
  token: string;
}

const tools = [
  {
    name: "search_skills",
    description: "Search skills in marketplaces connected to Cursor Skills Hub. This does not install anything.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task or skill description to search for." },
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
    description: "Install one skill from a connected marketplace into a directory Cursor scans. Refuses arbitrary repositories.",
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
    description: "List skills currently installed on this device.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_skill_updates",
    description: "Check installed skills for updates.",
    inputSchema: { type: "object", properties: {} },
  },
];

const pending = { current: Buffer.alloc(0) };

process.stdin.on("data", (chunk: Buffer) => {
  pending.current = Buffer.concat([pending.current, chunk]);
  while (true) {
    const headerEnd = pending.current.indexOf("\r\n\r\n");
    const newlineEnd = pending.current.indexOf("\n\n");
    const splitAt = headerEnd >= 0 ? headerEnd : newlineEnd;
    const separator = headerEnd >= 0 ? 4 : 2;
    if (splitAt < 0) {
      return;
    }
    const header = pending.current.slice(0, splitAt).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      pending.current = pending.current.slice(splitAt + separator);
      continue;
    }
    const length = Number(match[1]);
    const start = splitAt + separator;
    if (pending.current.length < start + length) {
      return;
    }
    const body = pending.current.slice(start, start + length).toString("utf8");
    pending.current = pending.current.slice(start + length);
    void handle(body);
  }
});

async function handle(body: string): Promise<void> {
  let message: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    message = JSON.parse(body) as typeof message;
  } catch {
    return;
  }
  if (!message.method || message.id === undefined) {
    return;
  }
  try {
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "skills-hub", version: "0.1.0" },
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
  const packet = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
  process.stdout.write(packet);
}
