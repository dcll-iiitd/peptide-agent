# PepForge 🧬

An agentic AI system for generating novel bioactive peptide sequences.

PepForge takes a biological specification (activity class, length, charge, hydrophobicity) and produces a novel peptide using a generate-then-edit loop powered by large language models.

---

## What it does

- Retrieves similar peptides from a 105K validated peptide database (RAG)
- Generates candidate sequences using LLMs via Bhaskera/vLLM
- Scores candidates using PeptideBLEU (7-component custom metric)
- Validates against physicochemical rulebook (6 constraints)
- Iteratively edits using structured edit operators (up to 6 rounds)
- Assesses structural confidence (ESMFold pLDDT) and novelty (BLAST)
- Persists all results as candidate artifacts

**Best result:** DeepSeek-R1-8B agent path — PeptideBLEU 0.7131, 89.5% novel peptides, avg pLDDT 73.4

---

## Project Structure

```
peptide-agent/
├── backend/          ← core agent, scoring, validation
│   ├── agent.py      ← generate-then-edit loop
│   ├── peptide_bleu.py
│   ├── rulebook.py
│   ├── models.py     ← LLM connection (Bhaskera/vLLM)
│   └── server.py     ← FastAPI server
├── harness/          ← LangGraph agentic infrastructure
│   ├── graph.py      ← 9-node StateGraph
│   ├── tools.py      ← all tools as @tool functions
│   ├── commands.py   ← slash commands
│   └── sse_bridge.py ← SSE streaming bridge
├── frontend/         ← research workspace UI
├── eval/             ← three-arm evaluation scripts
└── configs/          ← Bhaskera model configs
```

---

## Setup Instructions

### Prerequisites

- Python 3.11+
- Node.js (for frontend, optional)
- GPU server running Bhaskera/vLLM (for model inference)
- Git

---

### Step 1 - Clone the repository

```bash
git clone https://github.com/23f2004400/peptide-agent
cd peptide-agent
```

---

### Step 2 - Create a virtual environment

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# Linux/Mac
source venv/bin/activate
```

---

### Step 3 - Install dependencies

```bash
pip install -r requirements.txt
```

If you are on Windows and encounter DLL errors with faiss or pandas:

```bash
pip install faiss-cpu==1.7.4
pip install pandas==1.5.3
```

---

### Step 3b - Install BLAST+ (for novelty checking)

Download and install BLAST+ from NCBI:
https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/

Verify installation:
```bash
blastp -version
```

If BLAST+ is not installed, novelty checking will fall back to
FAISS property-space search automatically — generation still works.

---

### Step 3c - Build the peptide database index

```bash
python eval/build_faiss_index.py
```

This builds the FAISS index from the peptide dataset for RAG retrieval.
The index file is saved to `data/peptide_index.faiss`.

> If the index file already exists in the repo, skip this step.

---

### Step 4 - Set up environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and set:

```dotenv
# Required — your Bhaskera/vLLM gateway URL
GATEWAY_URL=https://your-cloudflare-tunnel.trycloudflare.com

# Model name served by Bhaskera
MODEL_NAME=deepseek-ai/DeepSeek-R1-Distill-Llama-8B

# Set to true for reasoning models (DeepSeek-R1, QwQ)
IS_REASONING_MODEL=true

# API key for Bhaskera (default works for local)
API_KEY=sk-bhaskera-alice

# Harness SQLite memory path
HARNESS_DB_PATH=data/harness_memory.db

# Optional — LangSmith tracing
LANGCHAIN_TRACING_V2=false
LANGCHAIN_API_KEY=
LANGCHAIN_PROJECT=pepforge
```

> **Note:** If you do not have access to a Bhaskera GPU server, you can point GATEWAY_URL at any OpenAI-compatible vLLM endpoint.

---

### Step 5 - Set up temp directories (important on shared servers)

If the root partition on your server is full, redirect all cache to a larger disk:

```bash
export TMPDIR=/path/to/large/disk/tmp
export VLLM_CACHE_ROOT=/path/to/large/disk/.vllm_cache
export TORCH_HOME=/path/to/large/disk/.torch_cache
mkdir -p $TMPDIR $VLLM_CACHE_ROOT $TORCH_HOME
```

---

### Step 6 - Start the backend server

```bash
python -m backend.server
```

You should see:

```
INFO: Uvicorn running on http://0.0.0.0:8000
```

Health check:

```bash
curl http://localhost:8000/health
```

---

### Step 7 - Open the frontend

In a separate terminal:

```bash
python -m http.server 8080 --directory frontend
```

Open your browser at `http://localhost:8080`

---

### Step 8 - Generate your first peptide

In the frontend:

1. Type your objective in the input box:
   ```
   Generate an antimicrobial peptide with 15-25 residues,
   charge +2 to +5, hydrophobicity 30-50%
   ```
2. Click **Generate**
3. Watch the agent progress timeline update in real time
4. View results across the Overview, Properties, PeptideBLEU, Structure, Novelty, and Trace tabs

Or use slash commands directly:

```
/generate anti-bacterial --length 15-25 --charge +2+5
/score KLLKFLHSAKKFG
/explain GSIKSRWGAFVGEIMNSKLLKAFVG
```

---

## Running Evaluation

```bash
# Three-arm evaluation (zero-shot, best-of-4, agent)
python eval/run_three_arm_eval.py \
    --model deepseek-r1-8b \
    --test-cases eval/test_cases_pool_b.jsonl \
    --output eval/results/

# Compare results across models
python eval/compare_three_arms.py
```

---

## Common Issues

| Problem | Fix |
|---|---|
| `GATEWAY_URL not set` | Check your `.env` file is in the project root |
| `No space left on device` | Set TMPDIR to a larger partition (Step 5) |
| `GIGK` fragment generated | Check IS_REASONING_MODEL=true and MODEL_NAME is correct |
| Pandas DLL error on Windows | `pip install pandas==1.5.3` |
| FAISS import error | `pip install faiss-cpu==1.7.4` |
| LangSmith 429 rate limit | Set `LANGCHAIN_TRACING_V2=false` in `.env` |

---

## Key Files Not to Modify

These are research ground truth — modifying them invalidates experiments:

- `backend/peptide_bleu.py`
- `backend/rulebook.py`
- `backend/models.py`
- `peptides_with_length.jsonl`

---

## Tech Stack

Python · FastAPI · LangGraph 2.0 · LangSmith · FAISS · vLLM (Bhaskera) · ESMFold · DSSP · BLAST+ · SQLite · FastMCP · Vanilla JS

---

## Research

IIIT-Delhi · Supervisor: Dr. Bapi Chatterjee · 2026