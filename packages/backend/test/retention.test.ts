import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index";

test("scheduled cleanup deletes messages older than 24 hours", async () => {
  let sql = ""; let cutoff = 0;
  const before = Date.now();
  let pending: Promise<unknown>;
  worker.scheduled({} as any, { DB: { prepare(q: string) { sql = q; return { bind(v: number) { cutoff = v; return this; }, run: async () => ({}) }; } } } as any, { waitUntil(p: Promise<unknown>) { pending = p; } } as any);
  await pending!;
  assert.equal(sql, "DELETE FROM emails WHERE received_at < ?");
  assert.ok(cutoff >= before - 86400000 && cutoff <= Date.now() - 86400000);
});
