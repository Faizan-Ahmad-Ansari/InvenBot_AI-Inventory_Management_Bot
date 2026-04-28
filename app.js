/* ============================================================
   InvenBot OS — Holographic Redesign
   ============================================================ */

let isProcessing = false;

const chatArea = document.getElementById("chatArea");
const messagesContainer = document.getElementById("messagesContainer");
const welcomeScreen = document.getElementById("welcomeScreen");
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");

// Header / Dash
const serverDot = document.getElementById("serverDot");
const serverStatusText = document.getElementById("serverStatusText");
const floatingDashboard = document.getElementById("floatingDashboard");
const toggleDashboardBtn = document.getElementById("toggleDashboardBtn");

// ── Auth guard ─────────────────────────────────────────────────
(function authGuard() {
  const token = localStorage.getItem("invenbot_token") || sessionStorage.getItem("invenbot_token");
  if (!token) {
    window.location.replace("signin.html");
    return;
  }

  // Populate user info in header
  let firstName = "User";
  let initial = "U";

  // Try stored user object first
  const rawUser = localStorage.getItem("invenbot_user") || sessionStorage.getItem("invenbot_user");
  if (rawUser) {
    try {
      const user = JSON.parse(rawUser);
      firstName = (user.name || "User").split(" ")[0];
      initial = firstName.charAt(0).toUpperCase();
    } catch (_) { }
  } else {
    // Fallback: decode the JWT payload to get the name
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      firstName = ((payload.name || payload.email || "User").split(" ")[0]).split("@")[0];
      initial = firstName.charAt(0).toUpperCase();
    } catch (_) { }
  }

  const avEl = document.getElementById("userAv");
  const nameEl = document.getElementById("userName");
  if (avEl) avEl.textContent = initial;
  if (nameEl) nameEl.textContent = firstName;
})();

// ── Signout ────────────────────────────────────────────────────
document.getElementById("signoutBtn").addEventListener("click", () => {
  localStorage.removeItem("invenbot_token");
  localStorage.removeItem("invenbot_user");
  sessionStorage.removeItem("invenbot_token");
  sessionStorage.removeItem("invenbot_user");
  window.location.href = "signin.html";
});

// ── Auth header helper ──────────────────────────────────────────
function getAuthHeader() {
  const token = localStorage.getItem("invenbot_token") || sessionStorage.getItem("invenbot_token");
  return token ? { "Authorization": "Bearer " + token } : {};
}

(function init() {
  bindEvents();
  checkServerStatus();
  loadDashboardStats();
})();

async function checkServerStatus() {
  try {
    const res = await fetch("/api/inventory", { headers: getAuthHeader() });
    if (res.ok) {
      serverDot.className = "status-dot active";
      serverStatusText.textContent = "Online";
    } else throw new Error();
  } catch (_) {
    serverDot.className = "status-dot inactive";
    serverStatusText.textContent = "Offline";
  }
}

async function loadDashboardStats() {
  try {
    const res = await fetch("/api/inventory", { headers: getAuthHeader() });
    const data = await res.json();

    const items = data.length;
    const availStock = data.reduce((s, i) => s + ((i.stock_in || 0) - (i.stock_out || 0)), 0);
    const sold = data.reduce((s, i) => s + (i.quantity_sold || 0), 0);

    document.getElementById("statItems").textContent = items;
    document.getElementById("statStockIn").textContent = availStock.toLocaleString("en-IN");
    document.getElementById("statSold").textContent = sold.toLocaleString("en-IN");

    let grossProfit = 0, grossLoss = 0;
    const plContainer = document.getElementById("plContainer");

    const plRows = data.map(i => {
      let revenue = 0;
      let cost = 0;

      (i.sales_history || []).forEach(s => {
        const txPrice = s.actual_price != null ? s.actual_price : (i.selling_price || 0);
        revenue += s.quantity * txPrice;
        cost += s.quantity * (i.cost_price || 0);

        const margin = s.quantity * (txPrice - (i.cost_price || 0));
        if (margin >= 0) grossProfit += margin;
        else grossLoss += Math.abs(margin);
      });

      const pl = revenue - cost;
      return { item: i.item, pl, revenue, cost };
    }).filter(r => r.pl !== 0 || r.revenue > 0);

    if (plRows.length === 0) {
      plContainer.innerHTML = `<span class="pl-loading">No sales yet.</span>`;
    } else {
      plContainer.innerHTML = plRows.map(r => {
        const isProfit = r.pl >= 0;
        const sign = isProfit ? "+" : "-";
        const color = isProfit ? "var(--neon-green)" : "var(--neon-red)";
        return `
          <div class="pl-item">
            <span class="pl-name">${escapeHtml(r.item)}</span>
            <span class="pl-val" style="color:${color}">${sign}₹${Math.abs(r.pl).toLocaleString("en-IN")}</span>
          </div>`;
      }).join("");
    }

    const netProfit = grossProfit - grossLoss;
    const profitEl = document.getElementById("statProfit");
    profitEl.textContent = (netProfit >= 0 ? "+" : "-") + "₹" + Math.abs(netProfit).toLocaleString("en-IN");
    profitEl.style.color = netProfit >= 0 ? "var(--neon-green)" : "var(--neon-red)";

    document.getElementById("statLoss").textContent = "₹" + grossLoss.toLocaleString("en-IN");

    // Alerts
    const lowStockContainer = document.getElementById("lowStockContainer");
    const pulseDot = document.querySelector(".pulse-dot");
    const stockItems = data.map(i => ({ ...i, current: i.stock_in - (i.stock_out || 0) }));
    const low = stockItems.filter(i => i.current <= (i.threshold || 20)).sort((a, b) => a.current - b.current);

    if (low.length > 0) {
      if (pulseDot) pulseDot.style.display = "block";
      lowStockContainer.innerHTML = low.slice(0, 5).map(i => `
        <div class="alert-item">
          <span>${escapeHtml(i.item)}</span>
          <span class="item-stock">! ${i.current} left (Thresh: ${i.threshold || 20})</span>
        </div>
      `).join("");
    } else {
      if (pulseDot) pulseDot.style.display = "none";
      lowStockContainer.innerHTML = `<span>All items optimal.</span>`;
    }
  } catch (e) { }
}

function bindEvents() {
  sendBtn.addEventListener("click", handleSend);
  userInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
  });

  document.getElementById("clearChatBtn").addEventListener("click", () => {
    messagesContainer.innerHTML = "";
    welcomeScreen.classList.remove("hidden");
    showToast("Comm-link cleared", "success");
  });

  if (toggleDashboardBtn) {
    toggleDashboardBtn.addEventListener("click", () => {
      floatingDashboard.classList.toggle("hidden");
    });
  }

  document.getElementById("refreshStatsBtn").addEventListener("click", () => {
    loadDashboardStats();
    showToast("Dashboard synchronized");
  });

  document.getElementById("exportBtn").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/inventory", { headers: getAuthHeader() });
      const data = await res.json();

      if (!data || data.length === 0) {
        showToast("No data to export", "error");
        return;
      }

      if (typeof XLSX !== "undefined") {
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Inventory");
        XLSX.writeFile(wb, "invenbot_backup.xlsx");
        showToast("Excel sheet exported successfully");
      } else {
        // Fallback to CSV if library fails to load
        const keys = Object.keys(data[0]);
        let csv = keys.join(",") + "\n";
        data.forEach(row => {
          csv += keys.map(k => {
            let val = row[k] != null ? String(row[k]) : "";
            if (val.search(/("|,|\n)/g) >= 0) val = '"' + val.replace(/"/g, '""') + '"';
            return val;
          }).join(",") + "\n";
        });
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "invenbot_backup.csv"; a.click(); URL.revokeObjectURL(url);
        showToast("Excel (CSV) exported successfully");
      }
    } catch (e) { showToast("Export failed", "error"); }
  });

  // Action queries
  document.querySelectorAll("[data-query]").forEach(btn => {
    btn.addEventListener("click", () => {
      userInput.value = btn.dataset.query;
      handleSend();
    });
  });
}

async function handleSend() {
  const msg = userInput.value.trim();
  if (!msg || isProcessing) return;

  welcomeScreen.classList.add("hidden");
  appendMessage("user", msg);
  userInput.value = "";
  userInput.style.height = "auto";

  const typingId = appendTyping();
  isProcessing = true;
  sendBtn.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    removeEl(typingId);

    if (!res.ok) appendError(data.error || `Error ${res.status}`);
    else {
      appendBotResponse(data);
      const acts = ["ADD_ITEM", "SELL_ITEM", "DELETE_ITEM", "UPDATE_PRICE", "SET_THRESHOLD", "RESET_INVENTORY"];
      if (acts.includes(data.action)) loadDashboardStats();
    }
  } catch (err) {
    removeEl(typingId);
    appendError("Network disconnected. Run npm start on server.");
  } finally {
    isProcessing = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
}

function appendMessage(role, text) {
  const isUser = role === "user";
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.innerHTML = `
    <div class="msg-av">${isUser ? "U" : "IB"}</div>
    <div class="msg-body">
      <div class="msg-bubble">${escapeHtml(text)}</div>
      <div class="msg-time">${formatTime()}</div>
    </div>
  `;
  messagesContainer.appendChild(el);
  scrollBot();
}

function appendBotResponse(data) {
  const el = document.createElement("div");
  el.className = "message bot";
  el.innerHTML = `
    <div class="msg-av">IB</div>
    <div class="msg-body">
      <div class="msg-bubble">${escapeHtml(data.reply || "Acknowledge.")}</div>
      <div class="msg-time">${formatTime()}</div>
    </div>
  `;
  messagesContainer.appendChild(el);

  if (data.items && data.items.length > 0) {
    const body = el.querySelector(".msg-body");
    body.insertBefore(buildTableCard(data.items, data.action), el.querySelector(".msg-time"));
  }
  scrollBot();
}

function appendError(text) {
  const el = document.createElement("div");
  el.className = "message bot";
  el.innerHTML = `
    <div class="msg-av">IB</div>
    <div class="msg-body">
      <div class="msg-bubble error-msg">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        ${escapeHtml(text)}
      </div>
    </div>
  `;
  messagesContainer.appendChild(el);
  scrollBot();
}

function appendTyping() {
  const id = "typ-" + Date.now();
  const el = document.createElement("div");
  el.className = "message bot";
  el.id = id;
  el.innerHTML = `
    <div class="msg-av">IB</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
      </div>
    </div>
  `;
  messagesContainer.appendChild(el);
  scrollBot();
  return id;
}

function buildTableCard(items, action) {
  const keys = Object.keys(items[0]);
  const card = document.createElement("div");
  card.className = "result-card";

  const labels = {
    ADD_ITEM: "Item Logged", SELL_ITEM: "Sale Executed",
    DELETE_ITEM: "Data Purged", UPDATE_PRICE: "Price Sync",
    SHOW_ALL: "Global Inventory", SHOW_STOCK: "Active Stock",
    SHOW_ITEM: "Item Analysis", SELLING_REPORT: "Sales Analytics",
    PROFIT: "Profit Analysis", HELP: "Command Directory",
    FILTER_DATE: "Date Filtered Analytics",
    SALES_HISTORY: "Sales Transaction History",
    STOCK_HISTORY: "Stock Received History",
    SET_THRESHOLD: "Alert Threshold Updated",
    RESET_INVENTORY: "System Purge"
  };

  card.innerHTML = `
    <div class="rc-header">
      <div class="rc-label"><div class="dot"></div>${labels[action] || "Data Query"}</div>
      <button class="icon-btn small" title="Copy Data" onclick="window.copyData(this, '${escapeHtml(JSON.stringify(items).replace(/'/g, "\\'"))}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>
    </div>
    <div class="rc-table-wrap">
      <table>
        <thead><tr>${keys.map(k => `<th>${escapeHtml(k.replace(/_/g, " ").toUpperCase())}</th>`).join("")}</tr></thead>
        <tbody>
          ${items.map(row => `<tr>${keys.map(k => `<td class="${getCls(k)}">${fmt(k, row[k])}</td>`).join("")}</tr>`).join("")}
          ${buildSummary(keys, items)}
        </tbody>
      </table>
    </div>
  `;
  return card;
}

function buildSummary(keys, items) {
  const numKeys = keys.filter(k => typeof items[0][k] === "number");
  if (items.length <= 1 || numKeys.length === 0) return "";
  const totals = {};
  items.forEach(r => numKeys.forEach(k => totals[k] = (totals[k] || 0) + r[k]));
  return `<tr class="summary-row">${keys.map((k, i) => {
    if (i === 0) return `<td>SYS_TOTAL</td>`;
    if (numKeys.includes(k)) return `<td>${fmt(k, totals[k])}</td>`;
    return `<td>—</td>`;
  }).join("")}</tr>`;
}

function getCls(k) {
  const t = k.toLowerCase();
  if (t === "item" || t === "command") return "item-cell";
  if (t.includes("price") || t.includes("revenue") || t.includes("profit") || t.includes("cost") || t.includes("loss")) return "price-cell";
  if (t.includes("stock") || t.includes("quantity") || t.includes("sold")) return "num-cell";
  return "";
}

function fmt(k, v) {
  if (v == null || v === "") return "—";
  const t = k.toLowerCase();
  if (t === "profit" || t === "loss") {
    const num = Number(v);
    if (num === 0) return "₹0";
    if (t === "profit") return `<span style="color:var(--neon-green);text-shadow:0 0 5px rgba(16,185,129,0.3)">+₹${num.toLocaleString("en-IN")}</span>`;
    if (t === "loss") return `<span style="color:var(--neon-red);text-shadow:0 0 5px rgba(239,68,68,0.4)">-₹${num.toLocaleString("en-IN")}</span>`;
  }
  if (t.match(/price|revenue|cost/)) return "₹" + v.toLocaleString("en-IN");
  if (typeof v === "number") return v.toLocaleString("en-IN");
  return escapeHtml(String(v));
}

function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function formatTime() { return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }); }
function scrollBot() { chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: "smooth" }); }
function removeEl(id) { const el = document.getElementById(id); if (el) el.remove(); }

window.copyData = (btn, itemsStr) => {
  navigator.clipboard.writeText(JSON.stringify(JSON.parse(itemsStr), null, 2));
  btn.style.color = "var(--neon-green)";
  setTimeout(() => btn.style.color = "", 2000);
};

function showToast(msg, type = "success") {
  const e = document.querySelector(".toast"); if (e) e.remove();
  const t = document.createElement("div"); t.className = `toast ${type}`;
  t.innerHTML = `<div class="toast-icon">${type === "success" ? "✓" : "!"}</div>${escapeHtml(msg)}`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3000);
}
