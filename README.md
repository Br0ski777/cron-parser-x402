# Cron Parser API

[![MCP Server](https://img.shields.io/badge/MCP-server-blue)](https://cron-parser.api.klymax402.com/mcp)
[![x402](https://img.shields.io/badge/payments-x402-6E56CF)](https://x402.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Parse, validate, and explain cron expressions. Get next N run times in any timezone. Pay-per-call via [x402](https://x402.org) (USDC on Base L2) -- no API key, no signup, no rate-limit wall.

Part of the [klymax402](https://klymax402.com) marketplace -- 100 x402 micropayment APIs for AI agents, one wallet, USDC on Base.

## Quickstart -- MCP

Add to your MCP client config (Claude Desktop, Cursor, ElizaOS, etc.):

```json
{
  "mcpServers": {
    "cron-parser": {
      "url": "https://cron-parser.api.klymax402.com/mcp"
    }
  }
}
```

## Quickstart -- HTTP (x402)

```bash
curl -X POST "https://cron-parser.api.klymax402.com/api/parse" \
  -H "Content-Type: application/json" \
  -d '{"expression":"..."}'
# -> 402 Payment Required, with an x402 payment challenge in the response body
```

Any x402-aware client ([`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch), [`x402-agent-tools`](https://www.npmjs.com/package/x402-agent-tools), ATXP) handles the 402 -> sign -> retry cycle automatically.

## Tools

| Tool | Method | Path | Price | Description |
|---|---|---|---|---|
| `schedule_parse_cron` | POST | `/api/parse` | $0.001 | Parse a cron expression and get next run times |

### `schedule_parse_cron`

Use this when you need to parse, validate, or explain a cron expression. Returns human-readable description, next N execution times, and field breakdown. Supports standard 5-field cron and extended 6-field (with seconds). Do NOT use for scheduling tasks — use api_test_webhook instead. Do NOT use for JSON validation — use data_validate_json instead.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `expression` | string | yes | Cron expression (e.g. '0 9 * * 1-5' or '*/5 * * * *') |
| `timezone` | string | no | IANA timezone (default: UTC, e.g. America/New_York) |
| `count` | number | no | Number of next run times to return (default: 5, max: 20) |

## Example agent prompts

- "Parse, validate, or explain a cron expression"

## Payment

- Protocol: [x402](https://x402.org) -- HTTP-native pay-per-call, no signup, no API key
- Network: Base L2 (`eip155:8453`)
- Asset: USDC
- Facilitator: Coinbase CDP (primary), PayAI (fallback)

## Part of klymax402

100 x402 micropayment APIs for AI agents -- one wallet, USDC on Base, zero signup.

- Catalog: https://klymax402.com/llms.txt
- Full API reference: https://klymax402.com/llms-full.txt
- Live stats: https://klymax402.com/stats

## License

MIT
