import type { ApiConfig } from "./shared";

export const API_CONFIG: ApiConfig = {
  name: "cron-parser",
  slug: "cron-parser",
  description: "Parse, validate, and explain cron expressions. Get next N run times in any timezone.",
  version: "1.0.0",
  routes: [
    {
      method: "POST",
      path: "/api/parse",
      price: "$0.001",
      description: "Parse a cron expression and get next run times",
      toolName: "schedule_parse_cron",
      toolDescription: "Use this when you need to parse, validate, or explain a cron expression. Returns human-readable description, next N execution times in any timezone, and field breakdown. Supports standard 5-field cron and extended 6-field (with seconds). Do NOT use for scheduling tasks — use calendar_schedule_event instead. Do NOT use for JSON validation — use data_validate_json instead.",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Cron expression (e.g. '0 9 * * 1-5' or '*/5 * * * *')" },
          timezone: { type: "string", description: "IANA timezone (default: UTC, e.g. America/New_York)" },
          count: { type: "number", description: "Number of next run times to return (default: 5, max: 20)" },
        },
        required: ["expression"],
      },
    },
  ],
};
