// One-time move of the dashboard's data from the storage machine (STORE_VM, default box5) into Postgres.
// The server also does this by itself on its first start with an empty database; this is the manual way.
// Safe to run again (it overwrites with the machine's version).
//
//   DATABASE_URL=postgres://... VMS=... npx tsx scripts/migrate-store.mts
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to the new database first.");
  process.exit(1);
}
const { migrateFromMachine } = await import("../src/lib/store-migrate");
const r = await migrateFromMachine((done, total) => process.stdout.write(`\r${done}/${total}`));
console.log(`\ncopied and verified ${r.copied} of ${r.files} files from ${r.from}${r.failed.length ? `\nfailed (run again to retry):\n  ${r.failed.join("\n  ")}` : ""}`);
process.exit(r.failed.length ? 1 : 0);
