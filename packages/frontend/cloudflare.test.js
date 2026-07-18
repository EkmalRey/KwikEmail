import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CloudflareController, CloudflareError, deployedWorkerUrl, deploymentCommands, generateWranglerConfig, oauthCommand, parseDeployOutput, preferredWorkersDevName } from "./cloudflare.js";

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const child = (chunks = [], code = 0) => { const value = new EventEmitter(); value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = () => {}; queueMicrotask(() => { chunks.forEach((chunk) => value.stdout.emit("data", Buffer.from(chunk))); value.emit("close", code, null); }); return value; };

test("builds Wrangler 4.110 named profile commands", () => {
  assert.deepEqual(oauthCommand("/backend/node_modules/.bin/wrangler", "kwikemail_home", 42123), { command: "/backend/node_modules/.bin/wrangler", args: ["auth", "create", "kwikemail_home", "--browser=false", "--callback-host=127.0.0.1", "--callback-port=42123"] });
  assert.throws(() => oauthCommand("wrangler", "bad profile", 1), /profile name/);
});

test("validates Cloudflare envelopes and exposes API errors", async () => {
  const controller = new CloudflareController({ fetch: async () => response({ success: false, errors: [{ code: 9109, message: "Invalid token" }] }, 403) });
  await assert.rejects(controller.api("secret", "/accounts"), (error) => error instanceof CloudflareError && error.status === 403 && error.errors[0].code === 9109 && !error.message.includes("secret"));
  await assert.rejects(new CloudflareController({ fetch: async () => response({ result: [] }) }).api("token", "/accounts"), /failed/);
});

test("verifies token and discovers paginated accounts and zones", async () => {
  const calls = []; const fetch = async (url, options) => { calls.push([url, options]); if (url.includes("tokens/verify")) return response({ success: true, errors: [], result: { status: "active" } }); if (url.includes("/accounts?")) return response({ success: true, errors: [], result: [{ id: "a1" }], result_info: { total_pages: 1 } }); return response({ success: true, errors: [], result: [{ id: "z1", name: "example.com" }], result_info: { total_pages: 1 } }); };
  const found = await new CloudflareController({ fetch }).discover("bearer");
  assert.equal(found.accounts[0].id, "a1"); assert.equal(found.zones.a1[0].name, "example.com"); assert.equal(calls[0][1].headers.Authorization, "Bearer bearer"); assert.equal(calls.every(([, options]) => options.redirect === "error"), true);
  calls.length = 0;
  await new CloudflareController({ fetch }).discover("oauth-bearer", false);
  assert.equal(calls.some(([url]) => url.includes("tokens/verify")), false);
});

test("generates JSON config and parses Wrangler NDJSON", () => {
  const config = generateWranglerConfig({ workerName: "kwikemail-a1", accountId: "a1", d1Name: "db-a1", d1Id: "d1", backendRoot: "/opt/backend" });
  assert.deepEqual(config.d1_databases, [{ binding: "DB", database_name: "db-a1", database_id: "d1", migrations_dir: "/opt/backend/migrations" }]); assert.equal(config.main, "/opt/backend/src/index.ts");
  assert.deepEqual(parseDeployOutput('{"type":"log"}\n{"type":"deploy","worker_name":"kwikemail-a1","version_id":"v1","targets":["https://kwikemail-a1.foo.workers.dev"]}\n'), { workerName: "kwikemail-a1", versionId: "v1", targets: ["https://kwikemail-a1.foo.workers.dev"] });
  assert.throws(() => parseDeployOutput("not json"), /deploy result/);
  assert.equal(deployedWorkerUrl({ targets: ["https://reported.foo.workers.dev"] }, "kwikemail-a1", "fallback"), "https://reported.foo.workers.dev");
  assert.equal(deployedWorkerUrl({ targets: [] }, "kwikemail-a1", "fallback"), "https://kwikemail-a1.fallback.workers.dev");
  assert.equal(preferredWorkersDevName(undefined, "kwikemail-a1"), "kwikemail-a1");
  assert.equal(preferredWorkersDevName("chosen", "kwikemail-a1"), "chosen");
  assert.deepEqual(deploymentCommands({ d1Name: "db-a1", configPath: "/data/job/wrangler.json", secretsPath: "/data/job/secrets.json" }), {
    migrate: ["d1", "migrations", "apply", "db-a1", "--remote", "--config", "/data/job/wrangler.json"],
    deploy: ["deploy", "--minify", "--config", "/data/job/wrangler.json", "--secrets-file", "/data/job/secrets.json"],
  });
});

test("OAuth strips credentials, rejects SSRF, and forwards callback once", async () => {
  const spawns = [], fetches = []; let oauthChild, killed = 0;
  const spawn = (command, args, options) => { spawns.push({ command, args, options }); const spawned = oauthChild = new EventEmitter(); spawned.stdout = new EventEmitter(); spawned.stderr = new EventEmitter(); spawned.kill = () => { killed++; queueMicrotask(() => spawned.emit("close", 143, "SIGTERM")); }; queueMicrotask(() => { spawned.stdout.emit("data", Buffer.from("Visit this link to auth")); spawned.stdout.emit("data", Buffer.from("enticate: https://dash.cloudflare.com/oauth2/auth?state=hidden\n")); }); return spawned; };
  const controller = new CloudflareController({ spawn, backendRoot: "/backend", dataRoot: "/data", createServer: () => ({ once() {}, listen(_port, _host, ready) { ready(); }, address() { return { port: 45678 }; }, close(done) { done(); } }), fetch: async (url, options) => { fetches.push([url, options]); queueMicrotask(() => oauthChild.emit("close", 0, null)); return { status: 302 }; }, setTimeout: () => 1, clearTimeout: () => {} });
  process.env.CLOUDFLARE_API_TOKEN = "must-not-leak"; const replaced = await controller.startOAuth("flashmail-old"); const started = await controller.startOAuth("flashmail-test"); delete process.env.CLOUDFLARE_API_TOKEN;
  assert.equal(killed, 1); await assert.rejects(controller.forwardOAuthCallback(replaced.id, "http://localhost:8976/oauth/callback?code=old"), /missing|expired/);
  assert.equal(spawns[0].options.env.CLOUDFLARE_API_TOKEN, undefined); assert.equal(spawns[0].options.env.XDG_CONFIG_HOME, "/data"); assert.equal(spawns[0].options.env.WRANGLER_WRITE_LOGS, "false"); assert.equal(spawns[0].options.env.WRANGLER_LOG, undefined);
  await assert.rejects(controller.forwardOAuthCallback(started.id, "http://169.254.169.254:8976/oauth/callback?code=x"), /must be/);
  await assert.rejects(controller.forwardOAuthCallback(started.id, "http://localhost:8976/not-callback?code=x"), /must be/);
  assert.deepEqual(await controller.forwardOAuthCallback(started.id, "http://localhost:8976/oauth/callback?code=secret&state=s"), { profile: "flashmail-test", authenticated: true });
  assert.equal(fetches[0][0], "http://127.0.0.1:45678/oauth/callback?code=secret&state=s"); assert.equal(fetches[0][1].redirect, "manual");
  await assert.rejects(controller.forwardOAuthCallback(started.id, "http://localhost:8976/oauth/callback?code=again"), /already used|missing/);
});

test("OAuth bearer uses the named profile with credential environment stripped", async () => {
  let invocation; const controller = new CloudflareController({ backendRoot: "/backend", spawn(command, args, options) { invocation = { command, args, options }; return child(['{"type":"oauth","token":"oauth-secret"}']); } });
  process.env.CF_API_TOKEN = "wrong"; assert.equal(await controller.oauthToken("home"), "oauth-secret"); delete process.env.CF_API_TOKEN;
  assert.deepEqual(invocation.args, ["auth", "token", "--json", "--profile", "home"]); assert.equal(invocation.options.env.CF_API_TOKEN, undefined);
});

test("Wrangler failures include sanitized output", async () => {
  const controller = new CloudflareController({ backendRoot: "/backend", spawn: () => child(["\u001b[31mMigration failed for tpk_secret and cfoat_secret\u001b[0m"], 1) });
  await assert.rejects(controller.runWrangler(["deploy"]), (error) => /Migration failed for \[redacted\] and \[redacted\]/.test(error.message) && !error.message.includes("\u001b") && !error.message.includes("secret"));
});

test("credential resolution accepts API tokens and rejects incomplete credentials", async () => {
  const controller = new CloudflareController();
  assert.equal(await controller.resolveToken({ type: "api_token", token: "api-secret" }), "api-secret");
  await assert.rejects(controller.resolveToken({ type: "api_token" }), /Unsupported/);
});

test("new Workers wait for workers.dev propagation", async () => {
  let attempts = 0; const controller = new CloudflareController({ fetch: async () => { attempts++; if (attempts < 3) throw new Error("TLS not ready"); return response({}); }, setTimeout: (fn) => { queueMicrotask(fn); return 1; } });
  await controller.waitForWorker("https://worker.example");
  assert.equal(attempts, 3);
});

test("deployment deletion detaches routing before deleting Worker and D1", async () => {
  const requests = []; const fetch = async (url, options = {}) => { requests.push([url, options]); if (url.endsWith("/catch_all") && !options.method) return response({ success: true, errors: [], result: { id: "catch", name: "", enabled: true, priority: 9, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["flashmail-a1"] }] } }); if (url.includes("/rules?") && !options.method) return response({ success: true, errors: [], result: [], result_info: { total_pages: 1 } }); return response({ success: true, errors: [], result: {} }); };
  await new CloudflareController({ fetch }).deleteDeployment("token", { cloudflare_account_id: "a1", worker_name: "flashmail-a1", d1_database_id: "d1" }, [{ zone_id: "z1" }]);
  assert.deepEqual(requests.filter(([, options]) => options.method).map(([url, options]) => [url.split("/client/v4")[1], options.method]), [["/zones/z1/email/routing/rules/catch_all", "PUT"], ["/accounts/a1/workers/scripts/flashmail-a1", "DELETE"], ["/accounts/a1/d1/database/d1", "DELETE"]]);
  assert.deepEqual(JSON.parse(requests[1][1].body).actions, [{ type: "drop" }]);
});

test("routing readiness requires enabled, synced, ready domains", async () => {
  const fetch = async (url) => response({ success: true, errors: [], result: url.includes("z1") ? { enabled: true, synced: true, status: "ready" } : { enabled: false, synced: false, status: "pending" } });
  const result = await new CloudflareController({ fetch }).routingReadiness("token", "a1", [{ id: "z1", name: "ready.example" }, { id: "z2", name: "pending.example" }]);
  assert.equal(result.ready, false); assert.equal(result.domains[0].ready, true); assert.equal(result.domains[1].ready, false); assert.equal(result.dashboardUrl, "https://dash.cloudflare.com/a1/email-service/routing");
});

test("routing preserves an existing catch-all", async () => {
  const requests = []; const controller = new CloudflareController({ fetch: async (url, options = {}) => { requests.push([url, options]); if (url.endsWith("/email/routing")) return response({ success: true, errors: [], result: { enabled: true } }); return response({ success: true, errors: [], result: [{ id: "old", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["owner@example.com"] }] }], result_info: { total_pages: 1 } }); } });
  assert.equal((await controller.configureRouting("token", { id: "z1", name: "example.com" }, "flashmail-a1")).status, "manual"); assert.equal(requests.some(([, options]) => options.method === "POST"), false);
});
