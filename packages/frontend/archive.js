import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { open, readFile, chmod, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export const LEGACY_ACCOUNT_ID = "legacy";
const scryptAsync = (password, salt) => new Promise((resolve, reject) => scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));

export async function defaultArchivePath(dataRoot = "/data") {
  if (process.env.KWIKEMAIL_DB_PATH) return process.env.KWIKEMAIL_DB_PATH;
  if (process.env.FLASHMAIL_DB_PATH) return process.env.FLASHMAIL_DB_PATH;
  const current = join(dataRoot, "kwikemail.sqlite"), legacy = join(dataRoot, "flashmail.sqlite");
  const adopt = async (oldPath, newPath) => { try { await stat(newPath); } catch (error) { if (error.code !== "ENOENT") throw error; try { await rename(oldPath, newPath); } catch (moveError) { if (moveError.code !== "ENOENT") throw moveError; } } };
  await adopt(legacy, current);
  await adopt(legacy + "-wal", current + "-wal");
  await adopt(legacy + "-shm", current + "-shm");
  await adopt(join(dataRoot, "flashmail.key"), join(dataRoot, "kwikemail.key"));
  return current;
}

export class Archive {
  constructor(path = process.env.KWIKEMAIL_DB_PATH || process.env.FLASHMAIL_DB_PATH || "/data/kwikemail.sqlite", keyPath = path === ":memory:" ? null : path.replace(/\.[^/.]+$/, "") + ".key") {
    this.db = new DatabaseSync(path);
    this.keyPath = keyPath;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
    this.migrate();
    this.put = this.db.prepare("INSERT INTO emails (account_id, id, address, data, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET address=excluded.address, data=excluded.data, received_at=excluded.received_at");
  }

  migrate() {
    const columns = this.db.prepare("PRAGMA table_info(emails)").all();
    this.db.exec("BEGIN");
    try {
      if (columns.length && !columns.some(({ name }) => name === "account_id")) {
        this.db.exec(`CREATE TABLE emails_new (account_id TEXT NOT NULL, id TEXT NOT NULL, address TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (account_id, id));
          INSERT INTO emails_new SELECT 'legacy', id, address, data, received_at FROM emails;
          DROP TABLE emails;
          ALTER TABLE emails_new RENAME TO emails`);
      } else if (!columns.length) {
        this.db.exec("CREATE TABLE emails (account_id TEXT NOT NULL, id TEXT NOT NULL, address TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (account_id, id))");
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS emails_account_address ON emails(account_id, address, received_at DESC);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_changed INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, encrypted_value TEXT, wrangler_profile TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, cloudflare_account_id TEXT NOT NULL, name TEXT NOT NULL, worker_name TEXT, worker_url TEXT, d1_database_id TEXT, d1_database_name TEXT, bootstrap_key_encrypted TEXT, status TEXT NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS domains (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, zone_id TEXT NOT NULL, name TEXT NOT NULL, routing_rule_id TEXT, routing_status TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        DELETE FROM domains WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, zone_id ORDER BY (routing_status = 'ready') DESC, updated_at DESC) AS duplicate FROM domains) WHERE duplicate > 1);
        CREATE UNIQUE INDEX IF NOT EXISTS domains_account_zone ON domains(account_id, zone_id)`);
      this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("schema_version", "3");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async init() {
    if (!this.key) {
      if (!this.keyPath) this.key = randomBytes(32);
      else {
        try {
          const file = await open(this.keyPath, "wx", 0o600);
          try { await file.writeFile(randomBytes(32)); } finally { await file.close(); }
        } catch (error) { if (error.code !== "EEXIST") throw error; }
        await chmod(this.keyPath, 0o600);
        this.key = await readFile(this.keyPath);
        if (this.key.length !== 32) throw new Error("KwikEmail encryption key must be 32 bytes");
      }
    }
    const admin = this.db.prepare("SELECT password_changed FROM admin WHERE id = 1").get();
    if (!admin || !admin.password_changed) {
      const salt = randomBytes(16).toString("hex"), hash = await scryptAsync("123456", salt);
      this.db.exec("BEGIN");
      try {
        this.db.prepare("INSERT INTO admin VALUES (1, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, password_salt=excluded.password_salt").run(hash.toString("hex"), salt);
        this.db.prepare("DELETE FROM settings WHERE key = 'bootstrap_password'").run();
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    return this;
  }

  getSetting(key) { return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value; }
  setSetting(key, value) { this.db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)); }
  adminState() { const row = this.db.prepare("SELECT password_changed FROM admin WHERE id = 1").get(); return row && { password_changed: Boolean(row.password_changed) }; }
  async verifyPassword(password) {
    const row = this.db.prepare("SELECT password_hash, password_salt FROM admin WHERE id = 1").get();
    if (!row) return false;
    const actual = await scryptAsync(password, row.password_salt), expected = Buffer.from(row.password_hash, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  async changePassword(password) {
    if (!password) throw new Error("Password is required");
    const salt = randomBytes(16).toString("hex"), hash = await scryptAsync(password, salt);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE admin SET password_hash = ?, password_salt = ?, password_changed = 1 WHERE id = 1").run(hash.toString("hex"), salt);
      this.db.prepare("DELETE FROM sessions").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  hashToken(token) { return createHash("sha256").update(token).digest("hex"); }
  createSession(ttl = 86_400_000) {
    const token = randomBytes(32).toString("base64url"), now = Date.now();
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(this.hashToken(token), now + ttl, now);
    return token;
  }
  validateSession(token) {
    if (!token) return false;
    const hash = this.hashToken(token), row = this.db.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?").get(hash);
    if (!row || row.expires_at <= Date.now()) { this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hash); return false; }
    return true;
  }
  deleteSession(token) { if (token) this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(this.hashToken(token)); }

  encrypt(value) {
    if (!this.key) throw new Error("Archive.init() is required");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
  }
  decrypt(value) {
    if (!this.key) throw new Error("Archive.init() is required");
    const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  saveCredential(input) {
    if (!["api_token", "wrangler_oauth"].includes(input.type)) throw new Error("Invalid credential type");
    const old = input.id && this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(input.id), now = Date.now(), id = input.id || randomUUID();
    const encrypted = input.value === undefined ? old?.encrypted_value ?? null : this.encrypt(input.value);
    this.db.prepare(`INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, encrypted_value=excluded.encrypted_value, wrangler_profile=excluded.wrangler_profile, updated_at=excluded.updated_at`).run(id, input.type, input.name, encrypted, input.wrangler_profile ?? old?.wrangler_profile ?? null, old?.created_at ?? now, now);
    return this.getCredential(id);
  }
  getCredential(id) { const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id); return row && { ...row, value: row.encrypted_value ? this.decrypt(row.encrypted_value) : null, encrypted_value: undefined }; }
  listCredentials() { return this.db.prepare("SELECT id, type, name, wrangler_profile, created_at, updated_at FROM credentials ORDER BY created_at").all(); }
  deleteCredential(id) { this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id); }

  saveAccount(input) {
    const old = input.id && this.getAccount(input.id), now = Date.now(), id = input.id || randomUUID(), row = { ...old, ...input, id, created_at: old?.created_at ?? now };
    const bootstrap = input.bootstrap_key === undefined ? old?.bootstrap_key_encrypted ?? null : this.encrypt(input.bootstrap_key);
    this.db.prepare(`INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET credential_id=excluded.credential_id, cloudflare_account_id=excluded.cloudflare_account_id, name=excluded.name, worker_name=excluded.worker_name, worker_url=excluded.worker_url, d1_database_id=excluded.d1_database_id, d1_database_name=excluded.d1_database_name, bootstrap_key_encrypted=excluded.bootstrap_key_encrypted, status=excluded.status, last_error=excluded.last_error, updated_at=excluded.updated_at`).run(id, row.credential_id, row.cloudflare_account_id, row.name, row.worker_name ?? null, row.worker_url ?? null, row.d1_database_id ?? null, row.d1_database_name ?? null, bootstrap, row.status, row.last_error ?? null, row.created_at, now);
    return this.getAccount(id);
  }
  getAccount(id) { return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id); }
  listAccounts() { return this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all(); }
  getBootstrapKey(id) { const value = this.getAccount(id)?.bootstrap_key_encrypted; return value ? this.decrypt(value) : null; }
  deleteAccount(id) { this.db.prepare("DELETE FROM emails WHERE account_id = ?").run(id); this.db.prepare("DELETE FROM domains WHERE account_id = ?").run(id); this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); }

  saveDomain(input) {
    const old = input.id ? this.getDomain(input.id) : this.db.prepare("SELECT * FROM domains WHERE account_id = ? AND zone_id = ?").get(input.account_id, input.zone_id), now = Date.now(), id = old?.id || input.id || randomUUID(), row = { ...old, ...input, id, created_at: old?.created_at ?? now };
    this.db.prepare(`INSERT INTO domains VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, zone_id=excluded.zone_id, name=excluded.name, routing_rule_id=excluded.routing_rule_id, routing_status=excluded.routing_status, enabled=excluded.enabled, updated_at=excluded.updated_at`).run(id, row.account_id, row.zone_id, row.name, row.routing_rule_id ?? null, row.routing_status, row.enabled ? 1 : 0, row.created_at, now);
    return this.getDomain(id);
  }
  getDomain(id) { return this.db.prepare("SELECT * FROM domains WHERE id = ?").get(id); }
  listDomains(accountId) { return this.db.prepare("SELECT * FROM domains WHERE account_id = ? ORDER BY created_at").all(accountId); }
  deleteDomain(id) { this.db.prepare("DELETE FROM domains WHERE id = ?").run(id); }

  upsert(accountId, address, emails) {
    if (emails === undefined) [accountId, address, emails] = [LEGACY_ACCOUNT_ID, accountId, address];
    this.db.exec("BEGIN");
    try { for (const email of emails) this.put.run(accountId, email.id, address, JSON.stringify(email), email.received_at); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  list(accountId, address) {
    if (address === undefined) [accountId, address] = [LEGACY_ACCOUNT_ID, accountId];
    return this.db.prepare("SELECT data FROM emails WHERE account_id = ? AND address = ? ORDER BY received_at DESC").all(accountId, address).map(({ data }) => JSON.parse(data));
  }
  purge(accountId, address) {
    if (address === undefined) [accountId, address] = [LEGACY_ACCOUNT_ID, accountId];
    this.db.prepare("DELETE FROM emails WHERE account_id = ? AND address = ?").run(accountId, address);
  }
  close() { this.db.close(); }
}

export const mergeEmails = (local, cloud) => [...new Map([...local, ...cloud].map((x) => [x.id, x])).values()].sort((a, b) => b.received_at - a.received_at);
export function tagStorage(cloud, merged) { const cloudIds = new Set(cloud.map((x) => x.id)); return merged.map((x) => ({ ...x, storage: cloudIds.has(x.id) ? "cloud" : "local" })); }
export function serialize() { let queue = Promise.resolve(); return (operation) => queue = queue.then(operation, operation); }
export async function syncArchive(archive, accountId, api) {
  if (!api) [accountId, api] = [LEGACY_ACCOUNT_ID, accountId];
  for (const { address } of await api("/addresses")) archive.upsert(accountId, address, await api("/emails?address=" + encodeURIComponent(address)));
}
export function scheduleSync(sync, timer = setInterval) { Promise.resolve().then(sync).catch(console.error); return timer(() => Promise.resolve(sync()).catch(console.error), 3_600_000); }
