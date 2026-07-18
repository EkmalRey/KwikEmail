import test from "node:test";
import assert from "node:assert/strict";
import { apiApp } from "../src/api";

function env(bootstrap = "bootstrap") {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const DB = { prepare(sql: string) { const call = { sql, binds: [] as unknown[] }; calls.push(call); return { bind(...v: unknown[]) { call.binds = v; return this; }, first: async () => {
    if (sql.includes("COUNT(*)")) return { c: 1 };
    if (sql.includes("FROM api_keys")) return { id: "generated", name: "key" };
    if (sql.includes("FROM domains WHERE name")) return { name: "example.com", enabled: 1 };
    if (sql.startsWith("SELECT id FROM email_addresses")) return { id: "address-id" };
    return null;
  }, all: async () => ({ results: [] }), run: async () => ({ changes: 1, meta: { changes: 1 } }) }; } };
  return { value: { DB, API_KEY: bootstrap } as any, calls };
}

test("generated keys cannot administer keys", async () => {
  const { value } = env();
  const response = await apiApp.request("/keys", { headers: { "X-API-Key": "generated" } }, value);
  assert.equal(response.status, 403);
});

test("generated keys use the KwikEmail prefix", async () => {
  const { value } = env();
  const response = await apiApp.request("/keys", { method: "POST", headers: { "X-API-Key": "bootstrap", "Content-Type": "application/json" }, body: "{}" }, value);
  assert.equal(response.status, 201);
  assert.match((await response.json()).key, /^kwe_[0-9a-f]{32}$/);
});

test("configured bootstrap key is inserted even when other keys exist", async () => {
  const { value, calls } = env("rotated");
  await apiApp.request("/addresses", { headers: { "X-API-Key": "generated" } }, value);
  const insert = calls.find((c) => c.sql.includes("INSERT OR IGNORE INTO api_keys"));
  assert.ok(insert);
  assert.equal(insert.binds[1], "seed");
  assert.equal(insert.binds[2], "f42546d5ecdd452509808b2d6d0413b5a738c70a793b99ccf8ed6f423aac83d3");
  assert.equal(calls.some((c) => c.sql.includes("SELECT COUNT(*) AS c FROM api_keys")), false);
});

test("generated addresses use a native UUID local part", async () => {
  const { value } = env();
  value.DB.prepare = (sql: string) => ({
    bind() { return this; },
    first: async () => sql.includes("FROM api_keys") ? { id: "generated" } : sql.includes("FROM domains") ? { name: "example.com", enabled: 1 } : null,
    run: async () => ({ changes: 1 }),
  });
  const response = await apiApp.request("/addresses", {
    method: "POST",
    headers: { "X-API-Key": "generated", "Content-Type": "application/json" },
    body: JSON.stringify({ domain: " Example.COM. " }),
  }, value);
  assert.match((await response.json() as { address: string }).address, /^[0-9a-f-]{36}@example\.com$/);
});

test("address creation requires an enabled configured domain", async () => {
  for (const [body, domain, error] of [
    [{}, null, "domain required"],
    [{ domain: "missing.example" }, null, "domain not configured"],
    [{ domain: "disabled.example" }, { name: "disabled.example", enabled: 0 }, "domain disabled"],
  ] as const) {
    const { value } = env();
    value.DB.prepare = (sql: string) => ({
      bind() { return this; },
      first: async () => sql.includes("FROM api_keys") ? { id: "generated" } : domain,
      run: async () => ({ changes: 1 }),
    });
    const response = await apiApp.request("/addresses", {
      method: "POST",
      headers: { "X-API-Key": "generated", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, value);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
});

test("authenticated keys can list enabled domains", async () => {
  const { value, calls } = env();
  value.DB.prepare = (sql: string) => {
    calls.push({ sql, binds: [] });
    return {
    bind() { return this; },
    first: async () => sql.includes("FROM api_keys") ? { id: "generated" } : null,
    all: async () => ({ results: [{ name: "example.com" }] }),
    run: async () => ({ changes: 1 }),
    };
  };
  const response = await apiApp.request("/domains", { headers: { "X-API-Key": "generated" } }, value);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ name: "example.com" }]);
  assert.match(calls.at(-1)?.sql || "", /enabled = 1/);
});

test("generated keys cannot administer domains", async () => {
  for (const [method, path] of [["POST", "/domains"], ["DELETE", "/domains/example.com"]]) {
    const { value } = env();
    const response = await apiApp.request(path, {
      method,
      headers: { "X-API-Key": "generated", "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify({ domain: "example.com" }) : undefined,
    }, value);
    assert.equal(response.status, 403);
  }
});

test("bootstrap key validates and creates normalized domains", async () => {
  for (const domain of ["", "localhost", "bad_domain.com", "-bad.com", "bad..com"]) {
    const { value } = env();
    const response = await apiApp.request("/domains", {
      method: "POST",
      headers: { "X-API-Key": "bootstrap", "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    }, value);
    assert.equal(response.status, 400, domain);
  }
  const { value, calls } = env();
  value.DB.prepare = (sql: string) => {
    const call = { sql, binds: [] as unknown[] };
    calls.push(call);
    return {
      bind(...values: unknown[]) { call.binds = values; return this; },
      first: async () => sql.includes("FROM api_keys") ? { id: "seed" } : null,
      run: async () => ({ changes: 1 }),
    };
  };
  const response = await apiApp.request("/domains", {
    method: "POST",
    headers: { "X-API-Key": "bootstrap", "Content-Type": "application/json" },
    body: JSON.stringify({ domain: " Example.COM. " }),
  }, value);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { name: "example.com", enabled: true });
  assert.deepEqual(calls.at(-1)?.binds.slice(0, 2), ["example.com", 1]);
});

test("domain creation conflicts when enabled and re-enables when disabled", async () => {
  for (const [enabled, status] of [[1, 409], [0, 200]] as const) {
    const { value, calls } = env();
    value.DB.prepare = (sql: string) => {
      const call = { sql, binds: [] as unknown[] };
      calls.push(call);
      return {
        bind(...values: unknown[]) { call.binds = values; return this; },
        first: async () => sql.includes("FROM api_keys") ? { id: "seed" } : { name: "example.com", enabled },
        run: async () => ({ changes: 1 }),
      };
    };
    const response = await apiApp.request("/domains", {
      method: "POST",
      headers: { "X-API-Key": "bootstrap", "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    }, value);
    assert.equal(response.status, status);
    if (!enabled) assert.ok(calls.some((call) => call.sql.startsWith("UPDATE domains SET enabled = 1")));
  }
});

test("domain deletion validates and disables configured domains", async () => {
  const { value, calls } = env();
  const invalid = await apiApp.request("/domains/bad_domain.com", { method: "DELETE", headers: { "X-API-Key": "bootstrap" } }, value);
  assert.equal(invalid.status, 400);
  const response = await apiApp.request("/domains/Example.COM.", { method: "DELETE", headers: { "X-API-Key": "bootstrap" } }, value);
  assert.equal(response.status, 200);
  const update = calls.find((call) => call.sql.startsWith("UPDATE domains SET enabled = 0"));
  assert.deepEqual(update?.binds, ["example.com"]);
});

test("domain deletion returns not found when no enabled domain changes", async () => {
  const { value } = env();
  value.DB.prepare = (sql: string) => ({
    bind() { return this; },
    first: async () => sql.includes("FROM api_keys") ? { id: "seed" } : null,
    run: async () => ({ meta: { changes: sql.startsWith("UPDATE domains") ? 0 : 1 } }),
  });
  const response = await apiApp.request("/domains/missing.example", { method: "DELETE", headers: { "X-API-Key": "bootstrap" } }, value);
  assert.equal(response.status, 404);
});

test("wait rejects invalid timeouts", async () => {
  for (const timeout of ["0", "60001", "1.5", "Infinity", "nope"]) {
    const { value } = env();
    const response = await apiApp.request(`/inboxes/wait?address=a@example.com&timeoutMs=${timeout}`, { headers: { "X-API-Key": "generated" } }, value);
    assert.equal(response.status, 400, timeout);
  }
});

test("wait does not sleep past its timeout", async () => {
  const { value } = env();
  const start = Date.now();
  const response = await apiApp.request("/inboxes/wait?address=a@example.com&timeoutMs=20", { headers: { "X-API-Key": "generated" } }, value);
  assert.equal(response.status, 408);
  assert.ok(Date.now() - start < 500);
});

test("wait applies subject and body matching in SQL", async () => {
  const { value, calls } = env();
  await apiApp.request("/inboxes/wait?address=a@example.com&timeoutMs=1&subjectIncludes=Code&bodyIncludes=123", { headers: { "X-API-Key": "generated" } }, value);
  const query = calls.find((c) => c.sql.includes("FROM emails e"));
  assert.match(query?.sql || "", /lower\(coalesce\(e\.subject/);
  assert.match(query?.sql || "", /lower\(coalesce\(e\.body_text/);
  assert.deepEqual(query?.binds.slice(-2), ["%code%", "%123%"]);
});

test("wait treats LIKE metacharacters literally", async () => {
  const { value, calls } = env();
  await apiApp.request("/inboxes/wait?address=a@example.com&timeoutMs=1&subjectIncludes=%25_a!&bodyIncludes=a!%25_b", { headers: { "X-API-Key": "generated" } }, value);
  const query = calls.find((c) => c.sql.includes("FROM emails e"));
  assert.match(query?.sql || "", /LIKE \? ESCAPE '!'/g);
  assert.deepEqual(query?.binds.slice(-2), ["%!%!_a!!%", "%a!!!%!_b%"]);
});

test("email listing returns the complete inbox for archival", async () => {
  const { value, calls } = env();
  await apiApp.request("/emails?address=a@example.com", { headers: { "X-API-Key": "generated" } }, value);
  const query = calls.find((c) => c.sql.includes("FROM emails e"));
  assert.doesNotMatch(query?.sql || "", /\bLIMIT\b/i);
});
