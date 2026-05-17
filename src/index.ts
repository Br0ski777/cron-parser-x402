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


async function setupPayments() {
  try {
    const { paymentMiddleware, x402ResourceServer } = await import("@x402/hono");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    const facilitatorClient = new HTTPFacilitatorClient({
      url: "https://facilitator.payai.network"
    });
    const resourceServer = new x402ResourceServer(facilitatorClient)
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

await setupPayments();

registerRoutes(app);

Bun.serve({ fetch: app.fetch, port: parseInt(process.env.PORT || "3000", 10) });
console.log("[server] Listening on port " + (process.env.PORT || "3000"));
