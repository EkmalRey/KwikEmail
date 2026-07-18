import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Archive, defaultArchivePath, mergeEmails, serialize, syncArchive, tagStorage } from "./archive.js";
import { CloudflareController, CloudflareError } from "./cloudflare.js";

const root = dirname(fileURLToPath(import.meta.url));
process.umask(0o077);
const PUBLIC = join(root, "public");
const COOKIE = "kwikemail_admin";
const MAX_AGE = 864000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const archive = await new Archive(await defaultArchivePath()).init();
const controller = new CloudflareController({ backendRoot: join(root, "../backend") });
const archiveMutation = serialize();
const jobs = new Map();
const loginAttempts = new Map();

const fail = (status, message) => Object.assign(new Error(message), { httpStatus: status });
const required = (value, name) => { if (typeof value !== "string" || !value.trim()) throw fail(400, `${name} is required`); return value.trim(); };
const setupComplete = (store = archive) => store.getSetting("setup_complete") === "true";

export function cookieValue(header = "", name = COOKIE) {
  for (const item of header.split(";")) {
    const at = item.indexOf("=");
    if (at >= 0 && item.slice(0, at).trim() === name) try { return decodeURIComponent(item.slice(at + 1).trim()); } catch { return undefined; }
  }
}

const sessionCookie = (token, age = MAX_AGE) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${process.env.COOKIE_SECURE === "true" ? "; Secure" : ""}`;
const legacySessionCookie = () => `tpk_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.COOKIE_SECURE === "true" ? "; Secure" : ""}`;
const safeCredential = (credential) => credential && (({ id, type, name, wrangler_profile, created_at, updated_at }) => ({ id, type, name, wrangler_profile, created_at, updated_at }))(credential);
export const safeAccount = (account, credential, domains = []) => (({ id, cloudflare_account_id, name, worker_name, worker_url, d1_database_id, d1_database_name, status, last_error, created_at, updated_at }) => ({ id, cloudflare_account_id, name, worker_name, worker_url, d1_database_id, d1_database_name, status, last_error, created_at, updated_at, credential: safeCredential(credential), domains }))(account);
const accountSummary = (store, account) => safeAccount(account, store.listCredentials().find(({ id }) => id === account.credential_id), store.listDomains(account.id));

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) { cleanup(); req.resume(); reject(fail(413, "body too large")); } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString()); };
    const onError = (error) => { cleanup(); reject(error); };
    req.on("data", onData); req.on("end", onEnd); req.on("error", onError);
  });
}

async function input(req) {
  const text = await readBody(req);
  if (!text) return {};
  if (req.headers["content-type"]?.includes("application/json")) try { return JSON.parse(text); } catch { throw fail(400, "invalid JSON"); }
  return Object.fromEntries(new URLSearchParams(text));
}

async function staticFile(res, path) {
  const file = normalize(join(PUBLIC, path));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return send(res, 403, { error: "forbidden" });
  try { send(res, 200, await readFile(file), TYPES[extname(file)] || "application/octet-stream"); }
  catch { send(res, 404, { error: "not found" }); }
}

const tokenFor = async (credential) => controller.resolveToken(credential.type === "api_token" ? { type: credential.type, token: credential.value } : { type: credential.type, profile: credential.wrangler_profile });
const discoveryFor = async (credentialId) => {
  const credential = archive.getCredential(required(credentialId, "credentialId"));
  if (!credential) throw fail(404, "credential not found");
  return { credential, discovery: await controller.discover(await tokenFor(credential), credential.type === "api_token") };
};

async function workerFetch(account, path, options = {}) {
  if (!account || account.status !== "ready" || !account.worker_url) throw fail(404, "ready account not found");
  const key = archive.getBootstrapKey(account.id);
  if (!key) throw fail(404, "account bootstrap key not found");
  return fetch(`${account.worker_url.replace(/\/+$/, "")}/api${path}`, { ...options, headers: { "X-API-Key": key, ...(options.body && { "Content-Type": "application/json" }), ...options.headers }, signal: AbortSignal.timeout(65_000), redirect: "error" });
}

async function workerJson(account, path) {
  const response = await workerFetch(account, path);
  if (!response.ok) throw new Error(`Worker returned ${response.status}`);
  return response.json();
}

function addJob(store, cloudflare, account, credential, zones, workersDevName) {
  const id = randomUUID(), listeners = new Set(), job = { id, accountId: account.id, status: "new", events: [], listeners };
  jobs.set(id, job);
  while (jobs.size > 100) jobs.delete(jobs.keys().next().value);
  const event = (value) => { job.status = value.status; job.events.push(value); for (const listener of listeners) listener(value); };
  cloudflare.deploy({ account, credential: credential.type === "api_token" ? { type: credential.type, token: credential.value } : { type: credential.type, profile: credential.wrangler_profile }, zones, bootstrapKey: store.getBootstrapKey(account.id), workersDevName, update: (patch) => store.saveAccount({ ...store.getAccount(account.id), ...patch }), event }).then((result) => {
    for (const routing of result.routing) store.saveDomain({ account_id: account.id, zone_id: routing.zoneId, name: routing.domain, routing_rule_id: routing.ruleId, routing_status: routing.status, enabled: true });
    if (store.listAccounts().every(({ status }) => status === "ready")) store.setSetting("setup_complete", true);
  }).catch(() => {});
  return job;
}

const rateLimited = (address) => {
  const now = Date.now(), old = loginAttempts.get(address);
  const entry = !old || now - old.started >= 60_000 ? { started: now, count: 0 } : old;
  entry.count++; loginAttempts.set(address, entry);
  while (loginAttempts.size > 1000) loginAttempts.delete(loginAttempts.keys().next().value);
  return entry.count > 5;
};

export function createApp({ archiveStore = archive, cloudflare = controller } = {}) {
  return createServer(async (req, res) => {
    try {
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      const url = new URL(req.url, "http://localhost");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail(403, "cross-origin request denied");
      const session = cookieValue(req.headers.cookie) || cookieValue(req.headers.cookie, "tpk_admin");
      const authenticated = archiveStore.validateSession(session);
      const changed = archiveStore.adminState()?.password_changed === true;
      const requireSession = () => { if (!authenticated) throw fail(401, "unauthorized"); };
      const requireChanged = () => { requireSession(); if (!changed) throw fail(403, "setup action is forbidden until the password is changed"); };

      if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true });

      if (url.pathname === "/login" && req.method === "POST") {
        if (rateLimited(req.socket.remoteAddress || "unknown")) throw fail(429, "too many login attempts");
        const { password = "" } = await input(req);
        if (!await archiveStore.verifyPassword(password)) throw fail(401, "invalid credentials");
        loginAttempts.delete(req.socket.remoteAddress || "unknown");
        const token = archiveStore.createSession(); res.setHeader("Set-Cookie", sessionCookie(token));
        return send(res, 200, { ok: true, passwordChanged: archiveStore.adminState().password_changed });
      }

      if (url.pathname === "/logout" && req.method === "POST") {
        archiveStore.deleteSession(session); res.setHeader("Set-Cookie", [sessionCookie("", 0), legacySessionCookie()]); return send(res, 200, { ok: true });
      }

      if (url.pathname === "/setup/status" && req.method === "GET") {
        const accounts = authenticated ? archiveStore.listAccounts().map((account) => accountSummary(archiveStore, account)) : [];
        return send(res, 200, { authenticated, passwordChanged: changed, setupComplete: setupComplete(archiveStore), credentials: authenticated ? archiveStore.listCredentials() : [], accounts });
      }

      if (url.pathname === "/setup/password" && req.method === "POST") {
        requireSession();
        if (changed) throw fail(403, "password setup is complete");
        const body = await input(req), currentPassword = body.currentPassword ?? body.current_password, newPassword = body.newPassword ?? body.new_password, confirmation = body.confirmation ?? body.confirm_password;
        if (!await archiveStore.verifyPassword(currentPassword || "")) throw fail(401, "current password is invalid");
        if (typeof newPassword !== "string" || newPassword.length < 10) throw fail(400, "new password must be at least 10 characters");
        if (newPassword !== confirmation) throw fail(400, "password confirmation does not match");
        await archiveStore.changePassword(newPassword);
        const token = archiveStore.createSession(); res.setHeader("Set-Cookie", sessionCookie(token));
        return send(res, 200, { ok: true });
      }

      if (url.pathname.startsWith("/setup/") && url.pathname !== "/setup/status" && url.pathname !== "/setup/password") requireChanged();
      if (url.pathname.startsWith("/control/")) requireChanged();

      if (url.pathname === "/setup/cloudflare/token" && req.method === "POST") {
        const body = await input(req), token = required(body.token, "token"), name = required(body.name, "name");
        const discovery = await cloudflare.discover(token), credential = archiveStore.saveCredential({ type: "api_token", name, value: token });
        return send(res, 200, { credential: safeCredential(credential), ...discovery });
      }

      if (url.pathname === "/setup/cloudflare/oauth/start" && req.method === "POST") {
        const body = await input(req), name = required(body.name, "name"), profile = `kwikemail-${randomUUID().slice(0, 8)}`;
        const credential = archiveStore.saveCredential({ type: "wrangler_oauth", name, wrangler_profile: profile });
        try { const started = await cloudflare.startOAuth(profile); return send(res, 200, { id: started.id, credentialId: credential.id, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt }); }
        catch (error) { archiveStore.deleteCredential(credential.id); throw error; }
      }

      if (url.pathname === "/setup/cloudflare/oauth/callback" && req.method === "POST") {
        const body = await input(req), credential = archiveStore.getCredential(required(body.credentialId, "credentialId"));
        if (!credential || credential.type !== "wrangler_oauth") throw fail(404, "OAuth credential not found");
        await cloudflare.forwardOAuthCallback(required(body.id, "id"), required(body.url, "url"));
        const discovery = await cloudflare.discover(await cloudflare.oauthToken(credential.wrangler_profile), false);
        archiveStore.saveCredential({ id: credential.id, type: credential.type, name: credential.name, wrangler_profile: credential.wrangler_profile });
        return send(res, 200, { credential: safeCredential(credential), ...discovery });
      }

      if (url.pathname === "/setup/cloudflare/accounts" && req.method === "GET") {
        const { credential, discovery } = await discoveryFor(url.searchParams.get("credentialId"));
        return send(res, 200, { credential: safeCredential(credential), ...discovery });
      }

      if (url.pathname === "/setup/cloudflare/routing-readiness" && req.method === "POST") {
        const body = await input(req), { credential, discovery } = await discoveryFor(body.credentialId);
        const cloudflareAccountId = required(body.cloudflareAccountId, "cloudflareAccountId"), available = new Map((discovery.zones[cloudflareAccountId] || []).map((zone) => [zone.id, zone]));
        if (!discovery.accounts.some(({ id }) => id === cloudflareAccountId)) throw fail(400, "selected account was not discovered");
        if (!Array.isArray(body.zones) || !body.zones.length) throw fail(400, "zones must be a non-empty list");
        const zones = body.zones.map((id) => available.get(id)); if (zones.some((zone) => !zone)) throw fail(400, "selected zone was not discovered");
        return send(res, 200, await cloudflare.routingReadiness(await tokenFor(credential), cloudflareAccountId, zones));
      }

      if (url.pathname === "/setup/accounts" && req.method === "POST") {
        const body = await input(req), { credential, discovery } = await discoveryFor(body.credentialId);
        const cloudflareAccountId = required(body.cloudflareAccountId ?? body.cloudflare_account_id, "cloudflareAccountId");
        const found = discovery.accounts.find(({ id }) => id === cloudflareAccountId);
        if (!found) throw fail(400, "selected account was not discovered");
        if (!Array.isArray(body.zones)) throw fail(400, "zones must be a list");
        const available = new Map((discovery.zones[cloudflareAccountId] || []).map((zone) => [zone.id, zone]));
        const zones = body.zones.map((zone) => available.get(typeof zone === "string" ? zone : zone.id)).filter(Boolean);
        if (zones.length !== body.zones.length) throw fail(400, "selected zone was not discovered");
        const readiness = await cloudflare.routingReadiness(await tokenFor(credential), found.id, zones);
        if (!readiness.ready) throw fail(409, "Email Routing is not ready for every selected domain");
        const existing = archiveStore.listAccounts().find(({ cloudflare_account_id }) => cloudflare_account_id === found.id);
        const account = archiveStore.saveAccount({ ...existing, credential_id: credential.id, cloudflare_account_id: found.id, name: body.name?.trim() || existing?.name || found.name, status: "new", last_error: null });
        for (const zone of zones) archiveStore.saveDomain({ ...archiveStore.listDomains(account.id).find(({ zone_id }) => zone_id === zone.id), account_id: account.id, zone_id: zone.id, name: zone.name, routing_status: "pending", enabled: true });
        const job = addJob(archiveStore, cloudflare, account, credential, zones, body.workersDevName);
        return send(res, 202, { jobId: job.id, accountId: account.id });
      }

      const eventMatch = url.pathname.match(/^\/setup\/jobs\/([^/]+)\/events$/);
      if (eventMatch && req.method === "GET") {
        const job = jobs.get(eventMatch[1]); if (!job) throw fail(404, "job not found");
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.flushHeaders?.();
        const write = (event) => { res.write(`event: status\ndata: ${JSON.stringify(event)}\n\n`); if (["ready", "error"].includes(event.status)) { job.listeners.delete(write); res.end(); } };
        for (const event of job.events) write(event);
        if (!["ready", "error"].includes(job.status)) { job.listeners.add(write); req.once("close", () => job.listeners.delete(write)); }
        return;
      }

      if ((url.pathname === "/control/accounts" || url.pathname === "/api/accounts") && req.method === "GET") { requireChanged(); return send(res, 200, archiveStore.listAccounts().map((account) => accountSummary(archiveStore, account))); }

      if (url.pathname === "/control/password" && req.method === "POST") {
        const body = await input(req), currentPassword = body.currentPassword, newPassword = body.newPassword;
        if (!await archiveStore.verifyPassword(currentPassword || "")) throw fail(401, "current password is invalid");
        if (typeof newPassword !== "string" || newPassword.length < 10) throw fail(400, "new password must be at least 10 characters");
        if (newPassword !== body.confirmation) throw fail(400, "password confirmation does not match");
        await archiveStore.changePassword(newPassword);
        const token = archiveStore.createSession(); res.setHeader("Set-Cookie", sessionCookie(token));
        return send(res, 200, { ok: true });
      }

      const accountMatch = url.pathname.match(/^\/control\/accounts\/([^/]+)$/);
      if (accountMatch && req.method === "PATCH") {
        const account = archiveStore.getAccount(accountMatch[1]); if (!account) throw fail(404, "account not found");
        const name = required((await input(req)).name, "name"); if (name.length > 80) throw fail(400, "name must be 80 characters or fewer");
        return send(res, 200, accountSummary(archiveStore, archiveStore.saveAccount({ ...account, name })));
      }
      if (accountMatch && req.method === "DELETE") {
        const account = archiveStore.getAccount(accountMatch[1]); if (!account) throw fail(404, "account not found");
        const body = await input(req); if (body.confirm !== account.worker_name) throw fail(400, `type ${account.worker_name} to confirm`);
        const credential = archiveStore.getCredential(account.credential_id); if (!credential) throw fail(404, "credential not found");
        await cloudflare.deleteDeployment(await tokenFor(credential), account, archiveStore.listDomains(account.id));
        archiveStore.deleteAccount(account.id);
        if (!archiveStore.listAccounts().some(({ credential_id }) => credential_id === credential.id)) archiveStore.deleteCredential(credential.id);
        if (!archiveStore.listAccounts().length) archiveStore.setSetting("setup_complete", false);
        return send(res, 200, { ok: true });
      }

      const deployMatch = url.pathname.match(/^\/control\/accounts\/([^/]+)\/deploy$/);
      if (deployMatch && req.method === "POST") {
        const account = archiveStore.getAccount(deployMatch[1]); if (!account) throw fail(404, "account not found");
        const credential = archiveStore.getCredential(account.credential_id); if (!credential) throw fail(404, "credential not found");
        const job = addJob(archiveStore, cloudflare, account, credential, archiveStore.listDomains(account.id).filter(({ enabled }) => enabled).map(({ zone_id: id, name }) => ({ id, name })), (await input(req)).workersDevName);
        return send(res, 202, { jobId: job.id, accountId: account.id });
      }

      const domainsMatch = url.pathname.match(/^\/control\/accounts\/([^/]+)\/domains(?:\/([^/]+))?$/);
      if (domainsMatch) {
        const account = archiveStore.getAccount(domainsMatch[1]); if (!account) throw fail(404, "account not found");
        if (req.method === "GET" && !domainsMatch[2]) return send(res, 200, archiveStore.listDomains(account.id));
        if (req.method === "POST" && !domainsMatch[2]) {
          const body = await input(req), { credential, discovery } = await discoveryFor(account.credential_id), zone = (discovery.zones[account.cloudflare_account_id] || []).find(({ id, name }) => id === body.zoneId || name === body.name);
          if (!zone) throw fail(400, "domain was not discovered for this account");
          let routing = { status: "pending" };
          if (account.status === "ready") {
            routing = await cloudflare.configureRouting(await tokenFor(credential), zone, account.worker_name);
            const response = await workerFetch(account, "/domains", { method: "POST", body: JSON.stringify({ domain: zone.name }) });
            if (!response.ok && response.status !== 409) throw new Error(`Worker rejected domain (${response.status})`);
          }
          const domain = archiveStore.saveDomain({ account_id: account.id, zone_id: zone.id, name: zone.name, routing_rule_id: routing.ruleId, routing_status: routing.status, enabled: true });
          return send(res, 201, domain);
        }
        if (req.method === "DELETE" && domainsMatch[2]) {
          const name = decodeURIComponent(domainsMatch[2]), domain = archiveStore.listDomains(account.id).find((item) => item.name === name || item.id === name);
          if (!domain) throw fail(404, "domain not found");
          if (account.status === "ready") { const response = await workerFetch(account, `/domains/${encodeURIComponent(domain.name)}`, { method: "DELETE" }); if (!response.ok && response.status !== 404) throw new Error(`Worker rejected domain removal (${response.status})`); }
          return send(res, 200, archiveStore.saveDomain({ ...domain, enabled: false, routing_status: "disabled" }));
        }
      }

      if (url.pathname === "/api/metrics" && req.method === "GET") {
        requireChanged(); const accountId = url.searchParams.get("accountId");
        const where = accountId ? " WHERE account_id = ?" : "", args = accountId ? [accountId] : [];
        const emails = archiveStore.db.prepare(`SELECT COUNT(*) count FROM emails${where}`).get(...args).count;
        const addresses = archiveStore.db.prepare(`SELECT COUNT(DISTINCT address) count FROM emails${where}`).get(...args).count;
        return send(res, 200, { requests: null, emails, addresses, storageMB: null });
      }

      const proxy = url.pathname.match(/^\/api\/accounts\/([^/]+)\/(.+)$/);
      if (proxy) {
        requireChanged(); const accountId = decodeURIComponent(proxy[1]), account = archiveStore.getAccount(accountId), path = `/${proxy[2]}${url.search}`;
        const response = await workerFetch(account, path, { method: req.method, body: ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req) });
        let text = await response.text(), address = url.searchParams.get("address");
        if (response.ok && req.method === "GET" && proxy[2] === "emails" && address) {
          const cloud = JSON.parse(text);
          text = await archiveMutation(() => { archiveStore.upsert(accountId, address, cloud); return JSON.stringify(tagStorage(cloud, mergeEmails(archiveStore.list(accountId, address), cloud))); });
        }
        if (response.ok && req.method === "DELETE" && proxy[2] === "emails" && address) await archiveMutation(() => archiveStore.purge(accountId, address));
        if (response.ok && req.method === "DELETE" && proxy[2].startsWith("addresses/")) await archiveMutation(() => archiveStore.purge(accountId, decodeURIComponent(proxy[2].slice(10))));
        res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || "application/json" }); return res.end(text);
      }

      if (["/", "/index.html", "/setup.html"].includes(url.pathname)) {
        if (!authenticated) return staticFile(res, "login.html");
        if (!changed || !setupComplete(archiveStore) || url.pathname === "/setup.html") return staticFile(res, "setup.html");
        return staticFile(res, "index.html");
      }
      if (url.pathname === "/login.html") return authenticated ? staticFile(res, changed && setupComplete(archiveStore) ? "index.html" : "setup.html") : staticFile(res, "login.html");
      return staticFile(res, url.pathname.replace(/^\/+/, ""));
    } catch (error) {
      const status = error.httpStatus || 502;
      if (status >= 500) console.error(error instanceof CloudflareError ? `${error.name}: ${error.message}` : error?.message || "request failed");
      send(res, status, { error: status === 502 ? "upstream request failed" : error.message });
    }
  });
}

function startSync() {
  const sync = () => archiveMutation(async () => {
    for (const account of archive.listAccounts().filter(({ status, worker_url }) => status === "ready" && worker_url)) await syncArchive(archive, account.id, (path) => workerJson(account, path));
  });
  Promise.resolve().then(sync).catch((error) => console.error(error.message));
  const timer = setInterval(() => sync().catch((error) => console.error(error.message)), 3_600_000); timer.unref?.(); return timer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const server = createApp(), timer = startSync(), port = Number(process.env.PORT) || 3000, host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`kwikemail-frontend listening on http://${host}:${port}`));
  const close = () => { clearInterval(timer); server.close(() => { archive.close(); process.exit(0); }); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
