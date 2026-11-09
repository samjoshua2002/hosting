// Runs once when a server instance starts.
// - DATABASE_URL on a fresh database: copy the dashboard's data over from the storage machine, once.
// - INTERNAL_SCHEDULER=1 (servers that stay up: Render, a VPS): Autopilot every 15 minutes in-process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DATABASE_URL) {
    const { autoMigrate } = await import("./lib/store-migrate");
    autoMigrate().catch((e) => console.error("[store] migration:", (e as Error).message));
  }
  if (process.env.INTERNAL_SCHEDULER === "1") {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
