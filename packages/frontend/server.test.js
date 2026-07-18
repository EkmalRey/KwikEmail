import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const database = join(tmpdir(), `kwikemail-server-test-${process.pid}.sqlite`);
process.env.KWIKEMAIL_DB_PATH = database;
const { cookieValue, safeAccount, readBody } = await import("./server.js");
const source = await readFile(new URL("./server.js", import.meta.url), "utf8");

test.after(async () => {
  await rm(database, { force: true });
  await rm(database.replace(/\.[^/.]+$/, "") + ".key", { force: true });
});

test("cookie parsing matches the exact cookie name", () => {
  assert.equal(cookieValue("not_kwikemail_admin=wrong; kwikemail_admin=right", "kwikemail_admin"), "right");
  assert.equal(cookieValue("not_kwikemail_admin=wrong", "kwikemail_admin"), undefined);
  assert.equal(cookieValue("kwikemail_admin=a%2Fb", "kwikemail_admin"), "a/b");
});

test("safe accounts omit encrypted and decrypted secrets", () => {
  const account = safeAccount({ id: "a", name: "Home", status: "ready", bootstrap_key_encrypted: "secret", worker_url: "https://worker" }, { id: "c", type: "api_token", name: "Token", value: "secret", encrypted_value: "secret" }, [{ name: "example.com" }]);
  assert.deepEqual(account, { id: "a", cloudflare_account_id: undefined, name: "Home", worker_name: undefined, worker_url: "https://worker", d1_database_id: undefined, d1_database_name: undefined, status: "ready", last_error: undefined, created_at: undefined, updated_at: undefined, credential: { id: "c", type: "api_token", name: "Token", wrangler_profile: undefined, created_at: undefined, updated_at: undefined }, domains: [{ name: "example.com" }] });
  assert.doesNotMatch(JSON.stringify(account), /secret/);
});

test("request bodies are capped at 1 MiB", async () => {
  const { EventEmitter } = await import("node:events");
  const request = new EventEmitter();
  request.resume = () => { request.resumed = true; };
  const result = assert.rejects(readBody(request), (error) => error.httpStatus === 413);
  request.emit("data", Buffer.alloc(1_048_577));
  await result;
  assert.equal(request.resumed, true);
});

test("login and forced reset use database sessions and rotate the cookie", () => {
  assert.match(source, /archiveStore\.verifyPassword\(password\)/);
  assert.match(source, /archiveStore\.createSession\(\)/);
  assert.match(source, /archiveStore\.validateSession\(session\)/);
  assert.match(source, /archiveStore\.changePassword\(newPassword\)[\s\S]*archiveStore\.createSession\(\)/);
  assert.match(source, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=/);
  assert.match(source, /password_changed[\s\S]*setup\.html/);
  assert.match(source, /process\.env\.HOST \|\| "127\.0\.0\.1"/);
});

test("setup and control routes enforce password replacement", () => {
  assert.match(source, /requireChanged/);
  for (const route of ["/setup/cloudflare/token", "/setup/cloudflare/oauth/start", "/setup/cloudflare/oauth/callback", "/setup/cloudflare/accounts", "/setup/cloudflare/routing-readiness", "/setup/accounts", "/control/accounts"]) assert.ok(source.includes(route));
  assert.match(source, /setup action is forbidden/);
});

test("server applies browser security controls", () => {
  for (const header of ["Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) assert.ok(source.includes(header));
  assert.match(source, /cross-origin request denied/);
  assert.match(source, /url\.pathname === "\/logout" && req\.method === "POST"/);
  assert.match(source, /Set-Cookie", \[sessionCookie\("", 0\), legacySessionCookie\(\)\]/);
  assert.match(source, /COOKIE_SECURE === "true" \? "; Secure"/);
  assert.match(source, /url\.pathname === "\/health" && req\.method === "GET"/);
});

test("deployment is rejected until every selected domain has ready Email Routing", () => {
  assert.match(source, /const readiness = await cloudflare\.routingReadiness/);
  assert.match(source, /if \(!readiness\.ready\) throw fail\(409, "Email Routing is not ready for every selected domain"\)/);
});

test("repeated onboarding reuses the Cloudflare account, bootstrap key, and domain rows", () => {
  assert.match(source, /listAccounts\(\)\.find\(\(\{ cloudflare_account_id \}\) => cloudflare_account_id === found\.id\)/);
  assert.match(source, /saveAccount\(\{ \.\.\.existing, credential_id: credential\.id/);
  assert.match(source, /listDomains\(account\.id\)\.find\(\(\{ zone_id \}\) => zone_id === zone\.id\)/);
});

test("account proxy resolves worker credentials and scopes archive operations", () => {
  assert.match(source, /pathname\.match\(\/\^\\\/api\\\/accounts/);
  assert.match(source, /archive\.getBootstrapKey\(account\.id\)/);
  assert.match(source, /archiveStore\.upsert\(accountId, address, cloud\)/);
  assert.match(source, /archiveStore\.list\(accountId, address\)/);
  assert.match(source, /archiveStore\.purge\(accountId, address\)/);
  assert.match(source, /AbortSignal\.timeout\(65_000\)/);
});

test("account display names can be changed without renaming Cloudflare resources", () => {
  assert.match(source, /accountMatch && req\.method === "PATCH"/);
  assert.match(source, /name\.length > 80/);
  assert.match(source, /saveAccount\(\{ \.\.\.account, name \}\)/);
});

test("authenticated password changes verify the current password and rotate the session", () => {
  assert.match(source, /url\.pathname === "\/control\/password" && req\.method === "POST"/);
  assert.match(source, /verifyPassword\(currentPassword \|\| ""\)/);
  assert.match(source, /newPassword\.length < 10/);
  assert.match(source, /newPassword !== body\.confirmation/);
  assert.match(source, /changePassword\(newPassword\)[\s\S]*createSession\(\)[\s\S]*Set-Cookie/);
});

test("account deletion requires worker-name confirmation and cleans Cloudflare before local state", () => {
  assert.match(source, /body\.confirm !== account\.worker_name/);
  assert.match(source, /cloudflare\.deleteDeployment[\s\S]*archiveStore\.deleteAccount/);
  assert.match(source, /listAccounts\(\)\.some\(\(\{ credential_id \}\)/);
  assert.match(source, /setSetting\("setup_complete", false\)/);
});

test("jobs stream status and close at terminal states", () => {
  assert.match(source, /Content-Type", "text\/event-stream/);
  assert.match(source, /event: status/);
  assert.match(source, /ready|error/);
  assert.match(source, /jobs\.size[\s\S]*jobs\.delete/);
});

test("root keeps incomplete installations in setup", () => {
  assert.match(source, /!changed \|\| !setupComplete\(archiveStore\)/);
  assert.match(source, /\["\/", "\/index\.html", "\/setup\.html"\]/);
});

test("server uses the new persistence and controller APIs without singleton deployment env constants", () => {
  assert.match(source, /await new Archive\(await defaultArchivePath\(\)\)\.init\(\)/);
  assert.match(source, /new CloudflareController/);
  assert.doesNotMatch(source, /ADMIN_PASSWORD|const (?:KEY|BASE)\s*=/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:body|token|callback)/i);
  assert.match(source, /cookieValue\(req\.headers\.cookie\) \|\| cookieValue\(req\.headers\.cookie, "tpk_admin"\)/);
  assert.doesNotMatch(source, /FLASHMAIL_API_KEY|FLASHMAIL_BASE_URL|import-legacy/);
});
