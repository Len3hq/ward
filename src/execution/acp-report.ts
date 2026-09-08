/**
 * The counterparty's deliverable, as something the user can read.
 *
 * Ward paid for this and then showed none of it: the reply said "Result: job
 * completed" and the trust score, while the report — the band, the score, the named
 * red flags — was validated, written to memory, and dropped. The user bought an
 * answer and was told only that an answer existed.
 *
 * Deliberately tolerant about shape. The report comes from a counterparty, and a
 * DIFFERENT counterparty will return something different; anything unrecognised
 * falls back to fenced JSON rather than being hidden.
 */

/** Field names are read defensively — another seller will not match this exactly. */
interface MaybeReport {
  subject?: unknown;
  address?: unknown;
  resolved_by?: unknown;
  risk_score?: unknown;
  band?: unknown;
  scale?: unknown;
  flags?: unknown;
  sources?: unknown;
}

const MAX_FLAGS = 8;
const MAX_JSON_CHARS = 900;

function shortenAddress(value: string): string {
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * `null` when there is nothing worth showing, so the caller can omit the section
 * entirely rather than print an empty heading.
 */
export function renderAcpReport(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    return text.length === 0 ? null : text;
  }
  if (typeof raw !== "object") return String(raw);

  const report = raw as MaybeReport;
  const lines: string[] = [];

  // The headline: a score with no direction is a number nobody can act on, so the
  // band leads and `scale` explains which way is good.
  const band = typeof report.band === "string" ? report.band : null;
  const score = typeof report.risk_score === "number" ? report.risk_score : null;
  if (band !== null || score !== null) {
    const headline = [band?.toUpperCase(), score !== null ? `${score}/100` : null]
      .filter(Boolean)
      .join(" · ");
    lines.push(`Risk: ${headline}`);
    if (typeof report.scale === "string" && report.scale.trim()) lines.push(`(${report.scale})`);
  }

  const flags = Array.isArray(report.flags)
    ? report.flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  if (flags.length > 0) {
    lines.push("", `Flags (${flags.length}):`);
    for (const flag of flags.slice(0, MAX_FLAGS)) lines.push(`  • ${flag}`);
    if (flags.length > MAX_FLAGS) lines.push(`  …and ${flags.length - MAX_FLAGS} more.`);
  } else if (lines.length > 0) {
    lines.push("", "No red flags raised.");
  }

  // Which address was actually scored, and how the seller got there. A ticker is
  // resolved by heuristic, so a report about the wrong token must be recognisable
  // as one — that is the whole reason `resolved_by` exists.
  if (typeof report.address === "string" && report.address.trim()) {
    lines.push("", `Scored: \`${report.address}\``);
  }
  if (typeof report.resolved_by === "string" && report.resolved_by.trim()) {
    lines.push(`Resolved by: ${report.resolved_by}`);
  }
  if (Array.isArray(report.sources) && report.sources.length > 0) {
    const names = report.sources
      .map((s) => (s as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string");
    if (names.length > 0) lines.push(`Sources: ${names.join(", ")}`);
  }

  if (lines.length > 0) return lines.join("\n");

  // Unrecognised shape — show it rather than hide it. A counterparty that returns
  // something this cannot parse has still delivered, and the user still paid.
  const json = JSON.stringify(raw, null, 2);
  const clipped = json.length > MAX_JSON_CHARS ? `${json.slice(0, MAX_JSON_CHARS)}…` : json;
  return ["```json", clipped, "```"].join("\n");
}

export { shortenAddress as shortenReportAddress };
