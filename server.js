require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Item = require("./models/Item");
const User = require("./models/User");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Connect to MongoDB
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI).then(() => console.log("📦 Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB connection error:", err));
} else {
  console.error("❌ MONGODB_URI missing in .env file");
}

function findIndex(db, name) {
  return db.findIndex(i => i.item.toLowerCase() === name.toLowerCase());
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "invenbot_fallback_secret";

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized: missing token" });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized: invalid token" });
  }
}

const SYSTEM_PROMPT = `You are InvenBot, a smart inventory management AI assistant.

You will receive the CURRENT INVENTORY data followed by the USER's message.

Your job is to understand what the user wants and return a structured JSON response.

RESPOND ONLY with this JSON format (no text outside JSON, no markdown):
{
  "action": "ACTION_NAME",
  "data": { ...fields depending on action... },
  "reply": "A friendly, natural reply to show the user"
}

SUPPORTED ACTIONS & their data fields:

GREET          → data: {}                               (user says hello, hi, how are you, etc.)
ADD_ITEM       → data: { item, quantity, cost_price?, selling_price? }
SELL_ITEM      → data: { item, quantity, selling_price? }   (selling_price is the price user says during this sale, e.g. 'sell 2 bags at 120rs' → selling_price: 120)
SHOW_ALL       → data: {}                               (show all inventory)
SHOW_ITEM      → data: { item }                         (show one item details)
SHOW_STOCK     → data: {}                               (show current available stock)
DELETE_ITEM    → data: { item }
UPDATE_PRICE   → data: { item, cost_price?, selling_price? }
SET_THRESHOLD  → data: { item, threshold }              (set specific low stock alert threshold for an item. Default is 20)
PROFIT         → data: { item? }                        (profit for one item or all)
SELLING_REPORT → data: { item? }                        (sales report for one or all)
UNKNOWN        → data: {}                               (cannot understand the request)
LOW_STOCK       → data: { threshold? }
TOP_SELLING     → data: {}
SUMMARY         → data: {}
HELP            → data: {}
OUT_OF_STOCK    → data: {}
FILTER_DATE     → data: { start_date, end_date? }          (filter sales, revenue, profit, or loss by date/range. format: YYYY-MM-DD. translate 'today/yesterday' etc)
SALES_HISTORY   → data: { item? }                          (show full sales history log for one item or all items)
STOCK_HISTORY   → data: { item? }                          (show full stock-in history log for one item or all items)
RESET_INVENTORY → data: {}                                  (permanently delete ALL items, sales, and stock history)

RULES:
- ALWAYS return valid JSON only — no markdown, no backticks, no extra text
- The "reply" field must be a short, friendly message (1-2 sentences max)
- For GREET, reply warmly and mention you manage inventory
- For UNKNOWN, politely explain you only handle inventory tasks
- Extract numbers and item names accurately from the user's message
- If user says "add 10 laptops at cost 500 sell 800" → extract all values
- If quantity/price is missing for ADD_ITEM, still use action ADD_ITEM and mention in reply what is missing
- LOW_STOCK → return items where current_stock is below threshold (default 10)
- TOP_SELLING → return the item with highest quantity_sold
- SUMMARY → return total items, total stock, total profit
- HELP → return a list of supported commands
- OUT_OF_STOCK → return items where current_stock is 0
- FILTER_DATE → compute the exact YYYY-MM-DD dates from user input (e.g. "April 10" -> "2026-04-10"). Put single date in start_date.
- If user asks for profit, sales, P&L, or report on a SPECIFIC DATE or RANGE, use FILTER_DATE action.
- SALES_HISTORY → show per-transaction sales log with date, item, quantity, and revenue
- STOCK_HISTORY → show per-transaction stock received log with date, item, and quantity added

CRITICAL: Your entire response must be a single valid JSON object and nothing else. No markdown, no code fences, no backticks, no intro text, no trailing text. Start with { and end with }.`;

async function buildPrompt(userMsg, userId) {
  const db = await Item.find({ userId }).lean();

  // Filter out bulky history logs to save tokens
  const minimizedInv = db.map(i => ({
    item: i.item,
    stock_in: i.stock_in,
    stock_out: i.stock_out,
    current_stock: i.stock_in - i.stock_out,
    cost_price: i.cost_price,
    selling_price: i.selling_price,
    quantity_sold: i.quantity_sold,
    threshold: i.threshold
  }));

  const inv = db.length > 0
    ? JSON.stringify(minimizedInv, null, 2)
    : "[ No items in inventory yet ]";
  const today = new Date().toLocaleDateString('sv-SE');
  return `TODAY'S DATE is ${today}\nCURRENT INVENTORY:\n${inv}\n\nUSER MESSAGE: ${userMsg}`;
}

async function executeAction(action, data, userId) {
  let tableData = null;
  let errorReply = null; // overrides reply when execution fails

  let db = await Item.find({ userId });

  switch (action) {

    case "ADD_ITEM": {
      if (!data.item || !data.quantity) break;

      const idx = findIndex(db, data.item);

      if (idx >= 0) {
        db[idx].stock_in += Number(data.quantity);

        if (data.cost_price) db[idx].cost_price = Number(data.cost_price);
        if (data.selling_price) db[idx].selling_price = Number(data.selling_price);

        // Add date for stock in
        if (!db[idx].stock_history) db[idx].stock_history = [];

        db[idx].stock_history.push({
          quantity: Number(data.quantity),
          date: new Date().toLocaleDateString('sv-SE')
        });
        await db[idx].save();

      } else {
        const newItem = new Item({
          userId,
          item: data.item,
          stock_in: Number(data.quantity),
          stock_out: 0,
          cost_price: Number(data.cost_price) || 0,
          selling_price: Number(data.selling_price) || 0,
          quantity_sold: 0,

          // Initial date entry
          stock_history: [{
            quantity: Number(data.quantity),
            date: new Date().toLocaleDateString('sv-SE')
          }],

          sales_history: [] // keep empty initially
        });
        await newItem.save();
        db.push(newItem);
      }

      tableData = [{
        item: data.item,
        added: data.quantity,
        total_stock: db[findIndex(db, data.item)].stock_in
      }];

      break;
    }

    case "SELL_ITEM": {
      if (!data.item || !data.quantity) break;

      const idx = findIndex(db, data.item);
      if (idx < 0) break;

      const available = db[idx].stock_in - db[idx].stock_out;
      const qty = Number(data.quantity);

      if (qty > available) {
        errorReply = `⚠️ Not enough stock! Only ${available} ${data.item}(s) available. Cannot sell ${qty}.`;
        break;
      }

      // Use price from the current sale command if provided, else use stored selling_price
      const salePrice = data.selling_price ? Number(data.selling_price) : db[idx].selling_price;

      // Update stock
      db[idx].stock_out += qty;
      db[idx].quantity_sold += qty;

      const today = new Date().toLocaleDateString('sv-SE');
      if (!db[idx].sales_history) db[idx].sales_history = [];

      db[idx].sales_history.push({
        quantity: qty,
        date: today,
        actual_price: salePrice   // store the actual price used for this transaction
      });

      await db[idx].save();

      const revenue = salePrice * qty;
      const pl = (salePrice - db[idx].cost_price) * qty;

      tableData = [{
        item: data.item,
        sold: qty,
        sale_price: salePrice,
        remaining_stock: available - qty,
        revenue,
        profit: pl > 0 ? pl : 0,
        loss: pl < 0 ? Math.abs(pl) : 0
      }];

      break;
    }

    case "DELETE_ITEM": {
      const idx = findIndex(db, data.item);
      if (idx >= 0) {
        await Item.deleteOne({ _id: db[idx]._id, userId });
        db.splice(idx, 1);
      }
      break;
    }

    case "UPDATE_PRICE": {
      const idx = findIndex(db, data.item);
      if (idx >= 0) {
        if (data.cost_price) db[idx].cost_price = Number(data.cost_price);
        if (data.selling_price) db[idx].selling_price = Number(data.selling_price);
        await db[idx].save();
        tableData = [{ item: db[idx].item, cost_price: db[idx].cost_price, selling_price: db[idx].selling_price }];
      }
      break;
    }

    case "SHOW_ALL": {
      tableData = db.map(i => ({
        item: i.item,
        stock_in: i.stock_in,
        stock_out: i.stock_out,
        current_stock: i.stock_in - i.stock_out,
        cost_price: i.cost_price,
        selling_price: i.selling_price
      }));
      break;
    }

    case "SHOW_STOCK": {
      tableData = db.map(i => ({
        item: i.item,
        stock_in: i.stock_in,
        sold: i.quantity_sold,
        current_stock: i.stock_in - i.stock_out
      }));
      break;
    }

    case "SHOW_ITEM": {
      const idx = findIndex(db, data.item || "");
      if (idx >= 0) {
        const i = db[idx];

        // Calculate total profit/loss from sales history
        let totalPL = 0;
        (i.sales_history || []).forEach(s => {
          const txPrice = s.actual_price != null ? s.actual_price : (i.selling_price || 0);
          totalPL += s.quantity * (txPrice - (i.cost_price || 0));
        });

        tableData = [{
          item: i.item,
          current_stock: i.stock_in - i.stock_out,
          total_received: i.stock_in,
          total_sold: i.quantity_sold,
          cost_price: i.cost_price,
          selling_price: i.selling_price,
          profit: totalPL > 0 ? totalPL : 0,
          loss: totalPL < 0 ? Math.abs(totalPL) : 0
        }];
      }
      break;
    }

    case "SELLING_REPORT": {
      let items = db;
      if (data.item) {
        const idx = findIndex(db, data.item);
        items = idx >= 0 ? [db[idx]] : [];
      }
      tableData = items.map(i => ({
        item: i.item,
        quantity_sold: i.quantity_sold,
        selling_price: i.selling_price,
        total_revenue: i.quantity_sold * i.selling_price
      }));
      break;
    }

    case "PROFIT": {
      let items = db;
      if (data.item) {
        const idx = findIndex(db, data.item);
        items = idx >= 0 ? [db[idx]] : [];
      }
      tableData = items.map(i => {
        let totalPL = 0;
        (i.sales_history || []).forEach(s => {
          const txPrice = s.actual_price != null ? s.actual_price : (i.selling_price || 0);
          totalPL += s.quantity * (txPrice - (i.cost_price || 0));
        });

        return {
          item: i.item,
          quantity_sold: i.quantity_sold,
          cost_price: i.cost_price,
          selling_price: i.selling_price,
          profit: totalPL
        };
      });
      break;
    }
    case "SET_THRESHOLD": {
      if (!data.item || data.threshold == null) break;
      const idx = findIndex(db, data.item);
      if (idx >= 0) {
        db[idx].threshold = Number(data.threshold);
        await db[idx].save();
        tableData = [{ item: data.item, alert_threshold: db[idx].threshold }];
      }
      break;
    }

    case "LOW_STOCK": {
      tableData = db
        .filter(i => (i.stock_in - i.stock_out) <= (data.threshold || i.threshold || 20))
        .map(i => ({
          item: i.item,
          current_stock: i.stock_in - i.stock_out,
          alert_threshold: i.threshold || 20
        }));
      break;
    }

    case "TOP_SELLING": {
      if (db.length === 0) break;
      const top = db.reduce((a, b) => (a.quantity_sold > b.quantity_sold ? a : b));
      tableData = [{
        item: top.item,
        quantity_sold: top.quantity_sold
      }];
      break;
    }

    case "SUMMARY": {
      const totalItems = db.length;
      const totalStock = db.reduce((sum, i) => sum + (i.stock_in - i.stock_out), 0);

      const totalProfit = db.reduce((sum, i) => {
        let itemPL = 0;
        (i.sales_history || []).forEach(s => {
          const txPrice = s.actual_price != null ? s.actual_price : (i.selling_price || 0);
          itemPL += s.quantity * (txPrice - (i.cost_price || 0));
        });
        return sum + itemPL;
      }, 0);

      tableData = [{
        total_items: totalItems,
        total_stock: totalStock,
        total_profit: totalProfit
      }];
      break;
    }

    case "HELP": {
      tableData = [
        { command: "add [qty] [item]", description: "Add items or stock (e.g., 'add 10 laptops at cost 500 sell 800')" },
        { command: "sell [qty] [item]", description: "Record a sale (e.g., 'sell 2 laptops at 1200rs')" },
        { command: "show all", description: "View full inventory list" },
        { command: "show stock", description: "Check available stock for everything" },
        { command: "show [item]", description: "Check details of a specific item" },
        { command: "delete [item]", description: "Remove an item completely" },
        { command: "update [item] price", description: "Change cost or selling price of an item" },
        { command: "profit", description: "Calculate overall profit or profit for an item" },
        { command: "selling report", description: "View total revenue and sold items" },
        { command: "sales on [date]", description: "View sales on a specific date or date range" },
        { command: "sales history", description: "View the complete sale transaction history" },
        { command: "stock history", description: "View the complete stock received history" },
        { command: "low stock", description: "Show items triggered by alert threshold" },
        { command: "set threshold", description: "Set custom low-stock alert point (e.g., 'set threshold for bag to 5')" },
        { command: "top selling", description: "Find the most sold item" },
        { command: "summary", description: "Quick totals overview" },
        { command: "help", description: "Show this command list" }
      ];
      break;
    }

    case "OUT_OF_STOCK": {
      tableData = db
        .filter(i => (i.stock_in - i.stock_out) === 0)
        .map(i => ({
          item: i.item,
          current_stock: 0
        }));
      break;
    }
    case "SALES_TODAY": {
      const today = new Date().toLocaleDateString('sv-SE');

      tableData = db
        .map(item => {
          const todaySales = (item.sales_history || [])
            .filter(s => s.date.startsWith(today))
            .reduce((sum, s) => sum + s.quantity, 0);

          return {
            item: item.item,
            sold_today: todaySales
          };
        })
        .filter(i => i.sold_today > 0);

      break;
    }
    case "SALES_WEEK": {
      const now = new Date();
      const weekAgo = new Date();
      weekAgo.setDate(now.getDate() - 7);

      tableData = db
        .map(item => {
          const weekSales = (item.sales_history || [])
            .filter(s => new Date(s.date) >= weekAgo)
            .reduce((sum, s) => sum + s.quantity, 0);

          return {
            item: item.item,
            sold_this_week: weekSales
          };
        })
        .filter(i => i.sold_this_week > 0);

      break;
    }

    case "SALES_HISTORY": {
      let items = db;
      if (data.item) {
        const idx = findIndex(db, data.item);
        items = idx >= 0 ? [db[idx]] : [];
      }
      tableData = [];
      items.forEach(item => {
        (item.sales_history || []).forEach(s => {
          const txPrice = s.actual_price != null ? s.actual_price : (item.selling_price || 0);
          const rev = s.quantity * txPrice;
          const pl = s.quantity * (txPrice - (item.cost_price || 0));
          tableData.push({
            date: (s.date || "").split("T")[0],
            item: item.item,
            quantity_sold: s.quantity,
            sale_price: txPrice,
            revenue: rev,
            profit: pl > 0 ? pl : 0,
            loss: pl < 0 ? Math.abs(pl) : 0
          });
        });
      });
      // Sort by date descending
      tableData.sort((a, b) => b.date.localeCompare(a.date));
      if (tableData.length === 0) tableData = [{ message: "No sales history recorded yet." }];
      break;
    }

    case "STOCK_HISTORY": {
      let items = db;
      if (data.item) {
        const idx = findIndex(db, data.item);
        items = idx >= 0 ? [db[idx]] : [];
      }
      tableData = [];
      items.forEach(item => {
        (item.stock_history || []).forEach(s => {
          tableData.push({
            item: item.item,
            date: s.date.split("T")[0],
            quantity_added: s.quantity
          });
        });
      });
      tableData.sort((a, b) => b.date.localeCompare(a.date));
      if (tableData.length === 0) tableData = [{ message: "No stock history recorded yet." }];
      break;
    }

    case "RESET_INVENTORY": {
      await Item.deleteMany({ userId });
      db = [];
      tableData = [{ message: "All inventory data has been permanently cleared." }];
      break;
    }
    case "FILTER_DATE": {
      if (!data.start_date && !data.end_date) {
        tableData = [{ error: "Please specify a valid date." }];
        break;
      }

      const start = data.start_date || "2000-01-01"; // Default to old date if "before X"
      const end = data.end_date || data.start_date;  // If only start is given, assume exact day match

      tableData = db
        .map(item => {
          let qty = 0;
          let rev = 0;
          let cost = 0;
          (item.sales_history || []).forEach(s => {
            const sDate = (s.date || "").split("T")[0];
            if (sDate >= start && sDate <= end) {
              // Use actual_price stored per transaction if available
              const txPrice = s.actual_price != null ? s.actual_price : (item.selling_price || 0);
              qty += s.quantity;
              rev += s.quantity * txPrice;
              cost += s.quantity * (item.cost_price || 0);
            }
          });
          const pl = rev - cost;
          return {
            item: item.item,
            quantity_sold: qty,
            revenue: rev,
            cost_of_goods: cost,
            profit: pl > 0 ? pl : 0,
            loss: pl < 0 ? Math.abs(pl) : 0
          };
        })
        .filter(i => i.quantity_sold > 0);

      if (tableData.length === 0) {
        tableData = [{ message: "No sales found for the specified date(s)." }];
      }
      break;
    }
  }


  return { tableData, errorReply };
}

// Intercepts common date queries so they never need remote parsing
async function tryLocalIntent(message, userId) {
  const msg = message.toLowerCase().trim();

  // Match ISO date: YYYY-MM-DD
  const isoDate = /(\d{4}-\d{2}-\d{2})/;
  // Match natural dates: "april 14", "14 april", "apr 14"
  const naturalDate = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b|\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

  const monthMap = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

  // Keywords indicating date-based analysis
  const isDateQuery = /profit|loss|p&l|pnl|revenue|sales|sold|report/.test(msg);
  if (!isDateQuery) return null;

  let startDate = null, endDate = null;

  // Try ISO date range: "2026-04-10 to 2026-04-15"
  const isoRange = message.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
  if (isoRange) {
    startDate = isoRange[1];
    endDate = isoRange[2];
  } else {
    // Single ISO date
    const isoMatch = message.match(isoDate);
    if (isoMatch) {
      startDate = isoMatch[1];
      endDate = isoMatch[1];
    }
  }

  // Handle "today" / "yesterday"
  if (!startDate) {
    const today = new Date();
    if (/\btoday\b/.test(msg)) {
      startDate = endDate = today.toLocaleDateString('sv-SE');
    } else if (/\byesterday\b/.test(msg)) {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      startDate = endDate = y.toLocaleDateString('sv-SE');
    }
  }

  // Natural date (e.g., "april 14")
  if (!startDate) {
    const nm = msg.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\b/i) ||
      msg.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i);
    if (nm) {
      let month, day;
      if (isNaN(nm[1])) { month = monthMap[nm[1].toLowerCase()]; day = parseInt(nm[2]); }
      else { day = parseInt(nm[1]); month = monthMap[nm[2].toLowerCase()]; }
      const year = new Date().getFullYear();
      startDate = endDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  if (!startDate) return null; // couldn't parse a date — fallback to remote processing

  // Execute FILTER_DATE directly
  const { tableData } = await executeAction("FILTER_DATE", { start_date: startDate, end_date: endDate }, userId);

  const label = startDate === endDate ? startDate : `${startDate} → ${endDate}`;
  const hasData = tableData && tableData.length > 0 && !tableData[0].message;
  const reply = hasData
    ? `Here is the profit & loss report for ${label}.`
    : `No sales recorded on ${label}.`;

  return { action: "FILTER_DATE", reply, items: tableData };
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const { message } = req.body;
  const userId = req.userId;
  if (!message) return res.status(400).json({ error: "Missing message" });

  const localResult = await tryLocalIntent(message, userId);
  if (localResult) return res.json(localResult);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  try {
    const promptText = await buildPrompt(message, userId);
    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          responseMimeType: "application/json"
        },
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
      })
    });

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) {
      const msg = geminiData?.error?.message || "Gemini API error";
      return res.status(502).json({ error: msg });
    }

    // Parse response
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    console.log("[Gemini raw]:", rawText.slice(0, 500));

    // Robust JSON extraction
    let cleaned = rawText.trim();
    // Strip code fences if present
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    // If still not starting with {, try to extract the first {...} block
    if (!cleaned.startsWith("{")) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) cleaned = match[0];
    }

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (jsonErr) {
      console.error("[JSON parse error]", jsonErr.message, "\nCleaned text:", cleaned.slice(0, 300));
      return res.status(502).json({ error: "Invalid JSON from Gemini. Try rephrasing." });
    }

    // Execute action on database
    const { tableData, errorReply } = await executeAction(parsed.action, parsed.data || {}, userId);

    res.json({
      action: parsed.action || "UNKNOWN",
      reply: errorReply || parsed.reply || "Done!",
      items: tableData
    });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

app.get("/api/inventory", requireAuth, async (req, res) => res.json(await Item.find({ userId: req.userId }).lean()));

// ── Auth Routes ──────────────────────────────────────────────────────────────
// (JWT_SECRET defined above in requireAuth middleware)

// POST /api/auth/signup
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password are required." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: "An account with this email already exists." });

    const user = await User.create({ name, email, password });
    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Server error during signup." });
  }
});

// POST /api/auth/signin
app.post("/api/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required." });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(401).json({ error: "Invalid email or password." });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ error: "Invalid email or password." });

    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ error: "Server error during sign in." });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`\n  ✅  InvenBot running locally → http://localhost:${PORT}`);
    console.log(`  🔒  API key secure  → loaded from .env only`);
    console.log(`  🗄️   Database        → MongoDB Connected\n`);
  });
}

// Required for Vercel
module.exports = app;
