import { spawn as nodeSpawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const CREDENTIAL_ENV = /^(?:CF_|CLOUDFLARE_).*(?:TOKEN|KEY|EMAIL|AUTH)$/i;
let oauthJob;
let deployment = Promise.resolve();

export class CloudflareError extends Error {
  constructor(message, { status, errors = [], path } = {}) {
    super(message); this.name = "CloudflareError"; this.status = status; this.errors = errors; this.path = path;
  }
}

const array = (value) => Array.isArray(value) ? value : [];
const cleanEnv = (source = process.env) => ({ ...Object.fromEntries(Object.entries(source).filter(([key]) => !CREDENTIAL_ENV.test(key))), WRANGLER_WRITE_LOGS: "false" });
const validProfile = (name) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("OAuth profile name must contain only letters, numbers, '_' or '-'");
  return name;
};

export const oauthCommand = (wrangler, name, port) => ({ command: wrangler, args: ["auth", "create", validProfile(name), "--browser=false", "--callback-host=127.0.0.1", `--callback-port=${port}`] });

export const deploymentCommands = ({ d1Name, configPath, secretsPath }) => ({
  migrate: ["d1", "migrations", "apply", d1Name, "--remote", "--config", configPath],
  deploy: ["deploy", "--minify", "--config", configPath, "--secrets-file", secretsPath],
});

export const generateWranglerConfig = ({ workerName, accountId, d1Name, d1Id, backendRoot }) => ({
  name: workerName, account_id: accountId, main: resolve(backendRoot, "src/index.ts"), compatibility_date: "2025-06-01",
  compatibility_flags: ["nodejs_compat"], workers_dev: true, observability: { enabled: true },
  d1_databases: [{ binding: "DB", database_name: d1Name, database_id: d1Id, migrations_dir: resolve(backendRoot, "migrations") }],
  triggers: { crons: ["0 * * * *"] },
});

export function parseDeployOutput(text) {
  const entries = String(text || "").split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const entry = entries.findLast((item) => item.type === "deploy");
  if (!entry) throw new Error("Wrangler did not produce a deploy result");
  return { workerName: entry.worker_name, versionId: entry.version_id, targets: array(entry.targets) };
}

export const deployedWorkerUrl = (deployResult, workerName, subdomain) => deployResult.targets.find((target) => /^https:\/\/[^/]+\.workers\.dev\/?$/.test(target))?.replace(/\/$/, "") || `https://${workerName}.${subdomain}.workers.dev`;
export const preferredWorkersDevName = (requested, workerName) => requested || workerName;

function childResult(child, { capture = false, onOutput } = {}) {
  return new Promise((resolveResult, reject) => {
    let output = "";
    const collect = (chunk) => {
      const value = chunk.toString();
      if (capture && output.length < 262_144) output += value.slice(0, 262_144 - output.length);
      onOutput?.(value);
    };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect); child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolveResult(output);
      const detail = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/(?:cfoat_|kwe_|tpk_)[A-Za-z0-9._-]+/g, "[redacted]").trim().split("\n").filter(Boolean).slice(-6).join(" ");
      reject(new Error(`Wrangler exited with ${code ?? signal ?? "unknown status"}${detail ? `: ${detail}` : ""}`));
    });
  });
}

export class CloudflareController {
  constructor({ fetch: fetchImpl = globalThis.fetch, spawn = nodeSpawn, createServer: server = createServer, backendRoot = resolve(process.cwd(), "../backend"), dataRoot = "/data", apiBase = API, now = Date.now, setTimeout: timer = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
    Object.assign(this, { fetch: fetchImpl, spawn, createServer: server, backendRoot, dataRoot, apiBase, now, setTimeout: timer, clearTimeout: clear });
    this.wrangler = resolve(backendRoot, "node_modules/.bin/wrangler");
  }

  async api(token, path, options = {}) {
    if (!token) throw new Error("Cloudflare credential is required");
    const response = await this.fetch(`${this.apiBase}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body && { "Content-Type": "application/json" }), ...options.headers }, redirect: "error" });
    let envelope;
    try { envelope = await response.json(); } catch { throw new CloudflareError(`Cloudflare API returned invalid JSON (${response.status})`, { status: response.status, path }); }
    if (!response.ok || envelope?.success !== true || !Array.isArray(envelope.errors)) {
      const errors = array(envelope?.errors); const detail = errors.map((error) => [error.code, error.message].filter(Boolean).join(": ")).join("; ");
      throw new CloudflareError(`Cloudflare API ${path} failed${detail ? `: ${detail}` : ` (${response.status})`}`, { status: response.status, errors, path });
    }
    return envelope;
  }

  async list(token, path) {
    const result = [];
    for (let page = 1; ; page++) {
      const envelope = await this.api(token, `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`);
      result.push(...array(envelope.result));
      if (!envelope.result_info || page >= (envelope.result_info.total_pages || 1)) return result;
    }
  }

  async verifyToken(token) {
    const { result } = await this.api(token, "/user/tokens/verify");
    if (result?.status !== "active") throw new CloudflareError(`Cloudflare API token is ${result?.status || "not active"}`);
    return result;
  }
  discoverAccounts(token) { return this.list(token, "/accounts"); }
  discoverZones(token, accountId) { return this.list(token, `/zones?account.id=${encodeURIComponent(accountId)}&status=active`); }
  async discover(token, verify = true) {
    const verification = verify ? await this.verifyToken(token) : { status: "active" }; const accounts = await this.discoverAccounts(token);
    const zones = Object.fromEntries(await Promise.all(accounts.map(async (account) => [account.id, await this.discoverZones(token, account.id)])));
    return { verification, accounts, zones };
  }

  allocatePort() {
    return new Promise((resolvePort, reject) => {
      const server = this.createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolvePort(port)); });
    });
  }

  async startOAuth(name) {
    if (oauthJob) { this.clearTimeout(oauthJob.expires); oauthJob.child.kill("SIGTERM"); oauthJob = undefined; }
    const port = await this.allocatePort(); const command = oauthCommand(this.wrangler, name, port);
    const env = { ...cleanEnv(), FORCE_COLOR: "0", XDG_CONFIG_HOME: this.dataRoot, CLOUDFLARE_AUTH_USE_KEYRING: "false" };
    const child = this.spawn(command.command, command.args, { cwd: this.backendRoot, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const id = randomUUID(); let authorizationUrl, oauthOutput = "", readyResolve, readyReject;
    const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
    const done = childResult(child, { onOutput(chunk) { oauthOutput = (oauthOutput + chunk).slice(-16_384); const match = oauthOutput.match(/Visit this link to authenticate:\s*(https:\/\/\S+)/); if (match && !authorizationUrl) { authorizationUrl = match[1]; oauthOutput = ""; readyResolve(); } } });
    const expires = this.setTimeout(() => child.kill("SIGTERM"), 120_000);
    oauthJob = { id, name, port, child, done, expires, used: false, expiresAt: this.now() + 120_000 };
    done.catch(readyReject).finally(() => { this.clearTimeout(expires); if (oauthJob?.id === id) oauthJob = undefined; });
    try { await Promise.race([ready, new Promise((_, reject) => this.setTimeout(() => reject(new Error("Wrangler did not provide an authorization URL")), 10_000))]); }
    catch (error) { child.kill("SIGTERM"); if (oauthJob?.id === id) oauthJob = undefined; throw error; }
    return { id, name, authorizationUrl, expiresAt: oauthJob.expiresAt };
  }

  async forwardOAuthCallback(id, pastedUrl) {
    const job = oauthJob;
    if (!job || job.id !== id || job.used || job.expiresAt <= this.now()) throw new Error("OAuth transaction is missing, expired, or already used");
    let url; try { url = new URL(pastedUrl); } catch { throw new Error("Invalid OAuth callback URL"); }
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname.toLowerCase()) || Number(url.port || 80) !== 8976 || url.pathname !== "/oauth/callback" || url.username || url.password) throw new Error("OAuth callback must be http://localhost:8976/oauth/callback");
    job.used = true;
    let response;
    try {
      response = await this.fetch(`http://127.0.0.1:${job.port}/oauth/callback${url.search}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      await job.done;
    } catch (error) { job.child.kill("SIGTERM"); throw new Error(`OAuth callback failed: ${error.message}`); }
    if (response.status < 200 || response.status >= 400) throw new Error(`OAuth callback failed (${response.status})`);
    return { profile: job.name, authenticated: true };
  }

  async oauthToken(profile) {
    const child = this.spawn(this.wrangler, ["auth", "token", "--json", "--profile", validProfile(profile)], { cwd: this.backendRoot, env: { ...cleanEnv(), FORCE_COLOR: "0", XDG_CONFIG_HOME: this.dataRoot, CLOUDFLARE_AUTH_USE_KEYRING: "false" }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const output = await childResult(child, { capture: true }); let value;
    try { value = JSON.parse(output); } catch { throw new Error("Wrangler returned an invalid credential response"); }
    if (value.type !== "oauth" || !value.token) throw new Error("Wrangler profile did not return an OAuth bearer token");
    return value.token;
  }
  async resolveToken(credential) {
    if (credential?.type === "api_token" && credential.token) return credential.token;
    if (credential?.type === "wrangler_oauth" && credential.profile) return this.oauthToken(credential.profile);
    throw new Error("Unsupported Cloudflare credential");
  }

  async runWrangler(args, { token, env = {}, capture = false } = {}) {
    const child = this.spawn(this.wrangler, args, { cwd: this.backendRoot, env: { ...cleanEnv(), FORCE_COLOR: "0", XDG_CONFIG_HOME: this.dataRoot, CLOUDFLARE_AUTH_USE_KEYRING: "false", CI: "1", ...(token && { CLOUDFLARE_API_TOKEN: token }), ...env }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    return childResult(child, { capture: true }).then((output) => capture ? output : "");
  }

  async ensureD1(token, accountId, name, existingId) {
    if (existingId) return { uuid: existingId, name };
    const found = (await this.list(token, `/accounts/${accountId}/d1/database`)).find((database) => database.name === name);
    return found || (await this.api(token, `/accounts/${accountId}/d1/database`, { method: "POST", body: JSON.stringify({ name }) })).result;
  }

  async workersDev(token, accountId, requested) {
    try { return (await this.api(token, `/accounts/${accountId}/workers/subdomain`)).result.subdomain; } catch (error) {
      if (!(error instanceof CloudflareError) || !error.errors.some(({ code }) => code === 10007)) throw error;
    }
    if (!requested) throw new Error(`No workers.dev subdomain exists. Choose an available name or register one at https://dash.cloudflare.com/${accountId}/workers/onboarding`);
    try { await this.api(token, `/accounts/${accountId}/workers/subdomains/${encodeURIComponent(requested)}`); } catch (error) {
      if (!(error instanceof CloudflareError) || !error.errors.some(({ code }) => code === 10032)) throw new Error(`workers.dev subdomain '${requested}' is unavailable; choose another name`);
    }
    return (await this.api(token, `/accounts/${accountId}/workers/subdomain`, { method: "PUT", body: JSON.stringify({ subdomain: requested }) })).result.subdomain;
  }

  async deleteDeployment(token, account, zones) {
    for (const zone of zones) {
      const path = `/zones/${zone.zone_id}/email/routing/rules`;
      const targets = (rule) => array(rule.actions).some((action) => action.type === "worker" && array(action.value).includes(account.worker_name));
      const catchAll = (await this.api(token, `${path}/catch_all`)).result;
      if (targets(catchAll)) await this.api(token, `${path}/catch_all`, { method: "PUT", body: JSON.stringify({ name: catchAll.name || "Catch-all", enabled: false, matchers: catchAll.matchers, actions: [{ type: "drop" }], priority: catchAll.priority, source: "api" }) });
      for (const rule of await this.list(token, path)) if (!array(rule.matchers).some(({ type }) => type === "all") && targets(rule)) await this.api(token, `${path}/${rule.id}`, { method: "DELETE" });
    }
    await this.api(token, `/accounts/${account.cloudflare_account_id}/workers/scripts/${encodeURIComponent(account.worker_name)}`, { method: "DELETE" });
    await this.api(token, `/accounts/${account.cloudflare_account_id}/d1/database/${encodeURIComponent(account.d1_database_id)}`, { method: "DELETE" });
  }

  async waitForWorker(url) {
    let error;
    for (let attempt = 0; attempt < 12; attempt++) {
      try { const response = await this.fetch(`${url}/health`, { redirect: "error" }); if (response.ok) return; error = new Error(`Worker health check returned ${response.status}`); }
      catch (reason) { error = reason; }
      await new Promise((resolveWait) => this.setTimeout(resolveWait, 5_000));
    }
    throw new Error(`Worker did not become reachable: ${error?.message || "unknown error"}`);
  }

  async routingReadiness(token, accountId, zones) {
    const domains = await Promise.all(zones.map(async (zone) => {
      try { const result = (await this.api(token, `/zones/${zone.id}/email/routing`)).result; return { id: zone.id, name: zone.name, enabled: result.enabled === true, synced: result.synced === true, status: result.status, ready: result.enabled === true && result.synced === true && result.status === "ready" }; }
      catch (error) { return { id: zone.id, name: zone.name, ready: false, error: error.message }; }
    }));
    return { ready: domains.every(({ ready }) => ready), domains, dashboardUrl: `https://dash.cloudflare.com/${accountId}/email-service/routing` };
  }

  async configureRouting(token, zone, workerName) {
    let settings;
    try { settings = (await this.api(token, `/zones/${zone.id}/email/routing`)).result; } catch (error) { return { zoneId: zone.id, domain: zone.name, status: "manual", message: `Inspect Email Routing for ${zone.name}: ${error.message}` }; }
    if (!settings.enabled) try { await this.api(token, `/zones/${zone.id}/email/routing/enable`, { method: "POST", body: "{}" }); } catch (error) { return { zoneId: zone.id, domain: zone.name, status: "manual", message: `Enable Email Routing and required DNS records for ${zone.name}: ${error.message}` }; }
    const rules = await this.list(token, `/zones/${zone.id}/email/routing/rules`);
    const all = (rule) => rule.enabled !== false && array(rule.matchers).some((matcher) => matcher.type === "all");
    const found = rules.find((rule) => all(rule) && array(rule.actions).some((action) => action.type === "worker" && array(action.value).includes(workerName)));
    if (found) return { zoneId: zone.id, domain: zone.name, status: "ready", ruleId: found.id };
    if (rules.some(all)) return { zoneId: zone.id, domain: zone.name, status: "manual", message: "An existing catch-all rule was left unchanged. Route it to the KwikEmail Worker manually." };
    const body = { name: "KwikEmail catch-all", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [workerName] }], priority: 0 };
    try { const rule = (await this.api(token, `/zones/${zone.id}/email/routing/rules`, { method: "POST", body: JSON.stringify(body) })).result; return { zoneId: zone.id, domain: zone.name, status: "ready", ruleId: rule.id }; }
    catch (error) { return { zoneId: zone.id, domain: zone.name, status: "manual", message: `Create a catch-all Email Routing rule targeting Worker '${workerName}': ${error.message}` }; }
  }

  deploy(options) { const run = deployment.then(() => this.#deploy(options)); deployment = run.catch(() => {}); return run; }

  async #deploy({ account, credential, zones = [], bootstrapKey, workersDevName, update = async () => {}, event = () => {} }) {
    const set = async (status, patch = {}) => { event({ status, ...patch }); Object.assign(account, patch, { status }); await update({ status, ...patch }); };
    const token = await this.resolveToken(credential); let temporary;
    try {
      await set("authenticated"); if (credential.type === "api_token") await this.verifyToken(token);
      if (!(await this.discoverAccounts(token)).some(({ id }) => id === account.cloudflare_account_id)) throw new Error("Credential cannot access the selected Cloudflare account");
      const suffix = account.cloudflare_account_id.slice(-8).toLowerCase(); const workerName = account.worker_name || `kwikemail-${suffix}`; const d1Name = account.d1_database_name || workerName;
      await set("creating_d1", { worker_name: workerName, d1_database_name: d1Name });
      const database = await this.ensureD1(token, account.cloudflare_account_id, d1Name, account.d1_database_id);
      await set("migrating_d1", { d1_database_id: database.uuid });
      temporary = await mkdtemp(join(this.dataRoot, "kwikemail-deploy-"));
      const configPath = join(temporary, "wrangler.json"), secretsPath = join(temporary, "secrets.json"), outputPath = join(temporary, "deploy.ndjson");
      const commands = deploymentCommands({ d1Name, configPath, secretsPath });
      const key = bootstrapKey || `kwe_${randomBytes(24).toString("hex")}`;
      await writeFile(configPath, JSON.stringify(generateWranglerConfig({ workerName, accountId: account.cloudflare_account_id, d1Name, d1Id: database.uuid, backendRoot: this.backendRoot })));
      await this.runWrangler(commands.migrate, { token });
      const subdomain = await this.workersDev(token, account.cloudflare_account_id, preferredWorkersDevName(workersDevName, workerName));
      await writeFile(secretsPath, JSON.stringify({ API_KEY: key }), { mode: 0o600 }); await chmod(secretsPath, 0o600); await set("deploying_worker");
      await this.runWrangler(commands.deploy, { token, env: { WRANGLER_OUTPUT_FILE_PATH: outputPath } });
      await rm(secretsPath, { force: true }); const deployResult = parseDeployOutput(await readFile(outputPath, "utf8"));
      const workerUrl = deployedWorkerUrl(deployResult, workerName, subdomain);
      await set("configuring_domains", { worker_url: workerUrl, bootstrap_key: key });
      await this.waitForWorker(workerUrl);
      const routing = []; for (const zone of zones) routing.push(await this.configureRouting(token, zone, workerName));
      for (const zone of zones) { const response = await this.fetch(`${workerUrl}/api/domains`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ domain: zone.name }), redirect: "error" }); if (!response.ok && response.status !== 409) throw new Error(`Worker rejected domain ${zone.name} (${response.status})`); }
      await set("verifying"); const response = await this.fetch(`${workerUrl}/api/domains`, { headers: { "X-API-Key": key }, redirect: "error" });
      if (!response.ok) throw new Error(`Worker domain verification failed (${response.status})`); const registered = await response.json();
      const missing = zones.filter((zone) => !registered.some((domain) => domain.name === zone.name)); if (missing.length) throw new Error(`Worker did not register domains: ${missing.map(({ name }) => name).join(", ")}`);
      await set("ready", { routing }); return { account: { ...account }, deployment: deployResult, routing, domains: registered };
    } catch (error) { await set("error", { last_error: error.message }); throw error; }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
}
