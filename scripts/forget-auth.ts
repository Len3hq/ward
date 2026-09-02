/**
 * Remove a user's authorization entity from Sibyl Memory — the deletion the
 * judges perform. Prints the record before and confirms it is gone after.
 *
 *   bun run scripts/forget-auth.ts <telegram_id> [--check]
 *
 * Uses whatever backend the env selects (SIBYL_MEMORY_MODE). For `sibyl-mcp` this
 * archives the entity (`memory_forget`); for `fs` it deletes the file.
 */
import { backend } from "../memory/backend.ts";
import { read } from "../memory/index.ts";

const [, , tgId, flag] = process.argv;
if (!tgId) {
  console.error("usage: bun run scripts/forget-auth.ts <telegram_id> [--check]");
  process.exit(1);
}

const before = await read(tgId);
if (before === null) {
  console.log(`No authorization record for ${tgId} — nothing to delete.`);
  process.exit(0);
}

console.log("Current authorization record:");
console.log(JSON.stringify(before, null, 2));

if (flag === "--check") process.exit(0);

await backend().forgetEntity("ward.authorization", tgId);

const after = await read(tgId);
console.log(
  after === null
    ? `\n✓ Deleted. read(${tgId}) is now null.`
    : "\n✗ Still present — check the backend.",
);
process.exit(after === null ? 0 : 1);
