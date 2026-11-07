import { clearSessionCookies } from "@/lib/auth";
import { handle } from "@/lib/api";

export const POST = handle(async () => {
  const res = Response.json({ ok: true });
  for (const c of clearSessionCookies()) res.headers.append("Set-Cookie", c);
  return res;
});
