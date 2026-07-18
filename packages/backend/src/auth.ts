import { createMiddleware } from "hono/factory";
import { Env, AppVars, ensureSeedKey, hashKey } from "./db";

export const apiKeyAuth = createMiddleware<{
  Bindings: Env;
  Variables: AppVars;
}>(async (c, next) => {
  await ensureSeedKey(c.env);
  const key = c.req.header("X-API-Key");
  if (!key) {
    return c.json({ error: "Missing X-API-Key header" }, 401);
  }
  const kh = await hashKey(key);
  const rec = await c.env.DB.prepare(
    "SELECT id FROM api_keys WHERE key_hash = ?"
  )
    .bind(kh)
    .first<{ id: string }>();
  if (!rec) {
    return c.json({ error: "Invalid API key" }, 401);
  }
  c.set("keyId", rec.id);
  c.set("isBootstrap", key === c.env.API_KEY);
  await next();
});
