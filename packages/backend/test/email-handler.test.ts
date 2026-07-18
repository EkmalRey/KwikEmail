import test from "node:test";
import assert from "node:assert/strict";
import { handleEmail } from "../src/email-handler";

test("uses normalized envelope recipient and rejects unknown addresses", async () => {
  const sql: string[] = [];
  const db = { prepare(q: string) { sql.push(q); return { bind() { return this; }, first: async () => null }; } };
  let rejected = "";
  await handleEmail({ to: "  Known@Example.COM ", setReject: (s: string) => rejected = s } as any, { DB: db } as any);
  assert.equal(rejected, "Unknown recipient");
  assert.equal(sql.some((q) => q.startsWith("INSERT OR IGNORE INTO email_addresses")), false);
});

test("rethrows unexpected ingestion failures", async () => {
  const db = { prepare() { throw new Error("database down"); } };
  await assert.rejects(() => handleEmail({ to: "known@example.com" } as any, { DB: db } as any), /database down/);
});
