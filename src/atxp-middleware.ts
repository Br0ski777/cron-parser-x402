import type { Context, MiddlewareHandler } from "hono";
import {
  buildServerConfig,
  getResource,
  getProtectedResourceMetadata,
  sendProtectedResourceMetadataWebApi,
  getOAuthMetadata,
  sendOAuthMetadataWebApi,
  parseMcpRequestsWebApi,
  detectProtocol,
  checkTokenWebApi,
  parseCredentialBase64,
  sendOAuthChallengeWebApi,
  withATXPContext,
  ProtocolSettlement,
  requirePayment,
  omniChallengeHttpResponse,
  type ATXPArgs,
} from "@atxp/server";
import BigNumber from "bignumber.js";

export { requirePayment, ATXPAccount } from "@atxp/server";
export type { ATXPArgs } from "@atxp/server";

export interface AtxpHonoArgs extends ATXPArgs {
  /**
   * Lookup price (USDC) for a given request. Returning a number triggers
   * requirePayment() inside the ATXP context, which on no-payment throws
   * McpError(-30402). That error is caught and converted to a 402
   * omni-challenge HTTP response (body + headers) that ATXPAccountHandler
   * can parse. Returning null/undefined skips the gate — the route handler
   * runs and downstream middleware (e.g. @x402/hono) may gate instead.
   */
  priceForRequest?: (method: string, path: string) => number | null | undefined;
}

/**
 * Hono middleware for ATXP payment protocol.
 *
 * Mount BEFORE route handlers. Accepts ATXP OAuth bearer, MPP, and x402 credentials.
 * Runs in parallel with existing @x402/hono middleware — x402-only traffic passes through
 * untouched if no ATXP/MPP header is present and Authorization bearer is absent.
 *
 * Requires env var ATXP_CONNECTION (set via accounts.atxp.ai).
 *
 * Usage:
 *   import { atxpHono, ATXPAccount, requirePayment } from "@api-factory/atxp-hono";
 *
 *   app.use("/api/*", atxpHono({
 *     destination: new ATXPAccount(process.env.ATXP_CONNECTION!),
 *     payeeName: "email-verification",
 *   }));
 *
 *   // In route handler:
 *   //   await requirePayment({ price: BigNumber(0.002) });
 *   //   return c.json(result);
 */
export function atxpHono(args: AtxpHonoArgs): MiddlewareHandler {
  const config = buildServerConfig(args);
  const logger = config.logger;
  const priceLookup = args.priceForRequest;

  return async (c: Context, next) => {
    try {
      const request = c.req.raw;
      const requestUrl = new URL(c.req.url);

      // 1. OAuth metadata endpoints (RFC 8414, RFC 9728) — ATXP clients probe these.
      const resource = getResource(config, requestUrl, Object.fromEntries(request.headers));
      const prmResponse = getProtectedResourceMetadata(
        config,
        requestUrl,
        Object.fromEntries(request.headers),
      );
      const prmOut = sendProtectedResourceMetadataWebApi(prmResponse);
      if (prmOut) {
        return prmOut;
      }

      const oAuthMetadata = await getOAuthMetadata(config, requestUrl);
      const oMetaOut = sendOAuthMetadataWebApi(oAuthMetadata);
      if (oMetaOut) {
        return oMetaOut;
      }

      // 2. Detect payment credentials from request headers.
      const hdr = (name: string) => request.headers.get(name) ?? undefined;
      const detected = detectProtocol({
        "x-atxp-payment": hdr("x-atxp-payment"),
        "payment-signature": hdr("payment-signature"),
        "x-payment": hdr("x-payment"),
        authorization: hdr("authorization"),
      });

      // 3. If no credential and no Authorization bearer: let the request through
      // so the existing x402 middleware (or public routes) can respond.
      // Only ATXP-aware clients send the relevant headers.
      if (!detected && !hdr("authorization")) {
        return next();
      }

      // 3b. Pure x402 v2 credentials (payment-signature / x-payment) — let
      // @x402/hono verify & settle. Our ATXPSettlement chokes on them.
      // Only ATXP-aware clients (bearer or x-atxp-payment) should go through
      // the ATXP settlement path below.
      if (
        detected &&
        detected.protocol === "x402" &&
        !hdr("x-atxp-payment") &&
        !hdr("authorization")
      ) {
        return next();
      }

      // 4. Parse MCP requests if this is an MCP POST (JSON-RPC).
      const mcpRequests = await parseMcpRequestsWebApi(config, request).catch(() => [] as any[]);

      // 5. Verify OAuth token (if bearer present) or identity via opaque (MPP).
      let tokenCheck = await checkTokenWebApi(config, resource, request);
      let user = tokenCheck.data?.sub ?? null;

      if (detected && detected.protocol === "mpp" && !tokenCheck.passes) {
        const parsed = parseCredentialBase64(detected.credential);
        const challenge = parsed?.challenge;
        if (challenge?.opaque && challenge?.id) {
          const { verifyOpaqueIdentity } = await import("@atxp/server");
          const recoveredSub = verifyOpaqueIdentity(challenge.opaque, challenge.id);
          if (recoveredSub) {
            user = recoveredSub;
            tokenCheck = { passes: true, data: { sub: recoveredSub }, token: null } as any;
          }
        }
      }

      // 6. If no valid creds and request expects OAuth (ATXP/MPP retry), send challenge.
      const shouldChallenge = !detected || (detected.protocol === "mpp" && !user);
      if (shouldChallenge) {
        const chal = sendOAuthChallengeWebApi(tokenCheck);
        if (chal) return chal;
      }

      // 7. Settle credential immediately (credits ATXP ledger before route runs).
      if (detected) {
        const destinationAccountId = await config.destination.getAccountId();
        const sourceAccountId = user ?? undefined;
        const context: any = { destinationAccountId };
        if (sourceAccountId) context.sourceAccountId = sourceAccountId;

        if (detected.protocol === "x402") {
          const parsed = parseCredentialBase64(detected.credential);
          if (parsed?.accepted) context.paymentRequirements = parsed.accepted;
        }

        const settlement = new ProtocolSettlement(
          config.server,
          logger,
          fetch.bind(globalThis),
          destinationAccountId,
        );

        try {
          const result = await settlement.settle(detected.protocol, detected.credential, context);
          logger.info(
            `[atxp-hono] Settled ${detected.protocol}: txHash=${result.txHash} amount=${result.settledAmount}`,
          );
        } catch (error) {
          logger.error(
            `[atxp-hono] Settlement failed for ${detected.protocol}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // 8. Run handler inside ATXP context so requirePayment() works.
      //    If a priceLookup is provided, call requirePayment BEFORE the handler
      //    so the 402 omni-challenge is always emitted in the format
      //    ATXPAccountHandler expects (body JSON with chargeAmount + x402 + mpp).
      return await withATXPContext(config, resource, tokenCheck, async () => {
        const requestUrl2 = new URL(c.req.url);
        const pathname = requestUrl2.pathname;
        try {
          const price = priceLookup?.(c.req.method, pathname);
          if (price !== undefined && price !== null && price > 0) {
            await requirePayment({ price: BigNumber(price) });
          }
          await next();
          return c.res;
        } catch (error: any) {
          if (error?.code === -30402 && error?.data) {
            const d = error.data;
            if (d.paymentRequestId && d.x402) {
              const chargeAmount = d.chargeAmount ? BigNumber(d.chargeAmount) : undefined;
              const http = omniChallengeHttpResponse(
                config.server,
                d.paymentRequestId,
                chargeAmount,
                d.x402,
                d.mpp,
              );
              // Augment body with flat {amount, chargeAmount, x402, mpp} so
              // ATXPAccountHandler@0.11.8 (which looks for top-level `amount`)
              // can parse. Preserve existing keys (x402Version, accepts) for
              // pure-x402 clients. Bug #2 documented in project_atxp_integration.md.
              let body: string = typeof http.body === "string" ? http.body : "";
              try {
                const orig = body ? JSON.parse(body) : {};
                const firstAccept = Array.isArray(orig.accepts) ? orig.accepts[0] : null;
                const amount = chargeAmount
                  ? chargeAmount.toString()
                  : firstAccept?.amount
                  ? String(firstAccept.amount)
                  : undefined;
                const patched = {
                  ...orig,
                  ...(amount !== undefined ? { amount, chargeAmount: amount } : {}),
                  paymentRequestId: d.paymentRequestId,
                  x402: d.x402,
                  ...(d.mpp ? { mpp: d.mpp } : {}),
                };
                body = JSON.stringify(patched);
              } catch {
                // If the omni body isn't JSON, leave as-is.
              }
              return new Response(body, {
                status: http.status,
                headers: http.headers,
              });
            }
          }
          throw error;
        }
      });
    } catch (error) {
      logger.error(
        `[atxp-hono] Critical error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return c.json(
        { error: "server_error", error_description: "Internal ATXP middleware error" },
        500,
      );
    }
  };
}
