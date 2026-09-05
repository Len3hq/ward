/**
 * One-shot migration from the Telegram-only build to Ward user ids.
 *
 *   bun run scripts/migrate-identity.ts <telegram_id> [<telegram_id> …]
 *   bun run scripts/migrate-identity.ts <telegram_id> --check
 *
 * Before Phase 9 the Telegram id *was* the entity name:
 *
 *   ward.authorization / 700100200
 *   ward.wallet        / 700100200
 *   state ward.conversation.700100200
 *
 * After it, the entity name is an opaque `WardUserId` and the Telegram id is one
 * of possibly several accounts pointing at it. Sibyl Memory has no rename, so this
 * is read → put → forget, per user.
 *
 * Two properties matter:
 *
 * 1. **Idempotent.** The `ward.identity` forward entry is written LAST. A re-run
 *    that finds it present has nothing to do; a run that died halfway leaves the
 *    account unresolved rather than pointing at a half-built principal.
 * 2. **The wallet address is preserved.** `ward.wallet.account_key` is pinned to
 *    the *original Telegram id*, because the CDP smart-account address is derived
 *    from it (`ward-user-<account_key>`). Rekeying it to the new principal would
 *    silently point the user at a fresh, empty smart account and strand their
 *    funds and their granted spend permission at the old address.
 *
 * Uses whatever backend the env selects (`SIBYL_MEMORY_MODE`). Run against the
 * real store only once you've run it with `--check` first.
 */
import { backend } from "../memory/backend.ts";
import {
  appendJournalEvent,
  readIdentity,
  userAuthorizationSchema,
  walletRecordSchema,
} from "../memory/index.ts";
import { mintWardUserId } from "../src/identity/index.ts";

const AUTHORIZATION = "ward.authorization";
const WALLET = "ward.wallet";

const args = process.argv.slice(2);
const check = args.includes("--check");
const telegramIds = args.filter((a) => !a.startsWith("--"));

if (telegramIds.length === 0) {
  console.error("usage: bun run scripts/migrate-identity.ts <telegram_id> [more…] [--check]");
  process.exit(1);
}

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const tgId of telegramIds) {
  if (!/^\d+$/.test(tgId)) {
    console.error(`✗ ${tgId}: not a Telegram id`);
    failed++;
    continue;
  }

  // Already migrated? The forward entry is the marker, so this is the re-run no-op.
  const existing = await readIdentity("telegram", tgId);
  if (existing) {
    console.log(`· ${tgId}: already linked to ${existing.ward_user_id} — nothing to do`);
    skipped++;
    continue;
  }

  const legacyAuth = await backend().getEntity(AUTHORIZATION, tgId);
  if (legacyAuth === null || legacyAuth === undefined) {
    console.log(`· ${tgId}: no legacy authorization record — nothing to migrate`);
    skipped++;
    continue;
  }

  const userId = mintWardUserId();
  const legacyWallet = await backend().getEntity(WALLET, tgId);
  const legacyConversation = await backend().getState(`ward.conversation.${tgId}`);

  console.log(`\n${tgId} → ${userId}`);
  console.log(`  authorization  yes`);
  console.log(`  wallet         ${legacyWallet ? "yes" : "none"}`);
  console.log(`  conversation   ${legacyConversation ? "yes" : "none"}`);

  if (check) {
    console.log("  (--check: nothing written)");
    continue;
  }

  try {
    // Validate before writing anything — a malformed legacy record should fail
    // here, with both copies still intact, not halfway through.
    const auth = userAuthorizationSchema.parse(legacyAuth);
    const wallet =
      legacyWallet === null || legacyWallet === undefined
        ? null
        : walletRecordSchema.parse({
            // Pin the ORIGINAL Telegram id: the smart-account address derives from it.
            account_key: tgId,
            ...(legacyWallet as Record<string, unknown>),
          });

    await backend().putEntity(AUTHORIZATION, userId, auth);
    if (wallet) await backend().putEntity(WALLET, userId, wallet);
    if (legacyConversation) {
      await backend().setState(`ward.conversation.${userId}`, legacyConversation);
    }

    await appendJournalEvent(
      userId,
      "identity_migrate",
      `migrated telegram:${tgId} to ${userId}`,
      { from_telegram_id: tgId, wallet: wallet !== null, account_key: wallet?.account_key ?? null },
      "telegram",
    );

    // LAST: the forward entry. Until this lands the account stays unresolved and a
    // re-run redoes the copy harmlessly.
    const { link } = await import("../src/identity/index.ts");
    await link(userId, "telegram", tgId, "migration");

    // Only now is the old copy safe to drop.
    await backend().forgetEntity(AUTHORIZATION, tgId, "migrated to ward user id");
    if (legacyWallet) await backend().forgetEntity(WALLET, tgId, "migrated to ward user id");

    console.log(`  ✓ migrated${wallet ? ` (wallet account_key pinned to ${tgId})` : ""}`);
    migrated++;
  } catch (error) {
    console.error(`  ✗ failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`    the legacy record under ${tgId} is untouched — safe to re-run`);
    failed++;
  }
}

console.log(
  `\n${check ? "would migrate" : "migrated"} ${check ? telegramIds.length - skipped - failed : migrated}` +
    `, skipped ${skipped}, failed ${failed}`,
);
process.exit(failed > 0 ? 1 : 0);
