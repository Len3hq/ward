/**
 * One-line structured logs, for reading in Railway.
 *
 * Until this existed the only things Ward printed were startup banners and stack
 * traces, so a live deployment looked identical whether it was serving people or
 * quietly doing nothing — and when it did crash, the last thing in the log was an
 * error with no trace of the conversation that led to it.
 *
 * Format is `key=value`, one event per line, so Railway's search can filter on
 * `event=turn.done` or `channel=discord` without any log-shipping setup:
 *
 *   2026-09-07T12:26:41.011Z ward event=msg.in channel=telegram account=706456243 …
 *
 * Message text is included by default — this is the operator's own bot and the
 * whole point is seeing what people said — and suppressed with `WARD_LOG_TEXT=0`
 * for a deployment where the transcript should not sit in a log aggregator.
 */

const MAX_VALUE_CHARS = 200;
const MAX_TEXT_CHARS = 160;

export type LogFields = Record<string, unknown>;

export function log(event: string, fields: LogFields = {}): void {
  console.log(line(event, fields));
}

/**
 * An error, with the context it happened in. Same shape as `log` so a failure and
 * the turn it belongs to line up in a search on `thread=…`.
 */
export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(line(event, { ...fields, error: message }));
  if (error instanceof Error && error.stack) console.error(error.stack);
}

/** Whether message text may be logged. */
export function logsText(): boolean {
  const raw = process.env.WARD_LOG_TEXT?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** A message body as it should appear in a log: truncated, or withheld entirely. */
export function preview(text: string): string {
  if (!logsText()) return `(${text.length} chars, text logging off)`;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS)}…` : flat;
}

function line(event: string, fields: LogFields): string {
  const parts = [`${new Date().toISOString()} ward event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${format(value)}`);
  }
  return parts.join(" ");
}

function format(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (typeof value === "boolean") return String(value);
  const text = String(value);
  const clipped = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
  // Quote anything that would otherwise break `key=value` parsing.
  return /[\s"=]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}
