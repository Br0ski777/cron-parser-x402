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
