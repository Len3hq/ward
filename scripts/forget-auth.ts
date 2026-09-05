/**
 * Remove a user's authorization entity from Sibyl Memory — the deletion the
 * judges perform. Prints the record before and confirms it is gone after.
 *
 *   bun run scripts/forget-auth.ts <ward_user_id>       [--check]
 *   bun run scripts/forget-auth.ts telegram:700100200   [--check]
 *
 * Takes either the principal or a `<channel>:<account_id>` reference, so the
 * demo command still works when you only know the Telegram id.
 *
 * Deleting the authorization deliberately leaves the identity links in place: the
 * user can still reach Ward from every channel, and Ward refuses to move money on
 * every one of them. That is the gate — it is a property of the missing record,
 * not of being locked out.
 *
 * Uses whatever backend the env selects (SIBYL_MEMORY_MODE). For `sibyl-mcp` this
 * archives the entity (`memory_forget`); for `fs` it deletes the file.
 */
import { backend } from "../memory/backend.ts";
import { read } from "../memory/index.ts";
import { accountsFor, resolveRef } from "../src/identity/index.ts";

const [, , ref, flag] = process.argv;
if (!ref) {
  console.error(
    "usage: bun run scripts/forget-auth.ts <ward_user_id | channel:account_id> [--check]",
  );
  process.exit(1);
}

const userId = await resolveRef(ref);
if (userId === null) {
  console.error(
    `Could not resolve ${JSON.stringify(ref)} to a Ward user. ` +
      `Pass a ward_<ulid> id, or a linked account like "telegram:700100200".`,
  );
  process.exit(1);
}
if (userId !== ref) console.log(`${ref} → ${userId}`);

const before = await read(userId);
if (before === null) {
  console.log(`No authorization record for ${userId} — nothing to delete.`);
  process.exit(0);
}

const accounts = await accountsFor(userId);
if (accounts.length > 0) {
  console.log(
    `Linked accounts (all of them lose the ability to move money): ` +
      accounts.map((a) => `${a.channel}:${a.account_id}`).join(", "),
  );
}

console.log("Current authorization record:");
console.log(JSON.stringify(before, null, 2));

if (flag === "--check") process.exit(0);

await backend().forgetEntity("ward.authorization", userId);

const after = await read(userId);
console.log(
  after === null
    ? `\n✓ Deleted. read(${userId}) is now null on every channel.`
    : "\n✗ Still present — check the backend.",
);
process.exit(after === null ? 0 : 1);
