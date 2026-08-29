import { createServer, type IncomingHttpHeaders } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "./config.js";
import { createBrainfeatherServer } from "./index.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-Id, x-brainfeather-project",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function webHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

export async function handleStreamableRequest(
  request: Request,
  config: Config,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const projectId =
    request.headers.get("x-brainfeather-project")?.trim() || config.projectId;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
  });
  const server = createBrainfeatherServer({ ...config, projectId });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export function listenHttp(config: Config, host: string, port: number): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const request = new Request(url, {
        method: req.method,
        headers: webHeaders(req.headers),
        ...(req.method === "GET" || req.method === "HEAD" || body.length === 0
          ? {}
          : { body, duplex: "half" as const }),
      });
      const response = await handleStreamableRequest(request, config);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
          id: null,
        }),
      );
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      console.error(`[brainfeather] Streamable HTTP MCP on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}
