import { randomBytes } from "crypto";
import { createServer, Server } from "http";
import { writeJsonAtomic } from "../utils/filesystem";
import { Logger } from "../utils/logger";

export interface Bridge {
  dispose(): void;
}

export async function startBridge(
  bridgeFile: string,
  logger: Logger,
  handle: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Bridge> {
  const token = randomBytes(24).toString("hex");
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/call") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        response.writeHead(413);
        response.end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: string; arguments?: Record<string, unknown> };
          const result = await handle(body.name ?? "", body.arguments ?? {});
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("mcp", message);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: message }));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await writeJsonAtomic(bridgeFile, { port, token });
  logger.info("mcp", `Skills Hub tools are listening on 127.0.0.1:${port}.`);
  return {
    dispose() {
      server.close();
    },
  };
}
