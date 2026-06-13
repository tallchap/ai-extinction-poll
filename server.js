const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RENDER_DISK_PATH || __dirname;
const DATA_FILE = path.join(DATA_DIR, "votes.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (Array.isArray(parsed.entries)) return parsed.entries.filter((n) => typeof n === "number");
    return [];
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ entries }));
  } catch (err) {
    console.error("Failed to save entries:", err.message);
  }
}

let entries = loadEntries();

function summarize() {
  const buckets = { lt10: 0, "10to25": 0, gt25: 0 };
  for (const v of entries) {
    if (v < 10) buckets.lt10++;
    else if (v <= 25) buckets["10to25"]++;
    else buckets.gt25++;
  }
  const n = entries.length;
  const mean = n ? entries.reduce((a, b) => a + b, 0) / n : null;
  let median = null;
  if (n) {
    const sorted = [...entries].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return { buckets, count: n, mean, median };
}

app.get("/api/results", (req, res) => {
  res.json(summarize());
});

app.post("/api/vote", (req, res) => {
  const value = Number(req.body && req.body.value);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return res.status(400).json({ error: "value must be a number between 0 and 100" });
  }
  entries.push(value);
  saveEntries(entries);
  res.json(summarize());
});

app.post("/api/reset", (req, res) => {
  entries = [];
  saveEntries(entries);
  res.json(summarize());
});

app.listen(PORT, () => {
  console.log(`AI extinction poll running on port ${PORT}`);
});
