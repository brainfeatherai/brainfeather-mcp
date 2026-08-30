import { createServer, type IncomingHttpHeaders } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "./config.js";
import { createBrainfeatherServer } from "./index.js";

const CORS = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-Id, x-brainfeather-project",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function loopbackHost(value: string): boolean {
  if (value === "::1" || value === "[::1]") return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

function allowedOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    return (origin.protocol === "http:" || origin.protocol === "https:") &&
      LOOPBACK_HOSTS.has(origin.hostname)
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

function responseHeaders(request: Request): HeadersInit {
  const origin = allowedOrigin(request.headers.get("origin"));
  return { ...CORS, ...(origin ? { "Access-Control-Allow-Origin": origin } : {}) };
}

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
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!loopbackHost(host)) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32_000, message: "Invalid Host header." }, id: null },
      { status: 403 },
    );
  }
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigin(origin)) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32_000, message: "Invalid Origin header." }, id: null },
      { status: 403 },
    );
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(request) });
  }

  const projectId =
    request.headers.get("x-brainfeather-project")?.trim() || config.projectId;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [host],
    ...(origin ? { allowedOrigins: [origin] } : {}),
  });
  const server = createBrainfeatherServer({ ...config, projectId });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(responseHeaders(request))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export function listenHttp(config: Config, host: string, port: number): Promise<void> {
  if (!loopbackHost(host)) {
    return Promise.reject(
      new Error(
        "Local HTTP MCP may only bind to localhost. Use https://brainfeather.com/mcp for remote access.",
      ),
    );
  }
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
    const bindHost = host === "[::1]" ? "::1" : host;
    httpServer.listen(port, bindHost, () => {
      const displayHost = bindHost === "::1" ? "[::1]" : bindHost;
      console.error(`[brainfeather] Streamable HTTP MCP on http://${displayHost}:${port}/mcp`);
      resolve();
    });
  });
}
