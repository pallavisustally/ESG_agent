# SusTally BRSR Agent (stage3)

A local **BRSR/ESG sustainability analyst** for Indian corporate filings. The application downloads Business Responsibility and Sustainability Report (BRSR) XBRL files, indexes them into SQLite, and answers natural-language questions using an **Ollama tool-calling LLM agent** with SQL grounding and chart generation.

**Location:** `~/Documents/stage3`  
**Web UI:** http://localhost:3000  
**Stack:** Node.js · Express · SQLite · Ollama · Chart.js

---

## What it does

| Capability | Description |
|------------|-------------|
| **BRSR data store** | Indexes sustainability metrics from NSE BRSR XML filings |
| **Natural-language Q&A** | Ask about emissions, water, diversity, sectors, trends |
| **Grounded answers** | Agent uses SQL and report lookups — does not invent numbers |
| **Charts** | Bar/line charts via `json-chart` blocks rendered in the UI |
| **Custom uploads** | Drag-and-drop or attach BRSR XML to index new companies |
| **Chat history** | Sessions saved in browser localStorage |

### Current data (as indexed)

| Metric | Count |
|--------|-------|
| BRSR XML files | ~961 |
| SQLite report rows | ~1,904 |
| Unique companies | ~947 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser UI (Gemini-style)                                  │
│  agent/src/public/  →  index.html · app.js · style.css      │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /api/chat (SSE)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Express Server — agent/src/server.js                       │
│  · Static UI  · Upload  · Reports API  · Chat streaming     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Ollama Agent — agent/src/agent.js                          │
│  Loop: think → tool call → think → answer (+ stream tokens)  │
│  Tools: execute_sql_query · get_company_report · list_*     │
└──────────────┬─────────────────────────────┬────────────────┘
               │                             │
               ▼                             ▼
┌──────────────────────────┐   ┌─────────────────────────────┐
│  Ollama (local LLM)      │   │  SQLite — data/database.db │
│  qwen2.5:7b-instruct     │   │  reports table (ESG metrics) │
└──────────────────────────┘   └─────────────────────────────┘
                                           ▲
                                           │ npm run preprocess
┌──────────────────────────────────────────┴──────────────────┐
│  BRSR XML files — data/xbrl/2025/SYMBOL/*.xml                │
│  Downloaded via npm run download-reports or manual upload      │
└───────────────────────────────────────────────────────────────┘
```

---

## Folder structure

```
stage3/
├── README.md                          ← This file
├── package.json                       ← npm scripts & dependencies
├── .env.example                       ← Configuration template
├── .env                               ← Your local config (create from example)
├── complex_queries_test_bank.md       ← Sample ESG questions for manual testing
│
├── agent/
│   ├── src/
│   │   ├── server.js                  ← Express API + static UI server
│   │   ├── agent.js                   ← Ollama tool-calling agent loop
│   │   ├── db.js                      ← SQLite schema & queries
│   │   ├── ollama-client.js           ← Ollama API + model warm-up
│   │   ├── system-prompt.js           ← Compact ESG analyst instructions
│   │   ├── paths.js                   ← Project path resolution
│   │   └── public/
│   │       ├── index.html             ← Gemini-style chat UI
│   │       ├── app.js                 ← Frontend logic (SSE, charts, sessions)
│   │       └── style.css              ← Light/dark Gemini theme
│   │
│   └── scripts/
│       ├── preprocess.js              ← XML → SQLite indexer
│       ├── download_nse_reports.js    ← NSE BRSR downloader (Puppeteer)
│       ├── evaluate_agent.js          ← Automated 9-query ESG test suite
│       └── report_counts.js           ← Download/index progress report
│
└── data/
    ├── database.db                    ← SQLite index (built by preprocess)
    ├── xbrl/                          ← Raw BRSR XML by year/symbol
    │   ├── 2025/
    │   └── 2026/
    ├── nse_sustainability_metadata.json
    ├── chats.json                     ← Server-side chat log
    ├── evaluation_results.json
    └── evaluation_report.md
```

---

## Prerequisites

1. **Node.js** v18+ (v21+ recommended)
2. **Ollama** installed and running
3. **Model pulled** (default: `qwen2.5:7b-instruct`)

```bash
# Install Ollama: https://ollama.com
ollama serve
ollama pull qwen2.5:7b-instruct
```

---

## Quick start

```bash
cd ~/Documents/stage3

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env if needed (model name, port, etc.)

# 3. Ensure data is indexed (skip if database.db already exists)
npm run preprocess

# 4. Start Ollama (separate terminal)
ollama serve

# 5. Start the application
npm run ui
```

Open **http://localhost:3000**

---

## npm scripts

| Command | Description |
|---------|-------------|
| `npm run ui` / `npm start` | Start web server on port 3000 |
| `npm run preprocess` | Parse all BRSR XML in `data/xbrl/` → SQLite (**clears existing rows first**) |
| `npm run download-reports` | Download BRSR filings from NSE (Puppeteer) |
| `npm run report-counts` | Show download vs index progress |
| `npm run evaluate` | Run 9 automated ESG test queries against Ollama |

---

## Configuration (`.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Web server port |
| `DB_PATH` | `data/database.db` | SQLite database path |
| `XBRL_DIR` | `data/xbrl` | BRSR XML storage |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model name |
| `OLLAMA_KEEP_ALIVE` | `30m` | Keep model loaded in memory |
| `OLLAMA_NUM_CTX` | `4096` | Context window size |
| `OLLAMA_NUM_PREDICT` | `768` | Max tokens per response |
| `OLLAMA_TEMPERATURE` | `0.15` | LLM creativity (lower = more focused) |
| `AGENT_MAX_ITERATIONS` | `3` | Max tool-calling loops per question |
| `AGENT_MAX_HISTORY` | `4` | Chat turns sent to Ollama |
| `AGENT_SQL_ROW_LIMIT` | `15` | Max SQL rows returned to LLM |
| `NSE_DOWNLOAD_LIMIT` | `20` | Max reports per download run |

---

## Data pipeline

### 1. Download BRSR reports

```bash
npm run download-reports        # default limit from .env
npm run download-reports 50     # download up to 50
npm run download-reports all    # no limit
```

Files are saved to `data/xbrl/YYYY/SYMBOL/filename.xml`.

### 2. Index into SQLite

```bash
npm run preprocess
```

> **Warning:** `preprocess` runs `DELETE FROM reports` before re-indexing. Back up `data/database.db` first if you want to keep the current index.

### 3. Verify

```bash
npm run report-counts
```

---

## How the agent answers questions

1. User sends a question via the UI → `POST /api/chat`
2. Server streams SSE events: `thinking` → `tool_start` → `tool_end` → `token` → `done`
3. Ollama decides which **tools** to call:

| Tool | Use case |
|------|----------|
| `execute_sql_query` | Rankings, comparisons, averages, sector filters, trends |
| `get_company_report` | Full BRSR JSON for one company + year |
| `list_company_reports` | Available years for a company |
| `list_companies` | Small lists only (prefer SQL `LIKE` search) |

4. Tool results are fed back to Ollama for the final answer
5. Answer may include a **chart block**:

````markdown
```json-chart
{
  "type": "chart",
  "chartType": "bar",
  "title": "Scope 1 Emissions Comparison",
  "labels": ["Company A", "Company B"],
  "datasets": [{ "label": "Scope 1 (tCO2e)", "data": [1000, 2000] }]
}
```
````

6. UI renders markdown, KaTeX math, and Chart.js visualizations

### Speed optimizations

- Compact system prompt (fewer tokens)
- Streaming final answer tokens to UI
- Parallel tool execution
- SQL result truncation (15 rows max)
- Model warm-up on server start
- Limited iteration count (3 loops)

**Typical latency:** 10–25s for simple queries; 30–90s for complex multi-step questions.

---

## API reference

### `GET /api/status`

Returns indexed report count and list.

```json
{
  "success": true,
  "reportsCount": 1904,
  "reports": [{ "company": "...", "year": 2025, "filename": "...", "isCustom": 0 }]
}
```

### `GET /api/config`

Returns default Ollama model and host.

### `POST /api/chat` (SSE)

**Body:**
```json
{
  "message": "Top 5 Scope 1 emitters in 2025",
  "chatHistory": [],
  "modelName": null,
  "ollamaHost": null
}
```

**SSE events:**

| Event `status` | Payload | Meaning |
|----------------|---------|---------|
| `thinking` | `{ loop, message }` | Ollama reasoning step |
| `tool_start` | `{ tool, message }` | Tool execution started |
| `tool_end` | `{ tool, message }` | Tool finished |
| `answer_start` | — | Final answer streaming begins |
| `token` | `{ delta }` | Partial answer text |
| `done` | `{ text, chatHistory }` | Complete answer |
| `error` | `{ message }` | Failure |

### `POST /api/upload-custom`

Multipart form field `xbrl` — uploads and indexes a BRSR XML file.

### `POST /api/delete-report`

**Body:** `{ "company": "...", "year": 2025, "filename": "..." }`

---

## SQLite schema (`reports` table)

Key columns the agent can query:

| Column | Type | Description |
|--------|------|-------------|
| `company` | TEXT | Company legal name |
| `year` | INTEGER | 2025 = FY24-25, 2026 = FY25-26 |
| `sector` / `industry` | TEXT | Classification |
| `scope1_emissions` … `scope3_emissions` | REAL | GHG emissions |
| `energy_consumption` | REAL | Total energy |
| `renewable_energy_share` | REAL | % renewable |
| `water_consumption` | REAL | Water used |
| `waste_generated` | REAL | Waste produced |
| `emissions_intensity` | REAL | Emissions per rupee turnover |
| `energy_intensity` | REAL | Energy per rupee turnover |
| `water_intensity` | REAL | Water per rupee turnover |
| `female_employee_share` | REAL | % female workforce |
| `female_board_share` | REAL | % female directors |
| `safety_ltifr` | REAL | Lost time injury frequency rate |
| `total_revenue` | REAL | Company revenue (INR) |
| `data_json` | TEXT | Full parsed report JSON |
| `is_custom` | INTEGER | 1 if user-uploaded |

---

## Example questions

See `complex_queries_test_bank.md` for a full test bank. Examples:

- *"Compare the average carbon emissions intensity across all sectors in 2025. Show a bar chart."*
- *"Top 5 most water-intensive companies in Materials sector in 2025."*
- *"Find top 10 companies by female employee share in 2025."*
- *"Analyze energy intensity trend for Tata Power across all years."*
- *"Which Technology companies reduced Scope 1+2 emissions from 2024 to 2025?"*

---

## Evaluation

Run the automated test suite (requires Ollama running):

```bash
npm run evaluate
```

Runs 9 complex ESG queries and writes results to `data/evaluation_results.json` and `data/evaluation_report.md`.

---

## UI features

- **Gemini-inspired** light/dark theme
- Centered chat with suggestion chips on welcome screen
- Rounded pill input bar with attach (+) and send (↑)
- Streaming answers word-by-word
- Inline Chart.js charts from agent responses
- Sidebar with chat history and new-chat button
- Drag-and-drop BRSR XML upload
- Indexed reports modal (view/delete)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Failed to connect to Ollama" | Run `ollama serve` in a separate terminal |
| Slow first question | Wait for model warm-up on server start, or run `ollama run qwen2.5:7b-instruct hi` |
| Wrong model error | Set `OLLAMA_MODEL` in `.env` to a model you have (`ollama list`) |
| No data for a company | Run `npm run preprocess` or check name spelling; agent uses `LIKE '%keyword%'` |
| Empty database | Run `npm run preprocess` after ensuring XML files exist in `data/xbrl/` |
| preprocess wipes data | Back up `data/database.db` before re-running |
| Puppeteer "Could not find Chrome" | Script auto-uses Mac Google Chrome; or run `npm run install-browser` |

---

## What changed from the original stage3

The original stage3 project was a **financial XBRL extractor** (INDAS quarterly filings, revenue/profit Q&A). It was rebuilt as a **BRSR/ESG analyst** aligned with the reference agent:

| Before | Now |
|--------|-----|
| Financial INDAS XML (~1,110 files) | BRSR sustainability XML (~961 files) |
| JSON store (`xbrl-store.json`) | SQLite (`database.db`) |
| Rule-based agent (30 lines) | Ollama tool-calling agent (full LLM + SQL) |
| Financial questions only | ESG/sustainability questions |
| Custom dark UI (port 8787) | Gemini-style UI (port 3000) |

---

## License

Private / local use. BRSR data sourced from NSE corporate sustainability filings.
