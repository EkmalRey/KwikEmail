import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./public/app.js", import.meta.url), "utf8");
const setup = await readFile(new URL("./public/setup.js", import.meta.url), "utf8");
const login = await readFile(new URL("./public/login.html", import.meta.url), "utf8");
const index = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const setupHtml = await readFile(new URL("./public/setup.html", import.meta.url), "utf8");
const styles = await readFile(new URL("./public/styles.css", import.meta.url), "utf8");

test("dashboard scopes worker routes, metrics, and caches to the selected account", () => {
  assert.match(source, /api\("\/accounts"\)/);
  assert.match(source, /`\/accounts\/\$\{encodeURIComponent\(activeAccountId\)\}`/);
  assert.match(source, /metrics\?accountId=\$\{encodeURIComponent\(accountId\)\}/);
  assert.match(source, /if \(accountId !== activeAccountId\) return;/);
  assert.match(source, /"kwikemail_req_" \+ new Date\(\)\.toISOString\(\)\.slice\(0, 10\) \+ "_" \+ \(activeAccountId \|\| "dashboard"\)/);
  assert.match(source, /key\.startsWith\("kwikemail_req_" \+ new Date\(\)\.toISOString\(\)\.slice\(0, 10\) \+ "_"\)/);
  assert.match(source, /`kwikemail_cache_\$\{kind\}_\$\{activeAccountId\}_\$\{value\}`/);
  assert.match(source, /stopPoll\(\);\s*activeAccountId = accountId;\s*showBudget\(\)/);
});

test("address creation includes the selected domain and renders full addresses", () => {
  assert.match(source, /JSON\.stringify\(\{ localPart, domain \}\)/);
  assert.match(source, /sidebar-addr[^`]*\$\{esc\(address\.address\.split\("@", 1\)\[0\]\)\}/);
  assert.match(source, /\$\("listHeader"\)\.textContent = address/);
  assert.match(index, /id="domainSelect"/);
});

test("email rows preserve cloud and local storage icon invariants", () => {
  assert.match(source, /STORAGE_ICON = \{/);
  assert.match(source, /cloud:.*<svg/);
  assert.match(source, /local:.*<svg/);
  assert.match(source, /STORAGE_ICON\[message\.storage\]/);
  assert.match(styles, /\.store-ico\.cloud\s*\{\s*fill:\s*#3b82f6/);
  assert.match(styles, /\.store-ico\.local\s*\{\s*fill:\s*#16a34a/);
});

test("selected inbox polls every ten seconds only while visible", () => {
  assert.match(source, /setInterval\(refreshEmails, 10000\)/);
  assert.match(source, /document\.hidden[^}]*stopPoll/);
  assert.match(source, /↻ paused/);
  assert.match(source, /setInterval\(tickCount, 1000\)/);
  assert.match(source, /if \(activeAddr === address\) \{ stopPoll\(\); activeAddr = null; addressDeselected = true;/);
  assert.match(source, /if \(!activeAddr && !addressDeselected && rows\.length\) await selectAddress\(rows\[0\]\.address\)/);
});

test("KwikEmail shows its icon and selected inbox unread count in the tab", () => {
  for (const page of [index, login, setupHtml]) assert.match(page, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
  assert.match(source, /document\.title = count \? `\(\$\{count\}\) KwikEmail` : "KwikEmail"/);
  assert.match(source, /function showEmpty[^{]*\{[^}]*document\.title = "KwikEmail"/);
});

test("login explains the temporary password without prefilling it", () => {
  assert.match(login, /fetch\("\/setup\/status"\)/);
  assert.match(login, /123456/);
  assert.doesNotMatch(login, /value="123456"/);
  assert.match(login, /fetch\("\/login"/);
});

test("setup covers password, Cloudflare connection, routing readiness, and deployment", () => {
  for (const route of ["/setup/status", "/setup/password", "/setup/cloudflare/token", "/setup/cloudflare/oauth/start", "/setup/cloudflare/oauth/callback", "/setup/cloudflare/routing-readiness", "/setup/accounts"]) assert.ok(setup.includes(route), route);
  assert.doesNotMatch(setup + setupHtml, /legacyStage|import-legacy/);
  assert.match(setup, /window\.open\("", name, "popup=yes,width=720,height=800/);
  assert.match(setup, /oauthPopup = popup\("kwikemail-oauth"\)[\s\S]*oauthPopup\.location = oauth\.authorizationUrl/);
  assert.match(setup, /if \(!oauthPopup\) throw new Error\("Allow popups/);
  assert.match(setup, /oauthPopup\?\.close\(\)/);
  assert.match(setup, /popup\("kwikemail-routing"\)/);
  assert.match(setup, /if \(result\.ready\) await deployPending\(\); else show\("routingStage"/);
  assert.match(setup, /JSON\.stringify\(\{ id: oauth\.id, credentialId, url \}\)/);
  assert.match(setup, /new EventSource\(`\/setup\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/events`\)/);
  assert.match(setup, /message\.textContent = value\.message/);
  assert.doesNotMatch(setup, /innerHTML|alert\(/);
  assert.match(setupHtml, /name="workersDevName"/);
  assert.match(setupHtml, /id="callbackUrl"/);
  assert.match(setupHtml, /id="routingStage"[\s\S]*Onboard Domain[\s\S]*id="checkRouting"/);
  assert.match(styles, /\.routing-pending \{ color: #a03626/);
});

test("accounts expose account state, live retry, domains, and add-account", () => {
  assert.match(source, /account\.status\.replaceAll/);
  assert.match(source, /\/control\/accounts\/\$\{encodeURIComponent\(account\.id\)\}\/deploy/);
  assert.match(source, /new EventSource\(`\/setup\/jobs\/\$\{encodeURIComponent\(result\.jobId\)\}\/events`\)/);
  assert.match(source, /state\.textContent = String\(value\.status/);
  assert.match(source, /className = "account-name"/);
  assert.match(source, /className = "rename-button"/);
  assert.match(source, /className = "rename-form"/);
  assert.match(source, /save\.textContent = "✓"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /accountsPanel"\)\.addEventListener\("panelclose", renderSettings\)/);
  assert.match(source, /other\.dispatchEvent\(new Event\("panelclose"\)\)/);
  assert.doesNotMatch(source, /prompt\("Mailbox name"/);
  assert.match(source, /className = "account-details"/);
  assert.match(source, />Worker<\/span>/);
  assert.match(source, />Domains<\/span>/);
  assert.match(source, /<svg[^>]*viewBox="0 0 16 16"/);
  assert.match(source, /method: "PATCH"[\s\S]*JSON\.stringify\(\{ name \}\)/);
  assert.match(styles, /\.account-control-head \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /\.account-control \{[^}]*background: var\(--bg\)/);
  assert.match(styles, /#accountsList \{ display: grid; gap:/);
  assert.match(source, /Delete Worker, D1, routing rules, mailboxes, and archive/);
  assert.match(source, /method: "DELETE"[\s\S]*JSON\.stringify\(\{ confirm \}\)/);
  assert.match(index, /setup\.html\?add=1/);
  assert.match(index, /id="accountsBtn"[^>]*>Accounts<\/button>/);
  assert.match(index, /id="accountsPanel"[^>]*aria-label="Accounts"/);
});

test("settings change the admin password and contain logout", () => {
  assert.match(index, /id="settingsBtn"[^>]*>Settings<\/button>/);
  assert.match(index, /id="settingsPanel"[^>]*aria-label="Settings"/);
  assert.match(index, /id="passwordForm"/);
  assert.match(index, /name="currentPassword"/);
  assert.match(index, /name="newPassword"/);
  assert.match(index, /name="confirmation"/);
  assert.match(index, /id="logoutForm"[^>]*action="\/logout"/);
  assert.match(source, /fetch\("\/control\/password"/);
  assert.match(source, /body\.newPassword !== body\.confirmation/);
  assert.match(source, /fetch\("\/logout", \{ method: "POST" \}\); clearMailCache\(\); location\.href = "\/"/);
  assert.match(source, /function clearMailCache\(\)[^}]*kwikemail_cache_/);
  assert.match(source, /fetch\("\/logout"[\s\S]*clearMailCache\(\)/);
  assert.match(source, /function openPanel\(panel\)/);
  assert.match(source, /function closePanel\(panel\)/);
  assert.match(styles, /\.control-panel\.open \{ opacity: 1; transform: translateX\(0\); \}/);
  assert.match(styles, /\.settings-form \{ display: grid/);
  assert.match(styles, /\.settings-logout \{ display: flex; justify-content: flex-end/);
});

test("mobile navigation keeps all three dashboard panes reachable", () => {
  assert.match(index, /id="backAddresses"/);
  assert.match(index, /id="backMessages"/);
  assert.match(source, /mobileView\("messages"\)/);
  assert.match(source, /mobileView\("content"\)/);
  assert.match(styles, /\.view-addresses \.sidebar, \.view-messages \.list-panel, \.view-content \.content-panel/);
  assert.match(styles, /:focus-visible/);
});
