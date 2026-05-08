const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const contactSearch = $("contact-search");
const contactSelect = $("contact");
const contactCount = $("contact-count");
const templateSelect = $("template");
const templatePreview = $("template-preview");
const sendBtn = $("send-btn");
const logEl = $("log");
const summaryEl = $("summary");

const state = {
  contacts: [],
  templates: [],
  filtered: []
};

init().catch((err) => {
  setStatus(err.message || String(err), "err");
});

async function init() {
  setStatus("checking setup...", "");
  const status = await fetchJson("/api/status");
  if (status.preflight?.error) {
    setStatus(`Setup error: ${status.preflight.error}`, "err");
    sendBtn.disabled = true;
  } else if (status.preflight?.smtp === "ready" && status.preflight?.imap === "ready") {
    const sender = status.sender || {};
    setStatus(`Ready. Sending as ${sender.name || sender.email || "(unset)"} <${sender.email || "?"}>. Daily limit: ${status.dailyLimit}.`, "ok");
  } else {
    setStatus("Setup not ready. Check server logs.", "err");
    sendBtn.disabled = true;
  }

  const [{ contacts }, { templates }] = await Promise.all([
    fetchJson("/api/contacts"),
    fetchJson("/api/templates")
  ]);

  state.contacts = contacts || [];
  state.templates = templates || [];

  renderTemplates();
  filterContacts("");
  contactSearch.addEventListener("input", () => filterContacts(contactSearch.value));
  templateSelect.addEventListener("change", showTemplatePreview);
  sendBtn.addEventListener("click", startRun);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind || ""}`.trim();
}

function renderTemplates() {
  templateSelect.innerHTML = "";
  const groups = new Map();
  for (const t of state.templates) {
    const key = t.category || "General";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [category, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const og = document.createElement("optgroup");
    og.label = category;
    for (const t of items) {
      const opt = document.createElement("option");
      opt.value = t.name;
      opt.textContent = t.name;
      og.appendChild(opt);
    }
    templateSelect.appendChild(og);
  }
  showTemplatePreview();
}

function showTemplatePreview() {
  const t = state.templates.find((x) => x.name === templateSelect.value);
  if (!t) {
    templatePreview.hidden = true;
    return;
  }
  const subject = (t.subject || "").trim() || "(subject will default to: Hi {{first_name}})";
  templatePreview.textContent = `Subject: ${subject}\n\n${t.body || ""}`;
  templatePreview.hidden = false;
}

function filterContacts(query) {
  const q = String(query || "").trim().toLowerCase();
  const filtered = state.contacts.filter((c) => {
    if (!q) return true;
    return (c.name || "").toLowerCase().includes(q) || (c.company || "").toLowerCase().includes(q);
  });
  state.filtered = filtered;

  contactSelect.innerHTML = "";
  for (const c of filtered.slice(0, 500)) {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    opt.textContent = `${c.name}${c.company ? ` — ${c.company}` : ""}${c.title ? ` (${c.title})` : ""}`;
    contactSelect.appendChild(opt);
  }
  if (filtered.length) {
    contactSelect.value = String(filtered[0].id);
  }
  contactCount.textContent = `${filtered.length} eligible contact${filtered.length === 1 ? "" : "s"}${filtered.length > 500 ? " (showing first 500)" : ""}.`;
}

async function startRun() {
  const contactId = Number(contactSelect.value);
  const templateName = templateSelect.value;
  if (!contactId) {
    appendLog("Pick a contact first.");
    return;
  }
  if (!templateName) {
    appendLog("Pick a template first.");
    return;
  }

  sendBtn.disabled = true;
  logEl.textContent = "";
  summaryEl.hidden = true;
  summaryEl.classList.remove("fail");
  appendLog(`Starting run for contact #${contactId} with template "${templateName}"...`);

  try {
    await streamSend({ contact_id: contactId, template_name: templateName });
  } catch (err) {
    appendLog(`Run error: ${err.message || err}`);
  } finally {
    sendBtn.disabled = false;
  }
}

async function streamSend(body) {
  const response = await fetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    let message;
    try {
      const data = await response.json();
      message = data.error || `${response.status} ${response.statusText}`;
    } catch {
      message = `${response.status} ${response.statusText}`;
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      handleSseBlock(block);
    }
  }
  if (buffer.trim()) handleSseBlock(buffer);
}

function handleSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }

  if (event === "log") {
    appendLog(data.line || "");
  } else if (event === "done") {
    if (data.summary?.note) {
      summaryEl.textContent = data.summary.note;
      summaryEl.classList.toggle("fail", !data.ok);
      summaryEl.hidden = false;
    }
    if (!data.ok && data.error) {
      appendLog(`Done with error: ${data.error}`);
    } else {
      appendLog("Run finished.");
    }
  } else if (event === "error") {
    appendLog(`Server error: ${data.message || ""}`);
    summaryEl.textContent = data.message || "Server error.";
    summaryEl.classList.add("fail");
    summaryEl.hidden = false;
  }
}

function appendLog(text) {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${stamp}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let message;
    try { const data = await response.json(); message = data.error; } catch { /* */ }
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  return response.json();
}
