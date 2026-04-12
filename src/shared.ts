export const WALLET_ADDRESS = "0x6E8B64638b24C6D625b045dD353120d850064E2E";
export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
export const DEFAULT_NETWORK = BASE_MAINNET;

export interface RouteConfig {
  method: "GET" | "POST";
  path: string;
  price: string;
  description: string;
  mimeType?: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
}

export interface ApiConfig {
  name: string;
  slug: string;
  description: string;
  version: string;
  routes: RouteConfig[];
}

export function buildPaymentConfig(routes: RouteConfig[], payTo = WALLET_ADDRESS, network = DEFAULT_NETWORK) {
  const config: Record<string, unknown> = {};
  for (const route of routes) {
    config[`${route.method} ${route.path}`] = {
      accepts: [{ scheme: "exact", price: route.price, network, payTo }],
      description: route.description,
      mimeType: route.mimeType ?? "application/json",
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "mcp",
              toolName: route.toolName,
              description: route.toolDescription,
              inputSchema: route.inputSchema,
            },
            output: {
              type: "json",
            },
          },
        },
      },
    };
  }
  return config;
}

export function buildMcpTools(routes: RouteConfig[]) {
  return routes.map((r) => ({
    name: r.toolName,
    description: r.toolDescription,
    inputSchema: r.inputSchema,
    _route: { method: r.method, path: r.path },
  }));
}

export function healthResponse(apiName: string) {
  return { api: apiName, status: "online", protocol: "x402", network: "base-mainnet", timestamp: new Date().toISOString() };
}

/**
 * MCP SSE Transport — adds /sse and /message endpoints to the Hono app.
 * Implements JSON-RPC 2.0 over SSE for MCP protocol compatibility.
 * This enables Claude Desktop, Cursor, Copilot, and Smithery to connect.
 */
export function setupMcp(app: any, config: ApiConfig) {
  const tools = buildMcpTools(config.routes);
  const sessions = new Map<string, { controller: ReadableStreamDefaultController; createdAt: number }>();

  // Cleanup stale sessions every 5 min
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > 600_000) sessions.delete(id);
    }
  }, 300_000);

  // SSE endpoint — client connects here, receives an endpoint URL to POST messages to
  app.get("/sse", (c: any) => {
    const sessionId = crypto.randomUUID();
    const stream = new ReadableStream({
      start(controller) {
        sessions.set(sessionId, { controller, createdAt: Date.now() });
        const origin = new URL(c.req.url).origin;
        controller.enqueue(`event: endpoint\ndata: ${origin}/message?sessionId=${sessionId}\n\n`);
      },
      cancel() {
        sessions.delete(sessionId);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // Message endpoint — handles JSON-RPC, responds directly as HTTP JSON
  // Also accepts requests without sessionId for stateless MCP clients
  app.post("/message", async (c: any) => {
    const sessionId = c.req.query("sessionId");
    const session = sessionId ? sessions.get(sessionId) : null;
    const req = await c.req.json();
    let result: any;

    switch (req.method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: config.name, version: config.version },
        };
        break;

      case "notifications/initialized":
        return c.json({});

      case "tools/list":
        result = {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
        break;

      case "tools/call": {
        const toolName = req.params?.name;
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
          result = { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
          break;
        }
        const route = tool._route;
        const port = process.env.PORT || "3000";
        const args = req.params?.arguments || {};
        try {
          let resp: Response;
          if (route.method === "GET") {
            const qs = new URLSearchParams(args as Record<string, string>).toString();
            resp = await fetch(`http://localhost:${port}${route.path}${qs ? "?" + qs : ""}`);
          } else {
            resp = await fetch(`http://localhost:${port}${route.path}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(args),
            });
          }
          if (resp.status === 402) {
            result = { content: [{ type: "text", text: "Payment required (x402). This tool requires USDC payment on Base." }], isError: true };
          } else {
            const data = await resp.text();
            result = { content: [{ type: "text", text: data }] };
          }
        } catch (e: any) {
          result = { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
        break;
      }

      case "ping":
        result = {};
        break;

      default:
        result = undefined;
    }

    const response = { jsonrpc: "2.0", result, id: req.id };

    // Send via SSE if session alive
    if (session?.controller) {
      try {
        session.controller.enqueue(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      } catch {}
    }

    // ALSO return as direct HTTP response (Smithery uses this)
    return c.json(response);
  });

  console.log(`[mcp] SSE transport ready — ${tools.length} tools`);
}
