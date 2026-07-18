import { Hono } from "hono";
import { Env, AppVars, hashKey } from "./db";
import { apiKeyAuth } from "./auth";

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

app.use("*", apiKeyAuth);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeLike = (value = "") => value.replace(/[!%_]/g, "!$&");
const normalizeDomain = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
const validDomain = (domain: string) => domain.length <= 253 && domain.includes(".") && domain.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));

app.post("/keys", async (c) => {
  if (!c.get("isBootstrap")) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name || "key";
  const key = `kwe_${crypto.randomUUID().replaceAll("-", "")}`;
  const kh = await hashKey(key);
  await c.env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), name, kh, Date.now())
    .run();
  return c.json({ key, name }, 201);
});

app.get("/keys", async (c) => {
  if (!c.get("isBootstrap")) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT id, name, created_at FROM api_keys ORDER BY created_at DESC"
  ).all();
  return c.json(rows.results);
});

app.get("/domains", async (c) => {
  const rows = await c.env.DB.prepare("SELECT name FROM domains WHERE enabled = 1 ORDER BY name").all();
  return c.json(rows.results);
});

app.post("/domains", async (c) => {
  if (!c.get("isBootstrap")) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ domain?: unknown }>().catch(() => ({} as { domain?: unknown }));
  const domain = normalizeDomain(body.domain);
  if (!validDomain(domain)) return c.json({ error: "invalid domain" }, 400);
  const existing = await c.env.DB.prepare("SELECT enabled FROM domains WHERE name = ?").bind(domain).first<{ enabled: number }>();
  if (existing?.enabled) return c.json({ error: "domain already exists", name: domain }, 409);
  if (existing) {
    await c.env.DB.prepare("UPDATE domains SET enabled = 1 WHERE name = ?").bind(domain).run();
    return c.json({ name: domain, enabled: true });
  }
  await c.env.DB.prepare("INSERT INTO domains (name, enabled, created_at) VALUES (?, ?, ?)").bind(domain, 1, Date.now()).run();
  return c.json({ name: domain, enabled: true }, 201);
});

app.delete("/domains/:domain", async (c) => {
  if (!c.get("isBootstrap")) return c.json({ error: "forbidden" }, 403);
  const domain = normalizeDomain(c.req.param("domain"));
  if (!validDomain(domain)) return c.json({ error: "invalid domain" }, 400);
  const result = await c.env.DB.prepare("UPDATE domains SET enabled = 0 WHERE name = ? AND enabled = 1").bind(domain).run();
  if (!result.meta.changes) return c.json({ error: "domain not found" }, 404);
  return c.json({ ok: true });
});

app.post("/addresses", async (c) => {
  const body = await c.req.json<{ localPart?: string; domain?: unknown }>().catch(() => ({} as { localPart?: string; domain?: unknown }));
  const domain = normalizeDomain(body.domain);
  if (!domain) return c.json({ error: "domain required" }, 400);
  if (!validDomain(domain)) return c.json({ error: "invalid domain" }, 400);
  const configured = await c.env.DB.prepare("SELECT enabled FROM domains WHERE name = ?").bind(domain).first<{ enabled: number }>();
  if (!configured) return c.json({ error: "domain not configured" }, 400);
  if (!configured.enabled) return c.json({ error: "domain disabled" }, 400);
  let local = (body.localPart || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!local) local = crypto.randomUUID();
  const address = `${local}@${domain}`;
  const keyId = c.get("keyId");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM email_addresses WHERE address = ?"
  )
    .bind(address)
    .first();
  if (existing) return c.json({ error: "address already exists", address }, 409);
  await c.env.DB.prepare(
    "INSERT INTO email_addresses (id, address, local_part, domain, api_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), address, local, domain, keyId, Date.now())
    .run();
  return c.json({ id: address, address }, 201);
});

app.get("/addresses", async (c) => {
  const keyId = c.get("keyId");
  const rows = await c.env.DB.prepare(
    `SELECT id, address, local_part, created_at,
      (SELECT COUNT(*) FROM emails e WHERE e.address_id = email_addresses.id) AS email_count,
      (SELECT COUNT(*) FROM emails e WHERE e.address_id = email_addresses.id AND e.is_read = 0) AS unread_count
     FROM email_addresses WHERE api_key_id = ? ORDER BY created_at DESC`
  )
    .bind(keyId)
    .all();
  return c.json(rows.results);
});

app.delete("/addresses/:id", async (c) => {
  const keyId = c.get("keyId");
  const address = c.req.param("id");
  const res = await c.env.DB.prepare(
    "DELETE FROM email_addresses WHERE address = ? AND api_key_id = ?"
  )
    .bind(address, keyId)
    .run();
  if ((res as unknown as { changes: number }).changes === 0)
    return c.json({ error: "not found or not owned" }, 404);
  return c.json({ ok: true });
});

app.get("/emails", async (c) => {
  const keyId = c.get("keyId");
  const address = c.req.query("address");
  if (!address) return c.json({ error: "address query required" }, 400);
  const owned = await c.env.DB.prepare(
    "SELECT id FROM email_addresses WHERE address = ? AND api_key_id = ?"
  )
    .bind(address, keyId)
    .first();
  if (!owned) return c.json({ error: "address not found or not owned" }, 404);
  const rows = await c.env.DB.prepare(
    "SELECT e.id, e.sender, e.from_addr, e.subject, e.body_text, e.body_html, e.is_read, e.received_at FROM emails e JOIN email_addresses a ON e.address_id = a.id WHERE a.address = ? ORDER BY e.received_at DESC"
  )
    .bind(address)
    .all();
  return c.json(rows.results);
});

app.get("/emails/:id", async (c) => {
  const keyId = c.get("keyId");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT e.* FROM emails e JOIN email_addresses a ON e.address_id = a.id WHERE e.id = ? AND a.api_key_id = ?"
  )
    .bind(id, keyId)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.patch("/emails/:id", async (c) => {
  const keyId = c.get("keyId");
  const id = c.req.param("id");
  const res = await c.env.DB.prepare(
    "UPDATE emails SET is_read = 1 WHERE id = ? AND address_id IN (SELECT id FROM email_addresses WHERE api_key_id = ?)"
  )
    .bind(id, keyId)
    .run();
  if ((res as unknown as { changes: number }).changes === 0)
    return c.json({ error: "not found or not owned" }, 404);
  return c.json({ ok: true });
});

// Purge all emails for an address (owned by the calling key).
app.delete("/emails", async (c) => {
  const keyId = c.get("keyId");
  const address = c.req.query("address");
  if (!address) return c.json({ error: "address query required" }, 400);
  const owned = await c.env.DB.prepare(
    "SELECT id FROM email_addresses WHERE address = ? AND api_key_id = ?"
  )
    .bind(address, keyId)
    .first();
  if (!owned) return c.json({ error: "address not found or not owned" }, 404);
  const res = await c.env.DB.prepare("DELETE FROM emails WHERE address_id = ?")
    .bind((owned as { id: string }).id)
    .run();
  return c.json({ deleted: (res as unknown as { changes: number }).changes });
});

app.get("/inboxes/wait", async (c) => {
  const keyId = c.get("keyId");
  const address = c.req.query("address");
  const subjectIncludes = c.req.query("subjectIncludes")?.toLowerCase();
  const bodyIncludes = c.req.query("bodyIncludes")?.toLowerCase();
  const timeoutMs = Number(c.req.query("timeoutMs") || 30000);
  if (!address) return c.json({ error: "address query required" }, 400);
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return c.json({ error: "timeoutMs must be an integer from 1 to 60000" }, 400);
  const owned = await c.env.DB.prepare(
    "SELECT id FROM email_addresses WHERE address = ? AND api_key_id = ?"
  )
    .bind(address, keyId)
    .first();
  if (!owned) return c.json({ error: "address not found or not owned" }, 404);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await c.env.DB.prepare(
      "SELECT e.id, e.sender, e.from_addr, e.subject, e.body_text, e.body_html, e.received_at FROM emails e JOIN email_addresses a ON e.address_id = a.id WHERE a.address = ? AND lower(coalesce(e.subject, '')) LIKE ? ESCAPE '!' AND lower(coalesce(e.body_text, '')) LIKE ? ESCAPE '!' ORDER BY e.received_at DESC LIMIT 1"
    )
      .bind(address, `%${escapeLike(subjectIncludes)}%`, `%${escapeLike(bodyIncludes)}%`)
      .first();
    if (row) return c.json(row);
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining > 0) await sleep(Math.min(1000, remaining));
  }
  return c.json({ error: "timeout", address }, 408);
});

export { app as apiApp };
