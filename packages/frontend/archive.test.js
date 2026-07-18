import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Archive, LEGACY_ACCOUNT_ID, defaultArchivePath, mergeEmails, syncArchive, scheduleSync, serialize, tagStorage } from "./archive.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "flashmail-")), archive = new Archive(join(dir, "flashmail.sqlite"));
  await archive.init();
  t.after(() => archive.close());
  t.after(() => rm(dir, { recursive: true }));
  return { archive, dir };
}

test("adopts legacy data files under the KwikEmail name", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kwikemail-migrate-"));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "flashmail.sqlite"), "database");
  await writeFile(join(dir, "flashmail.key"), "key");
  await writeFile(join(dir, "flashmail.sqlite-wal"), "wal");
  assert.equal(await defaultArchivePath(dir), join(dir, "kwikemail.sqlite"));
  assert.equal(await readFile(join(dir, "kwikemail.sqlite"), "utf8"), "database");
  assert.equal(await readFile(join(dir, "kwikemail.key"), "utf8"), "key");
  assert.equal(await readFile(join(dir, "kwikemail.sqlite-wal"), "utf8"), "wal");
});

test("does not replace existing KwikEmail data with legacy files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kwikemail-current-"));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "kwikemail.sqlite"), "current");
  await writeFile(join(dir, "flashmail.sqlite"), "legacy");
  await defaultArchivePath(dir);
  assert.equal(await readFile(join(dir, "kwikemail.sqlite"), "utf8"), "current");
});

test("migrates legacy emails in place and scopes new mail by account", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flashmail-")), path = join(dir, "flashmail.sqlite"), legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, address TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL)");
  legacy.prepare("INSERT INTO emails VALUES (?, ?, ?, ?)").run("same", "a@example.com", JSON.stringify({ id: "same", received_at: 1 }), 1); legacy.close();
  const archive = new Archive(path); t.after(() => archive.close()); t.after(() => rm(dir, { recursive: true }));
  assert.equal(archive.list(LEGACY_ACCOUNT_ID, "a@example.com").length, 1);
  archive.upsert("account-a", "a@example.com", [{ id: "same", body_html: "a", received_at: 2 }]);
  archive.upsert("account-b", "a@example.com", [{ id: "same", body_html: "b", received_at: 3 }]);
  assert.equal(archive.list("account-a", "a@example.com")[0].body_html, "a");
  assert.equal(archive.list("account-b", "a@example.com")[0].body_html, "b");
  archive.purge("account-a", "a@example.com");
  assert.deepEqual(archive.list("account-a", "a@example.com"), []);
  assert.equal(archive.list("account-b", "a@example.com").length, 1);
  assert.deepEqual(archive.db.prepare("PRAGMA table_info(emails)").all().filter((x) => x.pk).map((x) => x.name), ["account_id", "id"]);
});

test("bootstraps admin asynchronously and changes password while invalidating sessions", async (t) => {
  const { archive } = await fixture(t);
  assert.equal(await archive.verifyPassword("123456"), true);
  assert.deepEqual(archive.adminState(), { password_changed: false });
  const token = archive.createSession();
  assert.equal(archive.validateSession(token), true);
  assert.notEqual(archive.db.prepare("SELECT id_hash FROM sessions").get().id_hash, token);
  await archive.changePassword("better password");
  assert.equal(await archive.verifyPassword("123456"), false);
  assert.equal(await archive.verifyPassword("better password"), true);
  assert.deepEqual(archive.adminState(), { password_changed: true });
  assert.equal(archive.validateSession(token), false);
});

test("expires and deletes opaque sessions", async (t) => {
  const { archive } = await fixture(t), expired = archive.createSession(-1), active = archive.createSession();
  assert.equal(archive.validateSession(expired), false);
  assert.equal(archive.validateSession(active), true);
  archive.deleteSession(active);
  assert.equal(archive.validateSession(active), false);
});

test("persists a mode-0600 encryption key and authenticated ciphertext", async (t) => {
  const { archive, dir } = await fixture(t), keyPath = join(dir, "flashmail.key");
  assert.equal((await readFile(keyPath)).length, 32);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  const encrypted = archive.encrypt("secret");
  assert.equal(encrypted.includes("secret"), false);
  assert.equal(archive.decrypt(encrypted), "secret");
  assert.throws(() => archive.decrypt(encrypted.slice(0, -1) + (encrypted.endsWith("x") ? "y" : "x")));
});

test("stores settings and performs credential, account, and domain CRUD", async (t) => {
  const { archive } = await fixture(t);
  archive.setSetting("setup_complete", false);
  assert.equal(archive.getSetting("setup_complete"), "false");
  assert.equal(archive.getSetting("schema_version"), "3");
  const credential = archive.saveCredential({ type: "api_token", name: "Cloudflare", value: "token-value" });
  assert.equal(archive.getCredential(credential.id).value, "token-value");
  assert.equal(archive.db.prepare("SELECT encrypted_value FROM credentials WHERE id = ?").get(credential.id).encrypted_value.includes("token-value"), false);
  archive.saveCredential({ ...credential, name: "Updated", value: "new-token" });
  assert.equal(archive.getCredential(credential.id).name, "Updated");
  assert.equal(archive.listCredentials().length, 1);
  const account = archive.saveAccount({ credential_id: credential.id, cloudflare_account_id: "cf-1", name: "Personal", bootstrap_key: "worker-key", status: "new" });
  archive.saveAccount({ ...account, status: "ready", worker_url: "https://worker.example" });
  assert.equal(archive.getAccount(account.id).status, "ready");
  assert.equal(archive.getBootstrapKey(account.id), "worker-key");
  assert.equal(archive.listAccounts().length, 1);
  const domain = archive.saveDomain({ account_id: account.id, zone_id: "zone-1", name: "example.com", routing_status: "pending", enabled: true });
  const updatedDomain = archive.saveDomain({ account_id: account.id, zone_id: "zone-1", name: "example.com", routing_status: "ready", routing_rule_id: "rule-1", enabled: true });
  assert.equal(updatedDomain.id, domain.id);
  assert.equal(archive.listDomains(account.id).length, 1);
  assert.equal(archive.listDomains(account.id)[0].routing_status, "ready");
  archive.saveDomain({ ...domain, enabled: false });
  assert.equal(archive.getDomain(domain.id).enabled, 0);
  archive.deleteDomain(domain.id);
  assert.deepEqual(archive.listDomains(account.id), []);
  archive.deleteAccount(account.id); archive.deleteCredential(credential.id);
  assert.equal(archive.getAccount(account.id), undefined);
  assert.equal(archive.getCredential(credential.id), undefined);
});

test("archive upserts complete emails and merges by newest ID", async (t) => {
  const { archive } = await fixture(t);
  archive.upsert("account", "a@example.com", [{ id: "1", from_addr: "x", body_html: "<b>x</b>", received_at: 1 }]);
  archive.upsert("account", "a@example.com", [{ id: "1", from_addr: "new", body_html: "<b>new</b>", received_at: 2 }]);
  assert.equal(archive.list("account", "a@example.com")[0].body_html, "<b>new</b>");
  assert.deepEqual(mergeEmails(archive.list("account", "a@example.com"), [{ id: "2", received_at: 3 }]).map((x) => x.id), ["2", "1"]);
});

test("sync lists every address and archives each account inbox", async () => {
  const seen = [], archive = { upsert: (...args) => seen.push(args) };
  await syncArchive(archive, "account", async (path) => path === "/addresses" ? [{ address: "a@x" }, { address: "b@x" }] : [{ id: path }]);
  assert.equal(seen.length, 2); assert.equal(seen[0][0], "account");
});

test("tagStorage marks cloud-backed vs local-only emails", () => {
  assert.deepEqual(tagStorage([{ id: "1" }], [{ id: "1" }, { id: "2" }]), [{ id: "1", storage: "cloud" }, { id: "2", storage: "local" }]);
});

test("scheduler syncs immediately and hourly", async () => {
  let runs = 0, delay;
  scheduleSync(async () => runs++, (fn, ms) => { delay = ms; return 1; });
  await new Promise(setImmediate);
  assert.equal(runs, 1); assert.equal(delay, 3_600_000);
});

test("serialized purge runs after an in-flight archive sync", async () => {
  let release; const order = [], run = serialize();
  const sync = run(async () => { await new Promise((resolve) => { release = resolve; }); order.push("upsert"); });
  const purge = run(() => order.push("purge"));
  await new Promise(setImmediate); assert.deepEqual(order, []); release();
  await Promise.all([sync, purge]); assert.deepEqual(order, ["upsert", "purge"]);
});
