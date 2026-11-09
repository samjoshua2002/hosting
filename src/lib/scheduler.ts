// In-process timer for long-running servers: an Autopilot pass every 15 minutes (the machines' pings may also
// trigger passes; runAutopilot skips any that come too soon after the last one).
import { runAutopilot } from "./autopilot";

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;
  const tick = () => {
    runAutopilot().catch((e) => console.error("[autopilot]", (e as Error).message));
  };
  // first pass a couple of minutes after boot (let the server warm up), then every 15 minutes
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 15 * 60_000).unref();
  console.log("[autopilot] internal scheduler on: every 15 minutes");
}
