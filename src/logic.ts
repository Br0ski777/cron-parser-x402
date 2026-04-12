import type { Hono } from "hono";

const FIELD_NAMES = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"];
const FIELD_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [start, end] = range.split("-").map(Number);
      for (let i = start; i <= end; i += step) values.add(i);
    } else {
      values.add(parseInt(range));
    }
  }

  return [...values].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
}

function describeCron(fields: string[]): string {
  const [min, hour, dom, month, dow] = fields;
  const parts: string[] = [];

  if (min === "*" && hour === "*") parts.push("Every minute");
  else if (min.startsWith("*/")) parts.push(`Every ${min.slice(2)} minutes`);
  else if (hour === "*") parts.push(`At minute ${min}`);
  else parts.push(`At ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`);

  if (dom !== "*") parts.push(`on day ${dom} of the month`);
  if (month !== "*") {
    const m = parseInt(month);
    parts.push(`in ${m > 0 && m <= 12 ? MONTH_NAMES[m] : month}`);
  }
  if (dow !== "*") {
    if (dow === "1-5") parts.push("on weekdays");
    else if (dow === "0,6") parts.push("on weekends");
    else {
      const days = dow.split(",").map((d) => DAY_NAMES[parseInt(d)] || d);
      parts.push(`on ${days.join(", ")}`);
    }
  }

  return parts.join(" ");
}

function getNextRuns(fields: string[], count: number, tz: string): string[] {
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const doms = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const dows = parseField(fields[4], 0, 6);

  const runs: string[] = [];
  const now = new Date();
  const check = new Date(now.getTime() + 60000); // start from next minute

  for (let i = 0; i < 525600 && runs.length < count; i++) {
    const d = new Date(check.getTime() + i * 60000);
    if (
      minutes.includes(d.getUTCMinutes()) &&
      hours.includes(d.getUTCHours()) &&
      (fields[2] === "*" || doms.includes(d.getUTCDate())) &&
      (fields[3] === "*" || months.includes(d.getUTCMonth() + 1)) &&
      (fields[4] === "*" || dows.includes(d.getUTCDay()))
    ) {
      runs.push(d.toISOString());
    }
  }

  return runs;
}

function validateCron(expression: string): { valid: boolean; error?: string; fields?: string[] } {
  const fields = expression.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    return { valid: false, error: `Expected 5 or 6 fields, got ${fields.length}` };
  }
  // If 6 fields, drop seconds (first field)
  const cron5 = fields.length === 6 ? fields.slice(1) : fields;

  for (let i = 0; i < 5; i++) {
    const field = cron5[i];
    const [min, max] = FIELD_RANGES[i];
    try {
      const values = parseField(field, min, max);
      if (values.length === 0) {
        return { valid: false, error: `Field '${FIELD_NAMES[i]}' (${field}) produces no valid values` };
      }
    } catch {
      return { valid: false, error: `Invalid field '${FIELD_NAMES[i]}': ${field}` };
    }
  }

  return { valid: true, fields: cron5 };
}

export function registerRoutes(app: Hono) {
  app.post("/api/parse", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.expression) {
      return c.json({ error: "Missing required field: expression" }, 400);
    }

    const { valid, error, fields } = validateCron(body.expression);
    if (!valid || !fields) {
      return c.json({ error: `Invalid cron expression: ${error}` }, 400);
    }

    const tz = body.timezone || "UTC";
    const count = Math.min(20, Math.max(1, body.count || 5));
    const description = describeCron(fields);
    const nextRuns = getNextRuns(fields, count, tz);

    const breakdown: Record<string, { raw: string; values: number[] }> = {};
    for (let i = 0; i < 5; i++) {
      breakdown[FIELD_NAMES[i]] = {
        raw: fields[i],
        values: parseField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]),
      };
    }

    return c.json({
      expression: body.expression,
      valid: true,
      description,
      timezone: tz,
      nextRuns,
      breakdown,
      hasSeconds: body.expression.trim().split(/\s+/).length === 6,
    });
  });
}
