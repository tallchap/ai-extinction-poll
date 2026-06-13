const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RENDER_DISK_PATH || __dirname;
const DATA_FILE = path.join(DATA_DIR, "votes.json");

const BUCKETS = ["lt10", "10to25", "gt25"];

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadVotes() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { lt10: 0, "10to25": 0, gt25: 0, ...parsed };
  } catch {
    return { lt10: 0, "10to25": 0, gt25: 0 };
  }
}

function saveVotes(votes) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(votes));
  } catch (err) {
    console.error("Failed to save votes:", err.message);
  }
}

let votes = loadVotes();

app.get("/api/results", (req, res) => {
  res.json(votes);
});

app.post("/api/vote", (req, res) => {
  const { bucket } = req.body || {};
  if (!BUCKETS.includes(bucket)) {
    return res.status(400).json({ error: "invalid bucket" });
  }
  votes[bucket] = (votes[bucket] || 0) + 1;
  saveVotes(votes);
  res.json(votes);
});

app.listen(PORT, () => {
  console.log(`AI extinction poll running on port ${PORT}`);
});
