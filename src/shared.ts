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

/**
 * Middleware that enriches 402 responses with inputSchema in the resource object.
 * x402scan requires resource.inputSchema for "invocable" endpoint registration.
 * The x402 SDK doesn't include it by default, so we patch it post-hoc.
 */
export function x402scanEnrichMiddleware(routes: RouteConfig[]) {
  // Build a lookup: "METHOD /path" -> inputSchema
  const schemaMap = new Map<string, Record<string, unknown>>();
  for (const route of routes) {
    schemaMap.set(`${route.method} ${route.path}`, route.inputSchema);
  }

  return async (c: any, next: any) => {
    await next();
    if (c.res && c.res.status === 402) {
      // Try both cases for the header name
      const paymentHeader = c.res.headers.get("payment-required") || c.res.headers.get("PAYMENT-REQUIRED");
      if (paymentHeader) {
        try {
          const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
          const reqPath = new URL(c.req.url).pathname;
          const reqMethod = c.req.method;
          const key = `${reqMethod} ${reqPath}`;
          const schema = schemaMap.get(key);
          if (schema && decoded.resource) {
            decoded.resource.inputSchema = schema;
            const enriched = Buffer.from(JSON.stringify(decoded)).toString("base64");
            // Clone response with new header (Hono requires c.res replacement)
            const clonedBody = await c.res.arrayBuffer();
            const newRes = new Response(clonedBody, {
              status: c.res.status,
              statusText: c.res.statusText,
            });
            // Copy all headers
            c.res.headers.forEach((v: string, k: string) => {
              newRes.headers.set(k, v);
            });
            // Override payment-required with enriched version
            newRes.headers.set("payment-required", enriched);
            c.res = undefined as any;  // Force Hono to accept the new response
            c.res = newRes;
          }
        } catch (e: any) {
          console.error("[x402scan-enrich] Error:", e.message);
        }
      }
    }
  };
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
              type: "http",
              bodyType: "json",
              body: {},
            },
            output: {
              type: "json",
              example: {},
            },
          },
          schema: {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              input: {
                type: "object",
                properties: {
                  type: { type: "string", const: "http" },
                  bodyType: { type: "string", enum: ["json"] },
                  body: route.inputSchema,
                },
                required: ["body"],
              },
              output: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  example: { type: "object" },
                },
              },
            },
            required: ["input", "output"],
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
/**
 * x402 Discovery — adds /.well-known/x402 endpoint for x402scan registration.
 * Also adds /openapi.json for OpenAPI-based discovery.
 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="bg1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#0052FF"/><stop offset="100%" style="stop-color:#3B82F6"/></linearGradient></defs><rect width="400" height="400" rx="80" fill="url(#bg1)"/><text x="200" y="280" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="220" font-weight="900" fill="white" letter-spacing="-10">777</text></svg>`;

export function setupDiscovery(app: any, config: ApiConfig) {
  // Favicon for x402scan
  app.get("/favicon.svg", (c: any) => new Response(FAVICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));
  app.get("/favicon.ico", (c: any) => new Response(FAVICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));

  // Register enrichment middleware for 402 responses (adds inputSchema to resource object)
  app.use("/api/*", x402scanEnrichMiddleware(config.routes));

  // /.well-known/x402 discovery endpoint
  app.get("/.well-known/x402", (c: any) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      version: 1,
      resources: config.routes.map((r) => `${r.method} ${r.path}`),
    });
  });

  // OpenAPI spec with x-payment-info and input schemas
  app.get("/openapi.json", (c: any) => {
    const origin = new URL(c.req.url).origin;
    const paths: Record<string, any> = {};
    for (const route of config.routes) {
      const method = route.method.toLowerCase();
      const requestBody = method === "post" ? {
        required: true,
        content: {
          "application/json": {
            schema: route.inputSchema,
          },
        },
      } : undefined;
      const parameters = method === "get" ? Object.entries(
        (route.inputSchema as any)?.properties || {}
      ).map(([name, prop]: [string, any]) => ({
        name,
        in: "query",
        required: ((route.inputSchema as any)?.required || []).includes(name),
        schema: { type: prop.type, description: prop.description },
      })) : undefined;
      paths[route.path] = {
        [method]: {
          summary: route.description,
          description: route.toolDescription,
          operationId: route.toolName,
          ...(requestBody ? { requestBody } : {}),
          ...(parameters && parameters.length > 0 ? { parameters } : {}),
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: route.price.replace("$", ""),
            },
            protocols: [{ "x402": {} }],
          },
          responses: {
            "200": {
              description: "Successful response",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "402": { description: "Payment Required" },
          },
        },
      };
    }
    return c.json({
      openapi: "3.0.3",
      info: {
        title: config.name,
        description: config.description,
        version: config.version,
        "x-guidance": `${config.description}. Pay-per-call via x402 protocol (USDC on Base).`,
      },
      servers: [{ url: origin }],
      paths,
    });
  });

  console.log(`[discovery] /.well-known/x402 + /openapi.json ready — ${config.routes.length} resources`);
}

export function setupMcp(app: any, config: ApiConfig) {
  // Register discovery endpoints (/.well-known/x402 + /openapi.json) for x402scan
  setupDiscovery(app, config);

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
