## Strategy: Zero-Miss UK Job Filter

### The Core Problem

Your current `isLikelyUKJob` is a single function doing too much — it's both the **detector** and the **decision maker**. This causes hallucination at the edges (ambiguous locations, remote jobs, multi-location strings).

---

### The Mental Model: 3-Layer Pipeline per ATS

For every ATS provider, the filter should work in this exact order:

**Layer 1 → Trust the Source**
**Layer 2 → Trust the Data**
**Layer 3 → Trust the Signal**

Never skip a layer. Never merge them.

---

### Layer 1: Source-Level Trust (Before fetching)

Some sources are inherently UK. Tag them at the company/ATS registration level, not at job-fetch time.

- NHS, GOV.UK jobs → **auto-pass**, skip all filtering
- Companies registered with a UK ATS endpoint (e.g., Workday UK facet ID) → **auto-pass**
- Everything else → goes to Layer 2

This is your **0% false negative** zone. Never filter here, only guarantee.

---

### Layer 2: Structured Field Extraction (ATS-Specific)

This is where provider-specific logic lives. The goal is: **extract every location signal the ATS gives you**, before any filtering happens.

Each ATS has its own fields — don't normalize prematurely:

| ATS | Fields to Extract |
|---|---|
| **Ashby** | `isRemote`, `primaryLocation`, `secondaryLocations[]` |
| **Greenhouse** | `offices[]`, `location.name` |
| **Lever** | `location`, `tags[]`, `department` |
| **Workday** | Facet ID filter + `jobPostingLocations[]` |
| **Teamtailor** | `locations[]`, `remote` |
| **SmartRecruiters** | `location.country`, `location.city` |

Output of Layer 2: **a flat array of all location strings + booleans** (isRemote, isHybrid) for that job. Never a single concatenated string — keep them separate.

---

### Layer 3: The Decision Filter (Shared, Deterministic)

Now you run your master filter — but on **structured input**, not a blob of text.

The filter runs in this exact priority order and stops at first match:

**Step 1 — Hard Include**
- `isRemote = true` → **INCLUDE** (remote = accessible to UK)
- Any location string matches known UK geography → **INCLUDE**
- URL contains `/uk/`, `country=gb`, `.co.uk` → **INCLUDE**

**Step 2 — Hard Exclude**
- Any location string matches a known non-UK geography (US states, EU cities, India, etc.) AND no UK signal exists anywhere → **EXCLUDE**

**Step 3 — Ambiguous / Multi-location**
- Job has both UK and non-UK locations → **INCLUDE** (it's a multi-location role, UK is valid)
- Location is "Global", "Worldwide", "International" + no hard exclude → **INCLUDE**
- Location is empty/null → go to Step 4

**Step 4 — Context Fallback (last resort)**
- Scan job title + department for UK signals ("EMEA", "UK", "British", "London")
- Company's ATS registration country is UK → **INCLUDE**
- Still ambiguous → **EXCLUDE with a flag** (log it, don't silently drop)

---

### The Critical Rule: Never Silently Drop

Every excluded job should be logged with **why** it was excluded. This is how you catch false negatives. Build a rejection log with:
- Job ID + company
- Which layer rejected it
- What the location strings were

---

### Per-ATS Difference Summary

| ATS | Layer 1 | Layer 2 Unique Handling | Layer 3 |
|---|---|---|---|
| NHS | Auto-pass | Skip | Skip |
| Ashby | Standard | Combine primary + secondary as array, check `isRemote` bool | Shared |
| Workday | Use facet ID to pre-filter | Extract `jobPostingLocations[]` | Shared |
| Greenhouse | Standard | Flatten all `offices[]` | Shared |
| Lever | Standard | tags + location as separate array items | Shared |
| Custom scrapers | Source-level URL filter | N/A | Shared |

---

### What Makes This 10/10

1. **No concatenation** — locations stay as arrays until Layer 3, so "London / New York" doesn't confuse the matcher
2. **Remote is always included** — never filtered out at Layer 2
3. **Multi-location is always included** — UK presence anywhere = UK job
4. **Ambiguous goes in, not out** — bias toward inclusion, rejection log catches over-fetching
5. **Layer 1 short-circuits guaranteed sources** — no wasted compute, no risk of false negatives on known-UK sources

---

Tell me what you want next — I can go deep on any specific ATS, the UK geography matching list, or the rejection logging schema.