const $ = (id) => document.getElementById(id);
const stages = ["setupLoading", "passwordStage", "authStage", "oauthStage", "discoveryStage", "routingStage", "progressStage", "readyStage"];
let credentialId;
let discovery;
let oauth;
let pendingDeployment;
let routingDashboardUrl;
let oauthPopup;
let events;

function show(id, step) {
  stages.forEach((stage) => $(stage).hidden = stage !== id);
  $("setupStep").textContent = step;
  $("setupFatal").textContent = "";
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function popup(name) { const opened = window.open("", name, "popup=yes,width=720,height=800,resizable=yes,scrollbars=yes"); if (opened) opened.opener = null; return opened; }

async function submit(form, work) {
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector(".inline-error");
  button.disabled = true;
  error.textContent = "";
  try { await work(Object.fromEntries(new FormData(form))); }
  catch (reason) { error.textContent = reason.message; }
  finally { button.disabled = false; }
}

function renderDiscovery(result) {
  discovery = result;
  credentialId = result.credential.id;
  const list = $("discoveryList");
  list.replaceChildren();
  result.accounts.forEach((account, index) => {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    const accountLabel = document.createElement("label");
    const accountRadio = document.createElement("input");
    accountRadio.type = "radio";
    accountRadio.name = "cloudflareAccountId";
    accountRadio.value = account.id;
    accountRadio.required = true;
    accountRadio.checked = index === 0;
    accountLabel.append(accountRadio, document.createTextNode(account.name || account.id));
    legend.append(accountLabel);
    group.append(legend);
    const zones = result.zones[account.id] || [];
    zones.forEach((zone) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "zones";
      input.value = zone.id;
      label.append(input, document.createTextNode(zone.name));
      group.append(label);
    });
    if (!zones.length) { const empty = document.createElement("p"); empty.className = "field-help"; empty.textContent = "No active zones found."; group.append(empty); }
    list.append(group);
  });
  show("discoveryStage", "03 / Select target");
}

async function deployPending() { const result = await request("/setup/accounts", { method: "POST", body: JSON.stringify({ credentialId, ...pendingDeployment }) }); connectJob(result.jobId); }

async function checkRouting() {
  const result = await request("/setup/cloudflare/routing-readiness", { method: "POST", body: JSON.stringify({ credentialId, cloudflareAccountId: pendingDeployment.cloudflareAccountId, zones: pendingDeployment.zones }) });
  routingDashboardUrl = result.dashboardUrl;
  $("routingDomains").replaceChildren(...result.domains.map((domain) => { const row = document.createElement("p"); row.className = domain.ready ? "routing-ready" : "routing-pending"; row.textContent = `${domain.name} · ${domain.ready ? "ready" : domain.error || domain.status || "onboarding required"}`; return row; }));
  if (result.ready) await deployPending(); else show("routingStage", "04 / Enable routing");
}

function connectJob(jobId) {
  if (events) events.close();
  $("progressList").replaceChildren();
  $("progressError").textContent = "";
  show("progressStage", "04 / Deploy");
  events = new EventSource(`/setup/jobs/${encodeURIComponent(jobId)}/events`);
  events.addEventListener("status", (event) => {
    const value = JSON.parse(event.data);
    const item = document.createElement("li");
    const label = document.createElement("strong");
    const message = document.createElement("span");
    label.textContent = String(value.status || "working").replaceAll("_", " ");
    message.textContent = value.message || value.last_error || "Complete";
    item.append(label, message);
    $("progressList").append(item);
    if (value.status === "ready") { events.close(); show("readyStage", "05 / Ready"); }
    if (value.status === "error") { events.close(); $("progressError").textContent = value.last_error || value.message || "Deployment failed. Return to setup and try again."; }
  });
  events.onerror = () => { if (events.readyState === EventSource.CLOSED && !$("progressStage").hidden && !$("progressError").textContent) $("progressError").textContent = "The progress stream closed before deployment finished."; };
}

function chooseStart(state) {
  if (!state.authenticated) { location.href = "/"; return; }
  if (!state.passwordChanged) { show("passwordStage", "01 / Secure"); return; }
  show("authStage", "02 / Connect");
}

$("passwordForm").addEventListener("submit", (event) => { event.preventDefault(); submit(event.currentTarget, async (body) => { if (body.newPassword !== body.confirmation) throw new Error("Password confirmation does not match."); await request("/setup/password", { method: "POST", body: JSON.stringify(body) }); show("authStage", "02 / Connect"); }); });
$("tokenForm").addEventListener("submit", (event) => { event.preventDefault(); submit(event.currentTarget, async (body) => renderDiscovery(await request("/setup/cloudflare/token", { method: "POST", body: JSON.stringify(body) }))); });
$("oauthForm").addEventListener("submit", (event) => { event.preventDefault(); oauthPopup = popup("kwikemail-oauth"); submit(event.currentTarget, async (body) => { try { if (!oauthPopup) throw new Error("Allow popups for KwikEmail, then start OAuth again."); oauth = await request("/setup/cloudflare/oauth/start", { method: "POST", body: JSON.stringify(body) }); credentialId = oauth.credentialId; oauthPopup.location = oauth.authorizationUrl; show("oauthStage", "03 / Authorize"); } catch (error) { oauthPopup?.close(); oauthPopup = undefined; throw error; } }); });
$("callbackForm").addEventListener("submit", (event) => { event.preventDefault(); submit(event.currentTarget, async ({ url }) => { renderDiscovery(await request("/setup/cloudflare/oauth/callback", { method: "POST", body: JSON.stringify({ id: oauth.id, credentialId, url }) })); oauthPopup?.close(); oauthPopup = undefined; }); });
$("accountForm").addEventListener("submit", (event) => { event.preventDefault(); submit(event.currentTarget, async (body) => { const accountId = body.cloudflareAccountId; const zones = [...event.currentTarget.querySelectorAll('input[name="zones"]:checked')].map(({ value }) => value); const available = new Set((discovery.zones[accountId] || []).map(({ id }) => id)); if (!zones.length) throw new Error("Select at least one domain."); if (zones.some((id) => !available.has(id))) throw new Error("Selected domains must belong to the chosen account."); pendingDeployment = { cloudflareAccountId: accountId, zones, name: body.name, workersDevName: body.workersDevName || undefined }; await checkRouting(); }); });
$("openRouting").onclick = () => { const routingWindow = popup("kwikemail-routing"); $("routingError").textContent = routingWindow ? "" : "Allow popups for KwikEmail, then open Cloudflare again."; if (routingWindow) routingWindow.location = routingDashboardUrl; };
$("checkRouting").onclick = async () => { const button = $("checkRouting"); button.disabled = true; $("routingError").textContent = ""; try { await checkRouting(); } catch (error) { $("routingError").textContent = error.message; } finally { button.disabled = false; } };
$("addAnother").onclick = () => { credentialId = undefined; discovery = undefined; show("authStage", "02 / Connect"); };
request("/setup/status").then(chooseStart).catch((error) => { $("setupLoading").hidden = true; $("setupFatal").textContent = `Setup could not load: ${error.message}`; });
