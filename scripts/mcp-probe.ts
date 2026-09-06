/**
 * Drive Ward's MCP surface end to end, as a real client would.
 *
 *   WARD_USER_TOKEN=wardmcp_… bun run scripts/mcp-probe.ts
 *   WARD_USER_TOKEN=wardmcp_… bun run scripts/mcp-probe.ts --propose "buy a risk score on PEPE"
 *
 * It spawns `src/mcp/server.ts` as a separate stdio process — the way an MCP client
 * does — so this exercises the real transport, not an in-memory shortcut.
 *
 * **It reads whatever Sibyl Memory the environment points at.** That is the whole
 * subtlety of testing this: a token minted by `/link mcp` on the deployed bot lives
 * in the deployed store (`/data/memory.db` on the Railway volume), so a probe run on
 * a laptop will not find it. Run this where that store is.
 *
 * `--propose` queues a proposal. It does NOT execute anything: the main Ward process
 * picks it up within ~5s and replays the text as an ordinary turn on the user's own
 * channel, where it meets the same gate, caps and confirmation. So the proposal only
 * proves out when the main process is running against the same store.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.WARD_USER_TOKEN?.trim();
if (!token) {
  console.error('No WARD_USER_TOKEN. Mint one with "/link mcp" from Telegram or Discord.');
  process.exit(1);
}

const proposeAt = process.argv.indexOf("--propose");
const proposal = proposeAt === -1 ? null : process.argv[proposeAt + 1];
if (proposeAt !== -1 && !proposal) {
  console.error('--propose needs the request text, e.g. --propose "buy a risk score on PEPE"');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", new URL("../src/mcp/server.ts", import.meta.url).pathname],
  env: { ...(process.env as Record<string, string>), WARD_USER_TOKEN: token },
});

const client = new Client({ name: "ward-probe", version: "0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\ntools (${tools.length}):`);
for (const tool of tools) console.log(`  ${tool.name}`);

// The omission is the design: there must be no way to spend from here.
const dangerous = tools.filter((t) => /execute|swap|pay|send|transfer|approve/i.test(t.name));
console.log(
  dangerous.length === 0
    ? "  ✓ no execute/approve tool — MCP can ask, never authorize"
    : `  ✗ UNEXPECTED spend-capable tool: ${dangerous.map((t) => t.name).join(", ")}`,
);

for (const name of [
  "ward_whoami",
  "ward_read_authorization",
  "ward_recent_activity",
  "ward_link_status",
]) {
  const result = (await client.callTool({ name, arguments: {} })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
  const body = result.content.map((c) => c.text ?? "").join("\n");
  console.log(`\n── ${name}${result.isError ? "  (refused)" : ""}\n${body}`);
}

if (proposal) {
  const result = (await client.callTool({
    name: "ward_propose_action",
    arguments: { request: proposal },
  })) as { isError?: boolean; content: Array<{ text?: string }> };
  console.log(`\n── ward_propose_action${result.isError ? "  (refused)" : ""}`);
  console.log(result.content.map((c) => c.text ?? "").join("\n"));
  console.log("\nWatch your Telegram/Discord DM — the main process replays it within ~5s.");
}

await client.close();
