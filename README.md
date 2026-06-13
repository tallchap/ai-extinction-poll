# AI Extinction Risk Poll

A single-question poll site. Asks:

> What probability do you put on future AI advances causing human extinction or similarly permanent and severe disempowerment of the human species within the next 100 years?

Respondents **type a number** (their P(doom) %, 0–100). Results display as a live **vertical bar chart** of three buckets — **< 10%**, **10–25%**, **> 25%** — alongside the **mean** and **median** P(doom). A reset button at the bottom clears all entries. A QR code (`public/qr.png`, also shown in-page) links to the live site for audiences to scan.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Render

Push this repo to GitHub, then in Render: **New → Blueprint** and point it at the repo (uses `render.yaml`). Or **New → Web Service** with:

- Build command: `npm install`
- Start command: `npm start`

Render sets `PORT` automatically.

### Note on persistence
Votes are stored in `votes.json` on the instance's local disk. On Render's free plan this resets when the instance restarts/redeploys. For durable storage, attach a Render Disk and set `RENDER_DISK_PATH` to its mount path, or swap in a database.
