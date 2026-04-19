import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthResponse, buildPaymentConfig, setupMcp } from "./shared";
import { API_CONFIG } from "./config";
import { registerRoutes } from "./logic";

const app = new Hono();
app.use("*", cors());
app.use("*", logger());

app.get("/", (c) => c.json(healthResponse(API_CONFIG.name)));
app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));
setupMcp(app, API_CONFIG);

// ATXP/RFC 9728 — serve PRM on all resource-specific path variants the SDK probes.
// The SDK uses oauth4webapi which strictly validates `resource` matches the
// protected-resource URL the PRM path is about:
//  - /.well-known/oauth-protected-resource           → resource: {origin}
//  - /.well-known/oauth-protected-resource/{path}    → resource: {origin}/{path}   (RFC 9728 suffix)
//  - /{path}/.well-known/oauth-protected-resource    → resource: {origin}/{path}   (legacy)
app.use("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const url = new URL(c.req.url);
  const p = url.pathname;
  const WK = "/.well-known/oauth-protected-resource";
  let resourcePath: string | null = null;
  if (p === WK) {
    resourcePath = "";
  } else if (p.startsWith(WK + "/")) {
    resourcePath = p.slice(WK.length); // e.g. "/api/verify"
  } else if (p.endsWith(WK)) {
    resourcePath = p.slice(0, -WK.length); // e.g. "/api/verify"
  } else {
    return next();
  }
  // Railway terminates TLS upstream — request proto is http, but clients use https.
  const proto = c.req.header("x-forwarded-proto") || url.protocol.replace(":", "") || "https";
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || url.host;
  const resource = `${proto}://${host}${resourcePath || ""}`;
  return c.json({
    resource,
    resource_name: API_CONFIG.name,
    authorization_servers: ["https://auth.atxp.ai"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "write"],
  });
});


async function setupPayments() {
  try {
    const { paymentMiddleware, x402ResourceServer } = await import("@x402/hono");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    const { createFacilitatorConfig } = await import("@coinbase/x402");

    // Coinbase CDP facilitator (83% of x402 market) with PayAI fallback
    const cdpConfig = createFacilitatorConfig(
      process.env.CDP_API_KEY_ID || "21c4c238-79d7-48bd-a6a5-7f5899ee9864",
      process.env.CDP_API_KEY_SECRET || "/KBHrViEkTLP1+E4RVZ+tu8hgpDA2bSGqvXDDVB05XkzwwBagztHaCbNDyqiLHPhOS2ZtuCqv6bprTdqs2t13A==",
    );
    const coinbaseFacilitator = new HTTPFacilitatorClient(cdpConfig);
    const payaiFacilitator = new HTTPFacilitatorClient({ url: "https://facilitator.payai.network" });

    const resourceServer = new x402ResourceServer(coinbaseFacilitator, payaiFacilitator)
      .register("eip155:8453", new ExactEvmScheme());
    app.use("/api/*", paymentMiddleware(
      buildPaymentConfig(API_CONFIG.routes, undefined, "eip155:8453"),
      resourceServer
    ));
    console.log("[x402] BASE MAINNET — " + API_CONFIG.routes.length + " routes");
  } catch (e: any) {
    console.warn("[x402] FREE mode:", e.message);
  }
}


async function setupAtxp() {
  const conn = process.env.ATXP_CONNECTION;
  if (!conn) {
    console.warn("[atxp] ATXP_CONNECTION not set — ATXP payments disabled. Set at accounts.atxp.ai");
    return;
  }
  try {
    const { atxpHono, ATXPAccount } = await import("./atxp-middleware");
    // Build method+path → price lookup so the middleware can emit the
    // 402 omni-challenge (body JSON format required by ATXPAccountHandler)
    // when an authenticated ATXP client calls a protected route without payment.
    const priceMap = new Map<string, number>();
    for (const r of API_CONFIG.routes) {
      const priceNum = parseFloat((r.price || "0").replace("$", ""));
      priceMap.set(`${r.method} ${r.path}`, priceNum);
    }
    app.use("*", atxpHono({
      destination: new ATXPAccount(conn),
      payeeName: API_CONFIG.name,
      priceForRequest: (method, path) => priceMap.get(`${method} ${path}`) ?? null,
    }));
    console.log(`[atxp] Enabled — ${priceMap.size} gated routes, omni-challenge active`);
  } catch (e: any) {
    console.warn("[atxp] Failed to init:", e.message);
  }
}

// ORDER MATTERS: ATXP middleware MUST be registered BEFORE x402 so it can
// intercept ATXP/MPP/OAuth requests first. For non-ATXP requests it falls through.
await setupAtxp();

await setupPayments();

registerRoutes(app);

Bun.serve({ fetch: app.fetch, port: parseInt(process.env.PORT || "3000", 10) });
console.log("[server] Listening on port " + (process.env.PORT || "3000"));
