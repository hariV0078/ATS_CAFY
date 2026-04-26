I already have a working UK job scraper with the following filtering system 
already implemented:

WHAT IS ALREADY BUILT:
- Phase 1: Normalization — lowercasing, removing special characters
- Phase 2: Hard block — blocks USA, India, Germany, US state codes (CA, NY, TX etc), 
  non-UK URL paths, and ROI cities (Dublin, Cork etc)
- Phase 3: Positive UK signal match — UK nations, country keywords, 100+ UK cities, 
  postcodes, flexible work keywords (Remote UK, UK-wide etc)
- Phase 4: Title + URL backup — if location is vague (just "Remote" or 
  "Multi-location"), checks job title and URL for UK signals

DO NOT rebuild or rewrite what is already built. I only want you to identify 
the GAPS in my current system and write ONLY the additional code needed to 
plug those gaps.

Here are the specific gaps I need you to fix, one by one:

---

GAP 1: BLANK / NULL LOCATION JOBS

My current system crashes or silently drops jobs where the location field 
is null, empty, or whitespace only. I am losing legitimate UK jobs this way.

Write a fallback function that triggers ONLY when location is null/empty:

def handle_blank_location(job, company_meta):
    # Step 1: If company's registered country in DB is UK/GB and they have 
    #         no international offices → return SAVE
    # Step 2: If job URL contains .co.uk / /uk/ / /gb/ / /united-kingdom/ → return SAVE
    # Step 3: If job title contains any UK signal → return SAVE
    # Step 4: If department/team field contains UK signal → return SAVE
    # Step 5: If still unclear → return NEEDS_REVIEW (never drop it)

---

GAP 2: GREENHOUSE OFFICES ARRAY

My Greenhouse extractor currently reads only the first office location. 
A single Greenhouse job can have multiple offices (e.g. London + New York). 
If London is the second office I am missing it.

Write a fix for my Greenhouse extractor that:
- Reads the full `offices` array (not just index 0)
- Runs my existing filter logic against EACH office location
- If ANY office passes as UK → saves the job
- Only rejects if ALL offices fail the UK filter

---

GAP 3: LEVER TEAM FIELD IGNORED

My Lever extractor only checks `categories.location`. But Lever also exposes 
`categories.team` which often contains region info like "UK Sales" or 
"EMEA - UK" when the location field is blank or generic.

Write a fix that:
- Checks BOTH `categories.location` AND `categories.team`
- Combines them as: f"{location} {team}" before running through my filter
- Also checks the `tags` array for UK signals as a third fallback

---

GAP 4: ASHBY REMOTE BOOLEAN IGNORED

My Ashby extractor ignores the `isRemote` boolean and `secondaryLocations` 
array. I am missing remote UK jobs from Ashby companies.

Write a fix that:
- If `isRemote: true` AND company's registered country is UK → SAVE
- Also iterates `secondaryLocations` array and runs filter on each entry
- Takes the most permissive result (if any location passes → save)

---

GAP 5: IRELAND HYBRID ROLES BEING WRONGLY REJECTED

My Phase 2 hard blocks Dublin and Cork entirely. But roles like 
"Dublin or London" and "Dublin / Manchester" are valid UK hybrid roles 
and I am losing them.

Rewrite ONLY my Ireland block logic as follows:
- If location contains a ROI keyword (dublin, cork, galway, limerick, 
  waterford) AND ALSO contains a UK signal → SAVE
- If location contains a ROI keyword with NO UK signal → REJECT (same as now)
- Do not change any other part of Phase 2

---

GAP 6: EMEA / GLOBAL ROLES BEING DROPPED

My Phase 3 has no match for EMEA, Europe, Global, Worldwide, British Isles, 
Western Europe, Northern Europe. These roles often include UK but I reject 
them completely right now.

Write an additional check that triggers AFTER Phase 3 fails:
- If location contains: emea, europe, global, worldwide, international, 
  western europe, northern europe, british isles
- AND company HQ country in my DB is UK → SAVE with tag `location_type: emea_likely_uk`
- AND company has a UK office in my DB → SAVE with tag `location_type: emea_likely_uk`
- If neither condition met → flag as NEEDS_REVIEW, do not drop

---

GAP 7: US STATE CODE REGEX IS TOO BROAD

My Phase 2 blocks isolated 2-letter state codes but the regex is likely 
matching inside longer words. For example:
- CA inside CAMBRIDGE → wrongly rejected
- IN inside LONDON → wrongly rejected  
- OR inside WORCESTER → wrongly rejected

Fix my US state code regex to use strict word boundaries so it only 
matches truly isolated codes:

Current (wrong): if "CA" in location
Fixed (correct): re.search(r'\bCA\b', location, re.IGNORECASE)

Write the corrected regex block for ALL US state codes with proper 
word boundary matching. Make sure to test against these false positive 
cases: CAMBRIDGE, LONDON, WORCESTER, INDIANA (city not state), READING.

---

GAP 8: DEDUPLICATION MISSING

I have no deduplication. If a company is synced twice, or uses two ATS 
systems during a migration, the same job gets saved multiple times.

Write a dedup check function that:
- Generates a key: hash(company_id + normalized_title + normalized_location + posted_date)
- Checks this key against existing records before inserting
- If duplicate found → skips insert silently
- Logs how many dupes were skipped per sync run

---

GAP 9: NO REJECTION AUDIT LOG

When a job is rejected I have no visibility into WHY. I cannot tune my 
filter without knowing what is being dropped and for what reason.

Write a rejection logger that:
- Captures: job_title, location_raw, company, ats_provider, rejected_at_phase, 
  rejection_reason (e.g. "phase2_us_state: TX" or "phase2_country: germany")
- Saves this to a separate rejection_log table or JSON file
- At end of each sync, prints a summary:
  "Company X | Fetched: 42 | Saved: 31 | Rejected: 8 | Needs Review: 3"
  "Top rejection reasons: phase2_country:usa (4), phase2_us_state:TX (2)"

---

IMPORTANT INSTRUCTIONS FOR YOUR RESPONSE:

1. Do not rewrite my existing Phase 1, 2, 3, or 4 logic
2. Write each gap as a self-contained function or small code block I can 
   drop into my existing codebase
3. Write in Python unless I tell you otherwise
4. After each gap fix, add a one-line comment explaining where in my 
   existing pipeline to call it
5. Start with Gap 1 only. Show me the code, then wait for my go-ahead 
   before writing Gap 2.