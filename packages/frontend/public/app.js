const $ = (id) => document.getElementById(id);
const DAILY_BUDGET = 70000;
for (const key of Object.keys(localStorage)) for (const [oldPrefix, newPrefix] of [["tpk_cache_", "kwikemail_cache_"], ["tpk_req_", "kwikemail_req_"]]) if (key.startsWith(oldPrefix)) { const replacement = newPrefix + key.slice(oldPrefix.length); if (localStorage.getItem(replacement) == null) localStorage.setItem(replacement, localStorage.getItem(key)); localStorage.removeItem(key); }
const budgetKey = () => "kwikemail_req_" + new Date().toISOString().slice(0, 10) + "_" + (activeAccountId || "dashboard");
const budgetCount = () => Number(localStorage.getItem(budgetKey()) || 0);
const budgetLeft = () => DAILY_BUDGET - budgetCount();
const accountPath = (path) => `/accounts/${encodeURIComponent(activeAccountId)}` + path;
const cacheKey = (kind, value = "") => `kwikemail_cache_${kind}_${activeAccountId}_${value}`;
const cacheRead = (kind, value) => { try { return JSON.parse(localStorage.getItem(cacheKey(kind, value)) || "null"); } catch { return null; } };
const cacheWrite = (kind, value, data) => localStorage.setItem(cacheKey(kind, value), JSON.stringify(data));
let accounts = [];
let activeAccountId = null;
let activeAddr = null;
let addressDeselected = false;
let activeEmailId = null;
let pollTimer = null;
let countTimer = null;
let countLeft = 10;

function toast(message, error = false) { const el = $("toast"); el.textContent = message; el.className = "toast show" + (error ? " err" : ""); clearTimeout(el._timer); el._timer = setTimeout(() => el.className = "toast", 3000); }
async function api(path, options = {}) { if (budgetLeft() <= 0) { stopPoll(); throw new Error("Daily request budget reached; polling paused."); } localStorage.setItem(budgetKey(), budgetCount() + 1); showBudget(); const response = await fetch("/api" + path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }); if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); return response.json(); }
function esc(value) { return String(value).replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character])); }
function fmtNum(value) { if (value == null) return "--"; if (value >= 1000000) return (value / 1000000).toFixed(1) + "M"; if (value >= 1000) return (value / 1000).toFixed(1) + "k"; return String(value); }
function showBudget() { $("mBudget").textContent = fmtNum(Math.max(0, budgetLeft())); }
function clearMailCache() { Object.keys(localStorage).filter((key) => key.startsWith("kwikemail_cache_")).forEach((key) => localStorage.removeItem(key)); }
function mobileView(view) { document.body.classList.remove("view-addresses", "view-messages", "view-content"); document.body.classList.add(`view-${view}`); }
function currentAccount() { return accounts.find(({ id }) => id === activeAccountId); }

async function loadAccounts(preferred) {
  try {
    accounts = await api("/accounts");
    const ready = accounts.filter(({ status }) => status === "ready");
    if (!ready.length) { location.href = "/setup.html"; return; }
    $("accountSelect").replaceChildren(...ready.map((account) => new Option(account.name, account.id)));
    await switchAccount(ready.some(({ id }) => id === preferred) ? preferred : ready[0].id);
    renderSettings();
  } catch (error) { toast("Accounts failed: " + error.message, true); }
}

async function switchAccount(accountId) {
  stopPoll();
  activeAccountId = accountId;
  showBudget();
  activeAddr = null;
  addressDeselected = false;
  activeEmailId = null;
  $("accountSelect").value = accountId;
  const domains = (currentAccount()?.domains || []).filter(({ enabled }) => enabled !== 0);
  $("domainSelect").replaceChildren(...domains.map((domain) => new Option(domain.name, domain.name)));
  showEmpty();
  mobileView("addresses");
  await Promise.all([loadAddresses(), loadMetrics()]);
}

async function loadMetrics() { const accountId = activeAccountId; if (!accountId) return; try { const metrics = await api(`/metrics?accountId=${encodeURIComponent(accountId)}`); if (accountId !== activeAccountId) return; $("mReqs").textContent = fmtNum(metrics.requests); $("mReads").textContent = fmtNum(metrics.emails); $("mWrites").textContent = fmtNum(metrics.addresses); $("mStorage").textContent = metrics.storageMB != null ? metrics.storageMB + " MB" : "--"; } catch {} }
function setUnreadBadge(address, count) { const rows = cacheRead("addr"); if (!rows) return; const row = rows.find((item) => item.address === address); if (row) { row.unread_count = count; cacheWrite("addr", "", rows); renderSidebar(rows); } }
function renderSidebar(rows) {
  const list = $("addressList"); list.replaceChildren();
  if (!rows.length) { const item = document.createElement("li"); item.className = "empty-row"; item.textContent = "No addresses yet."; list.append(item); return; }
  rows.forEach((address) => { const item = document.createElement("li"); item.className = "sidebar-item" + (activeAddr === address.address ? " active" : ""); item.innerHTML = `<span class="sidebar-addr">${esc(address.address.split("@", 1)[0])}</span><span class="sidebar-count" ${address.unread_count ? "" : "hidden"}>${address.unread_count || 0}</span><button class="sidebar-del" aria-label="Delete ${esc(address.address)}">×</button>`; item.querySelector("button").onclick = async (event) => { event.stopPropagation(); try { await api(accountPath("/addresses/") + encodeURIComponent(address.address), { method: "DELETE" }); if (activeAddr === address.address) { activeAddr = null; stopPoll(); showEmpty(); } await loadAddresses(); toast("Address deleted"); } catch (error) { toast("Delete failed: " + error.message, true); } }; item.onclick = () => selectAddress(address.address); list.append(item); });
}
async function loadAddresses() { if (!activeAccountId) return; const cached = cacheRead("addr"); if (cached) renderSidebar(cached); try { const rows = await api(accountPath("/addresses")); cacheWrite("addr", "", rows); renderSidebar(rows); if (!activeAddr && !addressDeselected && rows.length) await selectAddress(rows[0].address); } catch (error) { if (!cached) toast("Addresses failed: " + error.message, true); } }
async function selectAddress(address) { if (activeAddr === address) { stopPoll(); activeAddr = null; addressDeselected = true; activeEmailId = null; renderSidebar(cacheRead("addr") || []); showEmpty(); mobileView("addresses"); return; } stopPoll(); activeAddr = address; addressDeselected = false; activeEmailId = null; renderSidebar(cacheRead("addr") || []); showEmpty(false); $("listHeader").textContent = address; $("purgeBtn").hidden = false; const cached = cacheRead("emails", address); if (cached) renderEmailList(cached); mobileView("messages"); await refreshEmails(); startPoll(); }
async function refreshEmails() { if (!activeAddr || !activeAccountId) return; const accountId = activeAccountId; const address = activeAddr; try { const rows = await api(accountPath("/emails?address=") + encodeURIComponent(address)); if (accountId !== activeAccountId || address !== activeAddr) return; cacheWrite("emails", address, rows); renderEmailList(rows); countLeft = 10; setUnreadBadge(address, rows.filter((message) => !message.is_read).length); if (activeEmailId != null) { const index = rows.findIndex(({ id }) => id === activeEmailId); if (index >= 0) openEmail(rows, index); else { activeEmailId = null; showContentEmpty(); } } } catch (error) { if (!pollTimer) toast("Inbox failed: " + error.message, true); } }
const STORAGE_ICON = { cloud: '<svg class="store-ico cloud" viewBox="0 0 16 16" aria-label="cloud-backed"><path d="M4.5 12h7a2.5 2.5 0 0 0 .4-4.97A3.5 3.5 0 0 0 4.7 7.2 2.4 2.4 0 0 0 4.5 12Z"/></svg>', local: '<svg class="store-ico local" viewBox="0 0 16 16" aria-label="local-only"><circle cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="1.8" fill="currentColor" opacity=".5"/></svg>' };
function renderEmailList(rows) { const list = $("emailList"); list.replaceChildren(); if (!rows.length) { const item = document.createElement("li"); item.className = "empty-row"; item.textContent = "No emails yet."; list.append(item); updateUnread(rows); return; } rows.forEach((message, index) => { const item = document.createElement("li"); item.className = "list-item" + (message.id === activeEmailId ? " active" : "") + (message.is_read ? "" : " unread"); const icon = STORAGE_ICON[message.storage] || STORAGE_ICON.cloud; item.innerHTML = `<span class="store-badge" title="${message.storage === "local" ? "local-only (kept here)" : "cloud-backed"}">${icon}</span><div class="list-from">${esc(message.from_addr)}</div><div class="list-subj">${esc(message.subject || "(no subject)")}</div><div class="list-date">${new Date(message.received_at).toLocaleDateString()}</div>`; item.onclick = () => openEmail(rows, index); list.append(item); }); updateUnread(rows); }
function updateUnread(rows) { const count = rows.filter((message) => !message.is_read).length; document.title = count ? `(${count}) KwikEmail` : "KwikEmail"; $("listUnread").hidden = count === 0; $("listUnread").textContent = count + " unread"; }
function tickCount() { if (document.hidden) { $("pollCount").textContent = "↻ paused"; return; } countLeft = countLeft <= 0 ? 10 : countLeft - 1; $("pollCount").textContent = "↻ " + countLeft + "s"; }
function startPoll() { stopPoll(); countLeft = 10; if (!document.hidden) { pollTimer = setInterval(refreshEmails, 10000); countTimer = setInterval(tickCount, 1000); } }
function stopPoll() { clearInterval(pollTimer); clearInterval(countTimer); pollTimer = null; countTimer = null; }
function openEmail(rows, index) { const message = rows[index]; activeEmailId = message.id; if (!message.is_read) { message.is_read = 1; cacheWrite("emails", activeAddr, rows); api(accountPath("/emails/") + encodeURIComponent(message.id), { method: "PATCH" }).catch(() => {}); } $("contentEmpty").hidden = true; $("contentBody").hidden = false; $("cFrom").textContent = message.from_addr; $("cSubject").textContent = message.subject || "(no subject)"; $("cDate").textContent = new Date(message.received_at).toLocaleString(); $("cBody").textContent = message.body_text || message.body_html || ""; document.querySelectorAll(".list-item").forEach((item, itemIndex) => { item.classList.toggle("active", itemIndex === index); if (itemIndex === index) item.classList.remove("unread"); }); updateUnread(rows); setUnreadBadge(activeAddr, rows.filter((item) => !item.is_read).length); mobileView("content"); }
function showContentEmpty() { $("contentEmpty").hidden = false; $("contentBody").hidden = true; }
function showEmpty(clearList = true) { showContentEmpty(); if (clearList) { document.title = "KwikEmail"; $("listHeader").textContent = "Select an address"; $("purgeBtn").hidden = true; $("listUnread").hidden = true; $("emailList").replaceChildren(); } }
function renderSettings() {
  const root = $("accountsList"); root.replaceChildren();
  accounts.forEach((account) => {
    const section = document.createElement("section"); section.className = "account-control";
    const header = document.createElement("header"); header.className = "account-control-head";
    const nameWrap = document.createElement("div"); nameWrap.className = "account-name";
    const title = document.createElement("h2"); title.textContent = account.name;
    const rename = document.createElement("button"); rename.type = "button"; rename.className = "rename-button"; rename.setAttribute("aria-label", `Rename ${account.name}`); rename.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11.8-.5 2.2 2.2-.5 7.5-7.5-1.7-1.7L3 11.8Zm8.3-8.3 1-1a1.2 1.2 0 0 1 1.7 1.7l-1 1-1.7-1.7Z"/></svg>';
    const edit = document.createElement("form"); edit.className = "rename-form"; const input = document.createElement("input"); input.value = account.name; input.maxLength = 80; input.setAttribute("aria-label", "Mailbox name"); const save = document.createElement("button"); save.type = "submit"; save.className = "rename-save"; save.setAttribute("aria-label", "Save mailbox name"); save.textContent = "✓"; edit.append(input, save);
    const cancel = () => { edit.hidden = true; title.hidden = false; rename.hidden = false; input.value = account.name; };
    rename.onclick = () => { title.hidden = true; rename.hidden = true; edit.hidden = false; input.focus(); input.select(); };
    input.onkeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    edit.onsubmit = async (event) => { event.preventDefault(); const name = input.value.trim(); if (!name || name === account.name) return cancel(); save.disabled = true; try { const response = await fetch(`/control/accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "Rename failed"); Object.assign(account, result); title.textContent = account.name; rename.setAttribute("aria-label", `Rename ${account.name}`); [...$("accountSelect").options].find(({ value }) => value === account.id).textContent = account.name; cancel(); toast("Mailbox name updated"); } catch (error) { state.textContent = error.message; } finally { save.disabled = false; } };
    edit.hidden = true; nameWrap.append(title, rename, edit);
    const state = document.createElement("p"); state.className = `deployment-state state-${account.status}`; state.textContent = account.status.replaceAll("_", " ") + (account.last_error ? ` · ${account.last_error}` : "");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Delete deployment"; remove.onclick = async () => { const confirm = prompt(`Delete Worker, D1, routing rules, mailboxes, and archive. Type ${account.worker_name} to confirm.`); if (confirm !== account.worker_name) return; remove.disabled = true; try { const response = await fetch(`/control/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "Delete failed"); localStorage.clear(); location.href = "/setup.html"; } catch (error) { state.textContent = error.message; remove.disabled = false; } };
    header.append(nameWrap, state, remove);
    const details = document.createElement("div"); details.className = "account-details";
    const worker = document.createElement("p"); worker.innerHTML = `<span>Worker</span><code>${esc(account.worker_name || "Not deployed")}</code>`;
    const domains = document.createElement("p"); domains.innerHTML = `<span>Domains</span><code>${esc((account.domains || []).filter(({ enabled }) => enabled !== 0).map(({ name }) => name).join(", ") || "None")}</code>`;
    details.append(worker, domains); section.append(header, details);
    if (account.status !== "ready") { const retry = document.createElement("button"); retry.type = "button"; retry.className = "retry-button"; retry.textContent = "Retry deployment"; retry.onclick = async () => { retry.disabled = true; try { const response = await fetch(`/control/accounts/${encodeURIComponent(account.id)}/deploy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "Retry failed"); const stream = new EventSource(`/setup/jobs/${encodeURIComponent(result.jobId)}/events`); stream.addEventListener("status", (event) => { const value = JSON.parse(event.data); state.textContent = String(value.status || "working").replaceAll("_", " ") + (value.last_error || value.message ? ` · ${value.last_error || value.message}` : ""); if (["ready", "error"].includes(value.status)) { stream.close(); retry.disabled = value.status === "ready"; } }); } catch (error) { state.textContent = error.message; retry.disabled = false; } }; section.append(retry); }
    root.append(section);
  });
}

$("accountSelect").onchange = (event) => switchAccount(event.target.value);
$("createAddr").onclick = async () => { const localPart = $("newLocal").value.trim(); const domain = $("domainSelect").value; $("addressError").textContent = ""; if (!localPart || !domain) { $("addressError").textContent = "Choose a domain and enter a local part."; return; } try { const result = await api(accountPath("/addresses"), { method: "POST", body: JSON.stringify({ localPart, domain }) }); $("newLocal").value = ""; await loadAddresses(); await selectAddress(result.address); toast("Created " + result.address); } catch (error) { $("addressError").textContent = error.message; } };
$("newLocal").onkeydown = (event) => { if (event.key === "Enter") $("createAddr").click(); };
$("purgeBtn").onclick = async () => { if (!activeAddr || !confirm("Purge all emails in " + activeAddr + "?")) return; try { const result = await api(accountPath("/emails?address=") + encodeURIComponent(activeAddr), { method: "DELETE" }); localStorage.removeItem(cacheKey("emails", activeAddr)); activeEmailId = null; await refreshEmails(); toast("Purged " + result.deleted + " emails"); } catch (error) { toast("Purge failed: " + error.message, true); } };
$("backAddresses").onclick = () => mobileView("addresses");
$("backMessages").onclick = () => mobileView("messages");
let panelStep = 0;
const panelMotion = { duration: 220, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "both" };
async function closePanel(panel) {
  const step = ++panelStep;
  panel.dispatchEvent(new Event("panelclose"));
  panel.getAnimations().forEach((animation) => animation.cancel());
  await panel.animate([{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(100%)" }], panelMotion).finished;
  if (step === panelStep) { panel.classList.remove("open"); panel.hidden = true; }
}
async function openPanel(panel) {
  const step = ++panelStep, other = panel === $("accountsPanel") ? $("settingsPanel") : $("accountsPanel");
  panel.hidden = false; panel.classList.add("open"); panel.style.zIndex = 11; panel.getAnimations().forEach((animation) => animation.cancel());
  const incoming = panel.animate([{ opacity: 0, transform: "translateX(100%)" }, { opacity: 1, transform: "translateX(0)" }], panelMotion).finished;
  if (!other.hidden) { other.dispatchEvent(new Event("panelclose")); other.style.zIndex = 10; other.getAnimations().forEach((animation) => animation.cancel()); other.animate([{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(100%)" }], panelMotion).finished.then(() => { if (step === panelStep) { other.classList.remove("open"); other.hidden = true; } }); }
  await incoming;
}
$("accountsPanel").addEventListener("panelclose", renderSettings);
$("accountsBtn").onclick = () => $("accountsPanel").hidden ? openPanel($("accountsPanel")) : closePanel($("accountsPanel"));
$("closeAccounts").onclick = () => closePanel($("accountsPanel"));
$("settingsBtn").onclick = () => $("settingsPanel").hidden ? openPanel($("settingsPanel")) : closePanel($("settingsPanel"));
$("closeSettings").onclick = () => { $("passwordForm").reset(); $("passwordForm").querySelector(".inline-error").textContent = ""; closePanel($("settingsPanel")); };
document.addEventListener("click", (event) => { if (event.target.closest(".control-panel, #accountsBtn, #settingsBtn")) return; [$("accountsPanel"), $("settingsPanel")].filter((panel) => !panel.hidden).forEach(closePanel); });
$("passwordForm").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget, status = form.querySelector(".inline-error"), body = Object.fromEntries(new FormData(form));
  status.textContent = "";
  if (body.newPassword !== body.confirmation) { status.textContent = "Password confirmation does not match."; return; }
  const button = form.querySelector("button"); button.disabled = true;
  try { const response = await fetch("/control/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "Password change failed"); clearMailCache(); form.reset(); toast("Password changed"); }
  catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
};
$("logoutForm").onsubmit = async (event) => { event.preventDefault(); await fetch("/logout", { method: "POST" }); clearMailCache(); location.href = "/"; };
document.addEventListener("visibilitychange", () => { if (document.hidden) stopPoll(); else if (activeAddr) startPoll(); });
Object.keys(localStorage).forEach((key) => { if (key.startsWith("kwikemail_req_") && !key.startsWith("kwikemail_req_" + new Date().toISOString().slice(0, 10) + "_")) localStorage.removeItem(key); });
showBudget();
loadAccounts();
setInterval(loadMetrics, 60000);
