/**
 * syncAll.ts — Master Daily Sync Script
 *
 * Dynamically reads ALL companies from Supabase, routes each to the correct
 * ATS fetcher based on ats_provider, filters for UK-only jobs, and upserts
 * to the jobs table.
 *
 * Adding a new company to the DB is all that's needed — this script picks it up
 * automatically on the next run. No code changes required.
 *
 * Supported ATS providers:
 *   greenhouse, ashby, lever, workable, teamtailor, bamboohr,
 *   smartrecruiters, pinpoint, breezy, recruitee, workday,
 *   personio, hibob, custom_scraper
 *
 * Special scrapers (run separately after ATS sync):
 *   Amazon, Goldman Sachs, Google, JPMC (handled via their scripts)
 *
 * Run: npx tsx src/scripts/syncAll.ts
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { inferJobLevel } from '../lib/inferJobLevel';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import { isUKJob } from '../lib/ukFilter';
import * as Adapters from '../lib/ukFilterAdapters';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'mock-key';

const supabase = createClient(supabaseUrl, supabaseKey);

const SERPER_API_KEY = process.env.SERPER_API_KEY?.trim() || '';
let serperCallCount = 0;
let serperHitCount = 0;
let serperDisabled = false;
const SERPER_DISCOVERY_SITE_HINTS = [
    'site:boards.greenhouse.io',
    'site:job-boards.eu.greenhouse.io',
    'site:jobs.lever.co',
    'site:jobs.ashbyhq.com',
    'site:apply.workable.com',
    'site:jobs.smartrecruiters.com',
    'site:jobs.personio.de',
    'site:jobs.personio.com',
    'site:pinpointhq.com',
    'site:breezy.hr',
    'site:recruitee.com',
    'site:myworkdayjobs.com',
    'site:jobs.jobvite.com',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Job {
    title: string;
    location: string;
    url: string;
    department?: string;
    salary?: string;
    verified?: boolean;
    needs_review?: boolean;
    rejection_reason?: string;
    atsProvider?: string;
    source?: string;
}

interface SyncResult {
    company: string;
    provider: string;
    fetched: number;
    ukJobs: number;
    saved: number;
    rejected: number;
    needsReview: number;
    error?: string;
}

// Rejection log array to track dropped jobs
interface RejectionLogEntry {
    company: string;
    provider: string;
    title: string;
    location: string;
    url: string;
    reason: string;
}
const globalRejectionLog: RejectionLogEntry[] = [];

interface CompanyRow {
    id: number;
    trading_name: string;
    ats_provider: string;
    ats_board_token: string;
    careers_url?: string | null;
    url?: string | null;
}

interface AtsOverrideRow {
    company_id: number;
    sync_provider?: string | null;
    provider_raw?: string | null;
    board_token_raw?: string | null;
    careers_url_raw?: string | null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url: string, options: any = {}, timeout = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

const UK_COUNTRIES = ["UK", "United Kingdom", "GB", "GBR", "GBI", "GBRE", "Great Britain", "Rest of UK", "Remote", "Multi-location", "Multilocation", "UK-wide"];
const UK_NATIONS = ["scotland", "wales", "northern ireland", "england"];
const UK_CITIES = [
    // Major cities
    "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh",
    "bristol", "liverpool", "nottingham", "sheffield", "cardiff", "belfast",
    "newcastle", "cambridge", "oxford", "reading", "brighton", "southampton",
    "coventry", "leicester", "york", "bath", "milton keynes", "derby",
    "portsmouth", "exeter", "plymouth", "aberdeen", "dundee", "stoke",
    "luton", "swindon", "warrington", "bolton", "rochdale", "sunderland",
    // Additional UK cities / towns
    "guildford", "woking", "slough", "watford", "harlow", "basildon",
    "chelmsford", "ipswich", "peterborough", "northampton", "worcester",
    "gloucester", "hereford", "shrewsbury", "telford", "chester", "carlisle",
    "durham", "middlesbrough", "hull", "lincoln", "swansea", "newport",
    "inverness", "stirling", "perth", "derry", "lisburn", "truro",
    "salisbury", "winchester", "chichester", "crawley", "horsham",
    "guildford", "richmond", "twickenham", "wimbledon", "croydon",
    "canary wharf", "city of london", "knutsford", "radbroke",
    "wokingham", "bracknell", "basingstoke", "aldershot", "farnborough",
    "bournemouth", "poole", "dorchester", "weymouth", "yeovil",
    "taunton", "barnstaple", "torquay", "paignton", "newquay",
    // Regions
    "midlands", "yorkshire", "lancashire", "cornwall", "devon", "east anglia",
    "home counties", "south east", "south west", "north east", "north west",
    "cotswolds", "chilterns", "pennines", "highlands", "lowlands",
    // Channel Islands / Crown dependencies (genuinely UK-adjacent for jobs purposes)
    "jersey", "guernsey", "isle of man",
    // Finance hubs
    "london ec", "london wc", "london e1", "london e14", "london se1",
    "st. albans", "st albans", "stratford-upon-avon", "stratford upon avon"
];

// Workday-specific UK country facet IDs (they vary by tenant)
const WORKDAY_UK_FACETS: Record<string, string> = {
    'default': '29247e57dbaf46fb855b224e03170bc7'
};

// Irish cities/towns that must be blocked (not UK)
const IRELAND_LOCATIONS = [
    "cork", "galway", "limerick", "waterford", "wexford", "kilkenny",
    "drogheda", "swords", "bray", "ennis", "tralee", "carlow", "clonmel",
    "mullingar", "sligo", "athlone", "republic of ireland", "eire"
];

const NON_UK_LOCATION_PHRASES = [
    // Country names
    "united states", "usa", "u.s.a", "canada", "india", "australia", "new zealand",
    "germany", "france", "netherlands", "spain", "portugal", "italy", "sweden",
    "norway", "denmark", "finland", "switzerland", "austria", "belgium",
    "poland", "ukraine", "russia", "china", "japan", "south korea",
    "singapore", "hong kong", "united arab emirates", "dubai", "israel", "ireland", "eire",
    // US cities
    "new york", "new jersey", "san francisco", "los angeles", "seattle", "chicago", "boston", "austin", "dallas", "houston", "denver", "atlanta",
    "miami", "phoenix", "las vegas", "san jose", "san diego", "whippany", "wilmington", "st louis", "new hampshire", "california", "texas", "virginia", "mclean", "richmond", "plano", "georgia", "illinois", "maryland", "pennsylvania", "north carolina",
    // Other non-UK cities
    "auckland", "tokyo", "berlin", "munich", "hamburg", "paris", "amsterdam", "madrid", "barcelona", "stockholm", "oslo", "copenhagen",
    "zurich", "geneva", "vienna", "warsaw", "prague", "bucharest", "budapest", "milan", "rome", "lisbon", "brussels", "luxembourg", "mexico city",
    // India cities
    "pune", "mumbai", "bengaluru", "bangalore", "chennai", "hyderabad", "noida", "gurgaon", "gurugram", "delhi", "kolkata", "ahmedabad", "jaipur"
];

const UK_URL_HINTS = [
    "/uk/", "united-kingdom", "country=gb", "country=uk", "location=uk", "locale=en-gb",
    "countryid=gbr", "country%5B%5D=gbr", "country=gbr",
    "city=london", "city=manchester", "city=birmingham", "city=leeds", "city=bristol", "city=liverpool",
    "city=edinburgh", "city=glasgow", "city=cardiff", "city=belfast",
    "/en-gb/", "-gb-", "region=uk", "region=gb"
];

const NON_UK_URL_HINTS = [
    "country=us", "country=usa", "country=ca", "country=au", "country=sg", "country=in",
    "location=united-states", "location=usa", "location=us",
    "city=new-york", "city=san-francisco", "city=seattle", "city=toronto", "city=singapore",
    "country=ie", "country=de", "country=fr"
];

function normalizeLocation(str: string): string {
    return String(str || '')
        .toLowerCase()
        .replace(/[()\[\]]/g, '')
        .replace(/[\/\-_|,;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function isUKLocation(loc: any): boolean {
    if (!loc) return false;
    const normalized = normalizeLocation(loc);
    if (!normalized) return false;

    // console.log(`      [isUKLocation] Normalized: "${normalized}"`);

    // Hard block: bare "remote" with no explicit UK signal → not UK
    // e.g. "Remote", "Anywhere", "Remote - Worldwide" all fail
    if (/^remote$/.test(normalized) || normalized === 'anywhere' || normalized === 'worldwide') {
        return false;
    }

    // Gap 5: Ireland Hybrid Roles
    // Hard block: Irish locations (Republic of Ireland, NOT Northern Ireland)
    // Only block if there is NO UK signal
    for (const irish of IRELAND_LOCATIONS) {
        if (normalized.includes(irish) && !normalized.includes('northern ireland')) {
            const hasUkSignal = UK_COUNTRIES.some(uk => normalized.includes(uk.toLowerCase())) ||
                UK_NATIONS.some(n => normalized.includes(n.toLowerCase())) ||
                UK_CITIES.some(c => normalized.includes(c.toLowerCase()));
            if (!hasUkSignal) {
                return false;
            }
        }
    }

    // Hard block: well-known non-UK phrases
    const blockList = [
        "ukraine", "new york", "new jersey", "new south wales", "new england",
        "united states", "usa", "india", "canada", "australia", "germany",
        "france", "netherlands", "singapore", "hong kong", "dubai",
        "massachusetts", "california", "texas", "florida", "washington state"
    ];
    for (const blocked of blockList) {
        // Special carve-out: "northern ireland" must not be blocked by "ireland"
        if (blocked === 'ireland' && normalized.includes('northern ireland')) continue;
        if (normalized.includes(blocked)) return false;
    }

    // Hard block: US state/country 2-letter codes as isolated tokens
    if (/\b(usa?|ny|nj|ca|tx|ma|il|wa|fl|ga|nc|va|pa|oh|mi|mn|co|az|or|nv|md|va|pa|oh|mi|mn|co|az|or|nv|vt|nh|me|ct|ri|ky|tn|nc|sc|ga|fl|al|ms|la|ar|ok|ks|ne|sd|nd|mt|wy|id|ut|nm)\b/.test(normalized)) {
        // But allow "wa" only if surrounded by full UK context (e.g., "wa1" postcodes)
        // Postcode pattern: letters+digits — if it looks like a UK postcode don't block
        if (!/\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/.test(normalized)) {
            return false;
        }
    }

    // ✅ UK Remote — explicit UK remote signal
    if (normalized.includes('remote') && (
        normalized.includes('uk') || normalized.includes('united kingdom') ||
        normalized.includes('england') || normalized.includes('britain')
    )) {
        return true;
    }

    // ✅ Token-level match against known UK countries/nations/cities
    const tokens = normalized.split(/\s+/);
    for (const token of tokens) {
        if (UK_COUNTRIES.includes(token)) return true;
        if (UK_NATIONS.includes(token)) return true;
        if (UK_CITIES.includes(token)) return true;
    }

    // ✅ Word-boundary match for England specifically
    if (/\bengland\b/.test(normalized)) return true;

    // ✅ UK postcode pattern (e.g., "EC2V 8RF", "W1A 1AA", "SW1A 2AA")
    if (/\b[a-z]{1,2}\d[a-z\d]?\s?\d[a-z]{2}\b/.test(normalized)) return true;

    // ✅ Multi-word phrase match for city names with spaces
    const multiWordUK = [
        ...UK_COUNTRIES, ...UK_NATIONS, ...UK_CITIES
    ].filter(w => w.includes(' '));
    for (const phrase of multiWordUK) {
        if (normalized.includes(phrase)) return true;
    }

    return false;
}

function hasAnyHint(text: string, hints: string[]): boolean {
    return hints.some((hint) => text.includes(hint));
}

function isLikelyUKJob(job: Job): boolean {
    const locationNorm = normalizeLocation(job.location || '');
    const urlNorm = String(job.url || '').toLowerCase();
    const titleNorm = String(job.title || '').toLowerCase();

    // If ATS says it's UK, but location explicitly says it's not, ATS is wrong.
    // So we run the location check FIRST.

    // console.log(`[DEBUG] Checking: ${job.title} | Loc: ${job.location}`);

    // Hard block: URL signals non-UK
    const badUrlHint = NON_UK_URL_HINTS.find((hint) => urlNorm.includes(hint));
    if (badUrlHint) {
        job.rejection_reason = `non_uk_url: ${badUrlHint}`;
        return false;
    }

    // Hard block: location signals non-UK phrase
    const badLocPhrase = NON_UK_LOCATION_PHRASES.find((p) => locationNorm.includes(p));
    if (badLocPhrase && !locationNorm.includes('northern ireland')) {
        job.rejection_reason = `non_uk_location: ${badLocPhrase}`;
        return false;
    }

    if (job.verified) return true;

    // PRIMARY: location field is the strongest signal
    if (locationNorm) {
        const ukFromLoc = isUKLocation(locationNorm);
        if (ukFromLoc) return true;

        // EXCEPTION: if location is just 'remote' but the URL is explicitly UK
        // e.g. jobs.company.co.uk/remote-role
        if (/^remote$/.test(locationNorm) && (
            urlNorm.includes('.uk') ||
            urlNorm.includes('.co.uk') ||
            urlNorm.includes('country=gb') ||
            urlNorm.includes('country=uk')
        )) {
            return true;
        }

        // Location is present but NOT UK — don't fall through to URL/title signals
        // (avoids "Senior Engineer - New York" matching title-based UK city checks)
        // EXCEPTION: if location is truly ambiguous (e.g. 'remote', 'flexible')
        const isAmbiguous = /^(remote|flexible|hybrid|anywhere|worldwide|global|distributed|not specified|remote other|remot other|multiple locations)$/.test(locationNorm) ||
            /\d+\s+locations?/.test(locationNorm);

        if (!isAmbiguous) {
            // Gap 6: EMEA / Global Roles Being Dropped
            const EMEA_GLOBAL = ['emea', 'europe', 'global', 'worldwide', 'international', 'western europe', 'northern europe', 'british isles'];
            if (EMEA_GLOBAL.some(w => locationNorm.includes(w))) {
                job.needs_review = true;
                return true; // Save it but flagged for review
            }
            job.rejection_reason = `failed_uk_location_check`;
            return false;
        }
    }

    // SECONDARY: URL contains explicit UK hint (e.g. country=gb, /uk/)
    if (hasAnyHint(urlNorm, UK_URL_HINTS)) return true;

    // TERTIARY: URL contains UK word boundary (only when location is empty/ambiguous)
    if (/\b(uk|united.kingdom|england|scotland|wales|northern.ireland)\b/i.test(urlNorm)) return true;

    // FOURTH: Job title contains explicit UK city/nation
    // FOURTH: Job title contains explicit UK city/nation/region
    const ukTerms = [
        ...UK_COUNTRIES, ...UK_NATIONS, ...UK_CITIES
    ].map(s => s.replace(/\s+/g, '[\\s\\.\\-]+'));
    const titleRegex = new RegExp(`\\b(${ukTerms.join('|')})\\b`, 'i');
    if (titleRegex.test(titleNorm)) return true;

    // FIFTH: Department/team field contains UK signal (Gap 1)
    const deptNorm = String(job.department || '').toLowerCase();
    if (titleRegex.test(deptNorm)) return true;

    // Gap 1 fallback: If location is genuinely blank/ambiguous and nothing matched, mark for review
    if (!locationNorm) {
        job.needs_review = true;
        return true;
    }

    job.rejection_reason = `no_uk_signals`;
    return false;
}

function safeStr(s: any, maxLen = 500): string {
    return String(s || '').slice(0, maxLen);
}

function isValidJobTitle(title: string): boolean {
    if (!title || title.length < 3) return false;
    const lower = title.toLowerCase().trim();
    const junk = [
        'see all jobs', 'view all jobs', 'all jobs', 'all openings', 'join our team',
        'back to search', 'back to job list', 'search for jobs', 'explore opportunities',
        'show more', 'filter by', 'sort by', 'cookie policy', 'privacy policy',
        'terms of use', 'contact us', 'about us', 'careers home', 'learn more',
        'get started', 'apply now', 'view details', 'view job', 'read more',
        'open positions', 'current openings', 'our roles', 'work with us',
        'explore careers', 'early careers', 'experienced hires', 'alumni',
        'jobs and careers', 'careers', 'our vacancies', 'view vacancies'
    ];
    // Check if it's an exact match or if it's one of the junk phrases
    if (junk.includes(lower)) return false;
    // Check if it starts with a junk phrase followed by a space (e.g., "See all jobs in...")
    // but only if the title is relatively short (less than 40 chars) to avoid false positives
    if (lower.length < 40 && junk.some(j => lower.startsWith(j))) return false;
    
    return true;
}

// ─── Provider Alias Map ──────────────────────────────────────────────────────
// Maps raw provider names (from DB/Excel) to canonical FETCHERS keys
const PROVIDER_ALIAS: Record<string, string> = {
    'ashbyhq': 'ashby',
    'pinpointhq': 'pinpoint',
    'breezyhr': 'breezy',
    'smart_recruiters': 'smartrecruiters',
    'smart recruiters': 'smartrecruiters',
    'team_tailor': 'teamtailor',
    'workday_enterprise': 'workday',
    'oracle_cloud': 'oracle_cloud',
    'ultipro': 'ultipro_html',
    'successfactors': 'successfactors',
};

// Custom company token → fetcher routing
const CUSTOM_TOKEN_ROUTES: Array<{ pattern: RegExp; fetcher: string }> = [
    { pattern: /jpmc\.fa\.oraclecloud|jpmorgan|jpmorganchase/i, fetcher: 'jpmc' },
    { pattern: /higher\.gs\.com|goldman.?sachs/i, fetcher: 'goldmansachs' },
    { pattern: /amazon\.jobs/i, fetcher: 'amazon' },
    { pattern: /google\.com\/about\/careers/i, fetcher: 'google' },
    { pattern: /jobs\.apple\.com/i, fetcher: 'apple' },
    { pattern: /metacareers\.com/i, fetcher: 'meta' },
    { pattern: /jobs\.nhs\.uk|nhs/i, fetcher: 'nhs' },
    { pattern: /publicisgroupe\.com/i, fetcher: 'publicis' },
    { pattern: /linkedin\.com/i, fetcher: 'linkedin' },
];

function normalizeProviderName(value: string | null | undefined): string | null {
    if (!value) return null;
    const raw = String(value).trim().toLowerCase().replace(/\s+/g, '_');
    return PROVIDER_ALIAS[raw] ?? raw;
}

// Resolve which fetcher key + token to use, accounting for aliases and custom routing
function resolveProviderAndToken(
    ats_provider: string | null,
    ats_board_token: string | null,
    careers_url: string | null
): { provider: string; token: string } | null {
    const rawProvider = String(ats_provider || '').trim();
    const rawToken = String(ats_board_token || '').trim();
    const rawUrl = String(careers_url || '').trim();

    // Handle 'custom' provider — route by token / URL content
    if (rawProvider.toLowerCase() === 'custom' || rawProvider.toLowerCase() === 'custom_site') {
        const lookupStr = rawToken || rawUrl;
        for (const route of CUSTOM_TOKEN_ROUTES) {
            if (route.pattern.test(lookupStr)) {
                return { provider: route.fetcher, token: lookupStr };
            }
        }
        // No matching custom route — fall through to URL inference below
    }

    // Normalize provider and apply alias
    const provider = normalizeProviderName(rawProvider) || '';

    // Workday: if token is just a subdomain (no '/'), build token from URL
    if (provider === 'workday' && rawToken && !rawToken.includes('/')) {
        const urlForParsing = normalizeCareersUrl(rawUrl || rawToken);
        if (urlForParsing) {
            try {
                const parsed = new URL(urlForParsing);
                const pathParts = parsed.pathname.split('/').filter(Boolean);
                // URL format: subdomain.wdN.myworkdayjobs.com/BoardName/en-US/...
                // or wdN.myworkdayjobs.com/subdomain/BoardName/en-US/...
                let boardName = '';
                let subdomain = '';

                const hostParts = parsed.hostname.split('.');
                if (hostParts[0] && !hostParts[0].startsWith('wd')) {
                    subdomain = hostParts[0];
                    boardName = pathParts[0] || '';
                } else if (pathParts.length >= 2) {
                    subdomain = pathParts[0];
                    boardName = pathParts[1];
                }

                if (subdomain && boardName && boardName !== 'en-US' && boardName !== 'en-GB') {
                    return { provider: 'workday', token: `${subdomain}/${boardName}` };
                }
            } catch { /* ignore parse errors */ }
        }
        return { provider: 'workday', token: rawToken };
    }

    const result = (provider && rawToken) ? { provider, token: rawToken } : null;
    // console.log(`[RESOLVE] ${ats_provider} -> ${result?.provider || 'none'}`);
    return result;
}

function normalizeCareersUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
}

type FetchAttempt = {
    provider: string;
    token: string;
    source: 'primary' | 'fallback' | 'serper';
};

function inferAtsFromCareersUrl(url: string | null | undefined): { provider: string; token: string } | null {
    const normalizedUrl = normalizeCareersUrl(url);
    if (!normalizedUrl) return null;

    try {
        const parsed = new URL(normalizedUrl);
        const host = parsed.hostname.toLowerCase();
        const parts = parsed.pathname.split('/').filter(Boolean);

        if (host === 'boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
            const token = parts[0] || parsed.searchParams.get('for') || '';
            return token ? { provider: 'greenhouse', token } : null;
        }
        if (host.includes('ashbyhq.com')) {
            const token = parts[0] || '';
            return token ? { provider: 'ashby', token } : null;
        }
        if (host.includes('lever.co')) {
            const token = parts[0] || '';
            return token ? { provider: 'lever', token } : null;
        }
        if (host.includes('workable.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'workable', token } : null;
        }
        if (host.includes('teamtailor.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'teamtailor', token } : null;
        }
        if (host.includes('bamboohr.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'bamboohr', token } : null;
        }
        if (host.includes('smartrecruiters.com')) {
            const token = parts[0] || host.split('.')[0] || '';
            return token ? { provider: 'smartrecruiters', token } : null;
        }
        if (host.includes('pinpointhq.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'pinpoint', token } : null;
        }
        if (host.includes('breezy.hr')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'breezy', token } : null;
        }
        if (host.includes('recruitee.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'recruitee', token } : null;
        }
        if (host.includes('jobs.personio.de') || host.includes('jobs.personio.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'personio', token } : null;
        }
        if (host.includes('icims.com')) {
            const token = host.split('.')[0] || '';
            return token ? { provider: 'icims', token } : null;
        }
        if (host.includes('myworkdayjobs.com')) {
            const subdomain = host.split('.')[0] || '';
            const boardName = parts[0] || '';
            if (subdomain && boardName && boardName !== 'en-US' && boardName !== 'en-GB') {
                return { provider: 'workday', token: `${subdomain}/${boardName}` };
            }
            return { provider: 'workday', token: normalizedUrl };
        }
    } catch {
        return null;
    }

    return { provider: 'generic_careers', token: normalizedUrl };
}

async function serperSearchLinks(query: string, num = 8): Promise<string[]> {
    if (!SERPER_API_KEY || serperDisabled) return [];
    serperCallCount++;

    try {
        const res = await fetchWithTimeout('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': SERPER_API_KEY,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0',
            },
            body: JSON.stringify({ q: query, num, gl: 'gb' }),
        }, 12000);

        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                serperDisabled = true;
                console.warn(`[SERPER] disabled after auth failure (${res.status})`);
            }
            return [];
        }

        const data: any = await res.json();
        const links: string[] = [];
        const seen = new Set<string>();

        const pushLink = (value: any): void => {
            const normalized = String(value || '').trim();
            if (!/^https?:\/\//i.test(normalized)) return;
            if (seen.has(normalized)) return;
            seen.add(normalized);
            links.push(normalized);
        };

        for (const item of data?.organic || []) {
            pushLink(item?.link);
        }

        pushLink(data?.answerBox?.link);
        pushLink(data?.answerBox?.website);
        pushLink(data?.knowledgeGraph?.website);
        pushLink(data?.knowledgeGraph?.descriptionLink);

        if (links.length > 0) serperHitCount++;
        return links;
    } catch {
        return [];
    }
}

function buildSerperDiscoveryQueries(company: CompanyRow): string[] {
    const name = company.trading_name.trim();
    const escapedName = name.replace(/\"/g, '');
    const queries = [
        `"${escapedName}" careers`,
        `"${escapedName}" jobs`,
        `"${escapedName}" apply`,
        `"${escapedName}" hiring careers`,
        `"${escapedName}" work with us`,
        `"${escapedName}" careers UK`,
        `"${escapedName}" jobs UK`,
    ];

    try {
        if (company.url) {
            const host = new URL(company.url).hostname.toLowerCase().replace(/^www\./, '');
            if (host) {
                queries.unshift(`site:${host} careers`);
                queries.unshift(`"${escapedName}" site:${host}`);
            }
        }
    } catch {
        // Ignore malformed company URLs.
    }

    for (const siteHint of SERPER_DISCOVERY_SITE_HINTS) {
        queries.push(`"${escapedName}" ${siteHint}`);
    }

    return Array.from(new Set(queries)).slice(0, 16);
}

function isLikelyCareersDiscoveryUrl(url: string, company: CompanyRow): boolean {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const path = `${parsed.pathname} ${parsed.search}`.toLowerCase();

        if (
            host.includes('greenhouse.io') ||
            host.includes('lever.co') ||
            host.includes('ashbyhq.com') ||
            host.includes('workable.com') ||
            host.includes('smartrecruiters.com') ||
            host.includes('teamtailor.com') ||
            host.includes('personio.') ||
            host.includes('pinpointhq.com') ||
            host.includes('breezy.hr') ||
            host.includes('recruitee.com') ||
            host.includes('myworkdayjobs.com') ||
            host.includes('jobvite.com')
        ) {
            return true;
        }

        if (company.url) {
            const companyHost = new URL(company.url).hostname.toLowerCase().replace(/^www\./, '');
            if (companyHost && host === companyHost) {
                return true;
            }
        }

        return /careers?|jobs?|vacanc|opportunit|apply|join|talent|work-with-us|open-roles/.test(path);
    } catch {
        return false;
    }
}

async function discoverCareersUrlsWithSerper(company: CompanyRow): Promise<string[]> {
    if (!SERPER_API_KEY || serperDisabled) return [];

    const queries = buildSerperDiscoveryQueries(company);

    const found = new Set<string>();
    for (const query of queries) {
        const links = await serperSearchLinks(query, 10);
        for (const link of links) {
            const normalized = normalizeCareersUrl(link);
            if (!normalized) continue;
            if (!isLikelyCareersDiscoveryUrl(normalized, company)) continue;
            found.add(normalized);
        }
        if (found.size >= 8) break;
    }

    return Array.from(found).slice(0, 8);
}

function absoluteUrlFromBase(base: string, href: string): string {
    try {
        return new URL(href, base).toString();
    } catch {
        return href;
    }
}

async function fetchGenericCareersPage(url: string): Promise<Job[]> {
    const target = normalizeCareersUrl(url);
    if (!target) return [];

    try {
        const res = await fetchWithTimeout(target, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml',
                'User-Agent': 'Mozilla/5.0',
            },
        }, 15000);

        if (!res.ok) return [];
        const html = await res.text();
        const $ = cheerio.load(html);
        const jobs: Job[] = [];

        $('script[type="application/ld+json"]').each((_, el) => {
            const text = $(el).text().trim();
            if (!text) return;
            try {
                const parsed = JSON.parse(text);
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                for (const entry of entries) {
                    if (!entry || entry['@type'] !== 'JobPosting') continue;
                    const locationObj = entry.jobLocation?.address || {};
                    const location = [
                        locationObj.addressLocality,
                        locationObj.addressRegion,
                        locationObj.addressCountry,
                    ].filter(Boolean).join(', ');

                    jobs.push({
                        title: String(entry.title || '').trim(),
                        location: String(location || '').trim(),
                        url: String(entry.url || target).trim(),
                        department: '',
                        salary: undefined,
                    });
                }
            } catch {
                // ignore invalid JSON-LD blocks
            }
        });

        const selectors = ['a[href*="/jobs/"]', 'a[href*="/job/"]', 'a[href*="/careers/"]'];
        const seen = new Set<string>();

        for (const selector of selectors) {
            $(selector).each((_, el) => {
                const anchor = $(el);
                const href = String(anchor.attr('href') || '').trim();
                const title = anchor.text().replace(/\s+/g, ' ').trim();
                if (!href || !isValidJobTitle(title)) return;

                const jobUrl = absoluteUrlFromBase(target, href);
                if (seen.has(jobUrl)) return;
                seen.add(jobUrl);

                const cardText = anchor.closest('li,article,div,tr').text().replace(/\s+/g, ' ').trim();
                let location = '';
                const locMatch = cardText.match(/(London|United Kingdom|UK|Manchester|Birmingham|Leeds|Remote[^,.]*UK)/i);
                if (locMatch) location = locMatch[0];

                jobs.push({
                    title,
                    location,
                    url: jobUrl,
                    department: '',
                    salary: undefined,
                });
            });
        }

        const deduped = Array.from(new Map(jobs.filter(j => j.title && j.url).map(j => [j.url, j])).values());
        return deduped.slice(0, 500);
    } catch {
        return [];
    }
}

async function fetchJobsWithFallback(company: CompanyRow, options?: { fallbackOnly?: boolean }): Promise<{
    jobs: Job[];
    provider: string;
    token: string;
    source: 'primary' | 'fallback' | 'serper';
    fallbackUsed: boolean;
}> {
    const fallbackOnly = !!options?.fallbackOnly;

    // 1. Resolve primary via alias + custom routing
    const resolved = resolveProviderAndToken(
        company.ats_provider,
        company.ats_board_token,
        company.careers_url ?? null
    );

    // 2. Infer from careers URL as fallback
    const fallbackPlan = inferAtsFromCareersUrl(company.careers_url);

    const attempts: FetchAttempt[] = [];

    const isCustom = resolved?.provider && !['workday', 'lever', 'ashby', 'greenhouse', 'workable', 'smartrecruiters', 'teamtailor'].includes(resolved.provider);

    if ((!fallbackOnly || isCustom) && resolved && FETCHERS[resolved.provider]) {
        attempts.push({ provider: resolved.provider, token: resolved.token, source: 'primary' });
    }

    if (fallbackPlan && FETCHERS[fallbackPlan.provider]) {
        const alreadyQueued = attempts.some(
            a => a.provider === fallbackPlan.provider && a.token === fallbackPlan.token
        );
        if (!alreadyQueued) {
            attempts.push({ provider: fallbackPlan.provider, token: fallbackPlan.token, source: 'fallback' });
        }
    }

    // 3. Last resort: Generic HTML scraper if we have a URL but no ATS detected
    if (attempts.length === 0 && company.careers_url) {
        attempts.push({ provider: 'generic_careers', token: company.careers_url, source: 'fallback' });
    }

    if (attempts.length === 0) {
        return {
            jobs: [],
            provider: resolved?.provider || company.ats_provider || '',
            token: resolved?.token || company.ats_board_token || '',
            source: 'primary',
            fallbackUsed: false,
        };
    }

    const errors: string[] = [];
    for (const attempt of attempts) {
        const fetcher = FETCHERS[attempt.provider];
        if (!fetcher) continue;

        try {
            let jobs = await fetcher(attempt.token);
            jobs = jobs.filter(j => isValidJobTitle(j.title));
            if (jobs.length > 0) {
                return {
                    jobs,
                    provider: attempt.provider,
                    token: attempt.token,
                    source: attempt.source,
                    fallbackUsed: attempt.source === 'fallback',
                };
            }
            errors.push(`${attempt.provider}:${attempt.source}=0`);
        } catch (error: any) {
            errors.push(`${attempt.provider}:${attempt.source}=${error?.message || 'error'}`);
        }
    }

    const serperUrls = await discoverCareersUrlsWithSerper(company);
    for (const discoveredUrl of serperUrls) {
        const inferred = inferAtsFromCareersUrl(discoveredUrl);
        if (!inferred) continue;

        const fetcher = FETCHERS[inferred.provider];
        if (!fetcher) continue;

        try {
            let jobs = await fetcher(inferred.token);
            jobs = jobs.filter(j => isValidJobTitle(j.title));
            if (jobs.length > 0) {
                return {
                    jobs,
                    provider: inferred.provider,
                    token: inferred.token,
                    source: 'serper',
                    fallbackUsed: true,
                };
            }
            errors.push(`${inferred.provider}:serper=0`);
        } catch (error: any) {
            errors.push(`${inferred.provider}:serper=${error?.message || 'error'}`);
        }
    }

    if (errors.length > 0) {
        console.log(`  [FALLBACK] ${company.trading_name} — ${errors.join(' | ')}`);
    }

    const bestAttempt = attempts[attempts.length - 1];
    return {
        jobs: [],
        provider: bestAttempt.provider,
        token: bestAttempt.token,
        source: bestAttempt.source,
        fallbackUsed: bestAttempt.source === 'fallback',
    };
}

async function loadAtsOverrides(companyIds: number[]): Promise<Map<number, AtsOverrideRow>> {
    const overrides = new Map<number, AtsOverrideRow>();
    const pageSize = 500;

    for (let i = 0; i < companyIds.length; i += pageSize) {
        const chunk = companyIds.slice(i, i + pageSize);

        let query = supabase
            .from('ats_import_audit')
            .select('company_id, sync_provider, provider_raw, board_token_raw, careers_url_raw')
            .in('company_id', chunk);

        let { data, error } = await query;

        if (error) {
            const legacy = await supabase
                .from('ats_import_audit')
                .select('company_id, provider_raw, board_token_raw, careers_url_raw')
                .in('company_id', chunk);

            data = (legacy.data || []) as any;
            error = legacy.error;
        }

        if (error) {
            console.warn(`Could not load ATS overrides for chunk ${i}-${i + chunk.length - 1}: ${error.message}`);
            continue;
        }

        for (const row of (data || []) as AtsOverrideRow[]) {
            overrides.set(row.company_id, row);
        }
    }

    return overrides;
}

async function loadAllCompanies(specificIds: number[] | null): Promise<CompanyRow[]> {
    const EXCEL_PATH_NEW = path.resolve(process.cwd(), 'data/excel/Testing_jobs_data.xlsx');
    const EXCEL_PATH_OLD = path.resolve(process.cwd(), 'Testing_jobs_data.xlsx');
    const EXCEL_PATH = fs.existsSync(EXCEL_PATH_NEW) ? EXCEL_PATH_NEW : EXCEL_PATH_OLD;

    if (fs.existsSync(EXCEL_PATH)) {
        console.log(`[INPUT] Reading companies from ${EXCEL_PATH}...`);
        const workbook = XLSX.readFile(EXCEL_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const companies: CompanyRow[] = (data as any[]).map(row => ({
            id: Number(row['Company ID'] || 0),
            trading_name: String(row['Company Name'] || '').trim(),
            ats_provider: String(row['ATS Provider'] || '').trim(),
            ats_board_token: String(row['ATS Board Token'] || '').trim(),
            careers_url: String(row['URL'] || '').trim(),
        })).filter(c => c.trading_name);

        if (specificIds && specificIds.length > 0) {
            return companies.filter(c => specificIds.includes(c.id));
        }
        return companies;
    }

    // ─── DATABASE LOAD FALLBACK ───
    if (specificIds && specificIds.length > 0) {
        const { data, error } = await supabase
            .from('companies')
            .select('id, trading_name, ats_provider, ats_board_token, url')
            .in('id', specificIds)
            .order('trading_name');

        if (error) {
            throw new Error(`Could not load filtered companies: ${error.message}`);
        }

        const companies = (data || []) as CompanyRow[];
        const overrides = await loadAtsOverrides(companies.map(c => c.id));

        return companies.map(company => {
            const override = overrides.get(company.id);
            const base = {
                ...company,
                careers_url: company.url
            };
            if (!override) return base;

            return {
                ...base,
                ats_provider: normalizeProviderName(override.sync_provider || override.provider_raw) || company.ats_provider,
                ats_board_token: override.board_token_raw?.trim() || company.ats_board_token,
                careers_url: normalizeCareersUrl(override.careers_url_raw) || base.careers_url,
            };
        });
    }

    const pageSize = 1000;
    let from = 0;
    const all: CompanyRow[] = [];

    while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
            .from('companies')
            .select('id, trading_name, ats_provider, ats_board_token, url')
            .order('id', { ascending: true })
            .range(from, to);

        if (error) {
            throw new Error(`Could not load companies page ${from}-${to}: ${error.message}`);
        }

        const rows = (data || []) as CompanyRow[];
        if (rows.length === 0) break;

        all.push(...rows);

        if (rows.length < pageSize) break;
        from += pageSize;
    }

    const overrides = await loadAtsOverrides(all.map(c => c.id));

    const merged = all.map(company => {
        const override = overrides.get(company.id);
        const base = {
            ...company,
            careers_url: company.url
        };
        if (!override) return base;

        return {
            ...base,
            ats_provider: normalizeProviderName(override.sync_provider || override.provider_raw) || company.ats_provider,
            ats_board_token: override.board_token_raw?.trim() || company.ats_board_token,
            careers_url: normalizeCareersUrl(override.careers_url_raw) || base.careers_url,
        };
    });

    return merged.sort((a, b) => a.trading_name.localeCompare(b.trading_name));
}

function normalizeTeamtailorHtmlToken(token: string): string {
    const trimmed = String(token || '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed.replace(/\/$/, '');
    }
    if (trimmed.includes('.teamtailor.com')) {
        return `https://${trimmed.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
    }
    return `https://${trimmed}.teamtailor.com/jobs`;
}

// ─── ATS Fetchers — each accepts (token: string) and returns Job[] ─────────

async function fetchGreenhouse(token: string): Promise<Job[]> {
    // Support tokens like "gympass?office_id=4038159002"
    const [boardToken, query] = token.split('?');
    const officeId = query?.split('=')[1];

    // boards-api.greenhouse.io is the definitive JSON API.
    // Some boards (like Winton) require the .eu subdomain.
    const subdomains = ['boards-api', 'boards-api.eu'];

    for (const sub of subdomains) {
        const url = `https://${sub}.greenhouse.io/v1/boards/${boardToken}/jobs?content=true${officeId ? `&office_id=${officeId}` : ''}`;
        try {
            const r = await fetchWithTimeout(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            if (!r.ok) continue;
            const text = await r.text();
            if (!text || !text.startsWith('{')) continue; // skip HTML responses
            const d = JSON.parse(text);
            const jobs: Job[] = (d.jobs || []).map((j: any) => {
                const offices = j.offices || [];
                let location = j.location?.name || '';
                // Gap 2: Read the full offices array
                if (offices.length > 0) {
                    const allOffices = offices.map((o: any) => o.name || o.location).filter(Boolean);
                    if (allOffices.length > 0) {
                        location = allOffices.join(' | ');
                    }
                }
                return {
                    title: j.title || '',
                    location: location,
                    url: j.absolute_url || j.url || '',
                    department: j.departments?.[0]?.name || '',
                    salary: undefined
                };
            });
            if (jobs.length > 0) return jobs;
        } catch { }
    }
    return [];
}

async function fetchAshby(token: string): Promise<Job[]> {
    try {
        const r = await fetchWithTimeout(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
        if (!r.ok) return [];
        const d = await r.json();
        return (d.jobs || []).map((j: any) => {
            const locRaw = typeof j.location === 'string' ? j.location : (j.location?.name || '');
            const secLocs = (j.secondaryLocations || [])
                .map((l: any) => typeof l === 'string' ? l : (l.location || l.name || ''))
                .join(' ');
            // Gap 4: Ashby Remote boolean check
            return {
                title: j.title || '',
                location: `${locRaw} ${secLocs} ${j.isRemote ? 'Remote' : ''}`.trim(),
                url: j.jobUrl || '',
                department: j.department || '',
                salary: undefined
            };
        });
    } catch { return []; }
}

async function fetchLever(token: string): Promise<Job[]> {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0';
    // Lever boards can be in US or EU regions
    const bases = ['https://api.eu.lever.co/v0/postings', 'https://api.lever.co/v0/postings'];

    for (const base of bases) {
        try {
            // 1. Try grouped by team (better department info)
            const r = await fetchWithTimeout(`${base}/${token}?group=team&mode=json`, { headers: { 'User-Agent': ua } });
            if (r.ok) {
                const d = await r.json();
                if (Array.isArray(d) && d.length > 0 && d[0].postings) {
                    const jobs: Job[] = [];
                    d.forEach((group: any) => {
                        (group.postings || []).forEach((p: any) => {
                            // Gap 3: Combines location and team/department and tags
                            const loc = p.categories?.location || p.workplaceType || '';
                            const team = p.categories?.department || p.categories?.team || group.title || '';
                            const tags = (p.tags || []).join(' ');
                            jobs.push({
                                title: p.text || '',
                                location: `${loc} ${team} ${tags}`.trim(),
                                url: p.hostedUrl || '',
                                department: team,
                                salary: undefined
                            });
                        });
                    });
                    if (jobs.length > 0) return jobs;
                }
            }

            // 2. Try flat list fallback
            const r2 = await fetchWithTimeout(`${base}/${token}?mode=json`, { headers: { 'User-Agent': ua } });
            if (r2.ok) {
                const d2 = await r2.json();
                if (Array.isArray(d2) && d2.length > 0) {
                    return d2.map((p: any) => {
                        const loc = p.categories?.location || p.workplaceType || '';
                        const team = p.categories?.department || p.categories?.team || '';
                        const tags = (p.tags || []).join(' ');
                        return {
                            title: p.text || '',
                            location: `${loc} ${team} ${tags}`.trim(),
                            url: p.hostedUrl || '',
                            department: team,
                            salary: undefined
                        };
                    });
                }
            }
        } catch { continue; }
    }
    return [];
}

async function fetchWorkable(token: string): Promise<Job[]> {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0';

    // 1. Try public detail API (most reliable/fastest)
    try {
        const r = await fetchWithTimeout(`https://www.workable.com/api/accounts/${token}?detail=true`, {
            headers: { 'User-Agent': ua, 'Accept': 'application/json' }
        });
        if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d.jobs)) {
                return d.jobs.map((j: any) => ({
                    title: j.title || '',
                    location: [j.city, j.state, j.country].filter(Boolean).join(', ') || (j.telecommuting ? 'Remote' : ''),
                    url: j.url || j.shortlink || `https://apply.workable.com/j/${j.shortcode}`,
                    department: j.department || '',
                    salary: undefined
                }));
            }
        }
    } catch { }

    // 2. Try v3 API fallback (in case public API fails/different structure)
    try {
        const body = { query: '', location: [], department: [], worktype: [], remote: [] };
        const r = await fetchWithTimeout(`https://apply.workable.com/api/v3/accounts/${token}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
            body: JSON.stringify(body)
        });
        if (r.ok) {
            const d = await r.json();
            return (d.results || []).map((j: any) => ({
                title: j.title || '',
                location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ') || (j.remote ? 'Remote' : ''),
                url: `https://apply.workable.com/${token}/j/${j.shortcode}/`,
                department: j.department || '',
                salary: undefined
            }));
        }
    } catch { }

    return [];
}

async function fetchTeamtailor(token: string): Promise<Job[]> {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0';
    // 1. Try JSON first
    try {
        const url = token.includes('.') ? `https://${token}/jobs.json` : `https://${token}.teamtailor.com/jobs.json`;
        const r = await fetchWithTimeout(url, {
            headers: {
                'User-Agent': ua,
                'Accept': 'application/vnd.api+json',
                'Referer': token.includes('.') ? `https://${token}/` : `https://${token}.teamtailor.com/`
            }
        });
        if (r.ok) {
            const d = await r.json();
            if (d.data?.length > 0) {
                return d.data.map((j: any) => ({
                    title: j.attributes?.title || '',
                    location: j.attributes?.['human-location'] || '',
                    url: j.links?.['careersite-job-url'] || '',
                    department: '',
                    salary: undefined
                }));
            }
        }
    } catch { }

    // 2. Try RSS as fallback
    try {
        const rssUrl = token.includes('.') ? `https://${token}/jobs.rss` : `https://${token}.teamtailor.com/jobs.rss`;
        const r = await fetchWithTimeout(rssUrl, { headers: { 'User-Agent': ua } });
        if (!r.ok) return [];

        const xml = await r.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        const jobs: Job[] = [];

        $('item').each((_, el) => {
            const item = $(el);
            jobs.push({
                title: item.find('title').text().trim(),
                location: item.find('description').text().split('·')[1]?.trim() || '',
                url: item.find('link').text().trim(),
                department: item.find('category').first().text().trim(),
                salary: (typeof item !== 'undefined' && (item as any)?.salary) ? String(typeof (item as any).salary === 'object' ? JSON.stringify((item as any).salary) : (item as any).salary) : undefined
            });
        });
        return jobs;
    } catch { return []; }
}

async function fetchBambooHR(token: string): Promise<Job[]> {
    try {
        // Try the open /careers/list endpoint first
        const r = await fetchWithTimeout(`https://${token}.bamboohr.com/careers/list`);
        if (r.ok) {
            const d = await r.json();
            return (d.result || []).map((j: any) => ({
                title: j.jobOpeningName || '',
                location: [
                    j.location?.city,
                    j.location?.state,
                    j.location?.country
                ].filter(Boolean).join(', '),
                url: `https://${token}.bamboohr.com/careers/${j.id}`,
                department: '',
                salary: undefined
            }));
        }
        // Fallback: applicant tracking API
        const r2 = await fetchWithTimeout(
            `https://api.bamboohr.com/api/gateway.php/${token}/v1/applicant_tracking/jobs?status=Open`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (!r2.ok) return [];
        const d2 = await r2.json();
        return (d2 || []).map((j: any) => ({
            title: j.jobTitle?.label || j.title || '',
            location: j.location?.label || '',
            url: `https://${token}.bamboohr.com/jobs/${j.id}/`,
            department: j.department?.label || '',
            salary: undefined
        }));
    } catch { return []; }
}

async function fetchSmartRecruiters(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let offset = 0;
    while (true) {
        try {
            const r = await fetchWithTimeout(
                `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${offset}&status=PUBLISHED`
            );
            if (!r.ok) break;
            const d = await r.json();
            const content = d.content || [];
            if (content.length === 0) break;

            allJobs.push(...content.map((j: any) => ({
                title: j.name || '',
                location: `${j.location?.city || ''} ${j.location?.country || ''}`.trim(),
                url: `https://jobs.smartrecruiters.com/${token}/${j.id}`,
                department: j.department?.label || '',
                salary: undefined
            })));

            if (content.length < 100) break;
            offset += 100;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

async function fetchPinpoint(token: string): Promise<Job[]> {
    try {
        const r = await fetchWithTimeout(`https://${token}.pinpointhq.com/postings.json`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!r.ok) return [];
        const d = await r.json();
        return (d.data || []).map((j: any) => {
            const locRaw = j.location;
            let location = '';
            if (locRaw && typeof locRaw === 'object') {
                const parts = [locRaw.name || locRaw.city, locRaw.province].filter(Boolean);
                location = parts.join(', ');
            } else {
                location = String(locRaw || '');
            }
            return {
                title: j.title || '',
                location,
                url: j.url || `https://${token}.pinpointhq.com${j.path || ''}`,
                department: j.job_function || j.department || '',
                salary: undefined
            };
        });
    } catch { return []; }
}

async function fetchBreezy(token: string): Promise<Job[]> {
    try {
        const r = await fetchWithTimeout(`https://${token}.breezy.hr/json`);
        if (!r.ok) return [];
        const d = await r.json();
        return (d || []).map((j: any) => ({
            title: j.name || '',
            location: j.location?.name || '',
            url: j.url || '',
            department: j.department?.name || '',
            salary: undefined
        }));
    } catch { return []; }
}

async function fetchRecruitee(token: string): Promise<Job[]> {
    try {
        const url = token.includes('.')
            ? `https://${token}/api/offers/?state=published`
            : `https://${token}.recruitee.com/api/offers/?state=published`;

        const r = await fetchWithTimeout(url);
        if (!r.ok) return [];
        const d = await r.json();
        return (d.offers || []).map((j: any) => ({
            title: j.title || '',
            location: j.location || j.city || '',
            url: j.careers_url || '',
            department: j.department || '',
            salary: undefined
        }));
    } catch { return []; }
}

async function fetchJobvite(token: string): Promise<Job[]> {
    try {
        const r = await fetchWithTimeout(`https://jobs.jobvite.com/api/company/${token}/jobs`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.ok) {
            const text = await r.text();
            try {
                const d = JSON.parse(text);
                const apiJobs = (d.jobs || []).map((j: any) => ({
                    title: j.title || j.jobTitle || '',
                    location: j.location || '',
                    url: j.applyUrl || j.url || `https://jobs.jobvite.com/${token}/job/${j.id || ''}`,
                    department: j.category || j.department || '',
                    salary: undefined
                }));
                if (apiJobs.length > 0) return apiJobs;
            } catch {
                // Some Jobvite tenants return HTML from this endpoint.
            }
        }

        const htmlRes = await fetchWithTimeout(`https://jobs.jobvite.com/${token}/jobs`, {
            headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!htmlRes.ok) return [];
        const html = await htmlRes.text();
        const $ = cheerio.load(html);
        const jobs: Job[] = [];

        $('a[href*="/job/"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const title = $(el).text().trim();
            if (!href || !isValidJobTitle(title)) return;

            const row = $(el).closest('li, tr, div');
            const location = row.find('[class*="location"], [data-qa*="location"]').first().text().trim();
            jobs.push({
                title,
                location,
                url: href.startsWith('http') ? href : `https://jobs.jobvite.com${href}`,
                department: '',
                salary: undefined,
            });
        });

        return Array.from(new Map(jobs.map((j) => [j.url, j])).values());
    } catch {
        return [];
    }
}

async function fetchAvature(token: string): Promise<Job[]> {
    try {
        const subdomain = String(token || '').trim().replace(/^https?:\/\//, '').split('.')[0];
        if (!subdomain) return [];
        const r = await fetchWithTimeout(`https://${subdomain}.avature.net/api/rest/v1/jobs`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!r.ok) return [];
        const d = await r.json();
        return (d.items || []).map((j: any) => ({
            title: j.jobTitle || j.title || '',
            location: j.location || '',
            url: j.detailUrl || j.url || `https://${subdomain}.avature.net/`,
            department: j.category || j.department || '',
            salary: undefined
        }));
    } catch {
        return [];
    }
}

async function fetchTeamtailorHtml(token: string): Promise<Job[]> {
    const startUrl = normalizeTeamtailorHtmlToken(token);
    if (!startUrl) return [];

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0',
            viewport: { width: 1280, height: 1080 }
        });
        const page = await context.newPage();
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        const jobs = await page.evaluate(() => {
            const seen = new Set<string>();
            const output: Array<{ id: string; title: string; url: string; location: string }> = [];

            const structuredRows = Array.from(document.querySelectorAll('[data-job-id]'));
            for (const node of structuredRows) {
                const element = node as HTMLElement;
                const jobId = element.getAttribute('data-job-id') || '';
                const anchor = element.querySelector('a') as HTMLAnchorElement | null;
                const href = anchor?.href || '';
                if (!href || seen.has(href)) continue;
                const titleText = (anchor?.textContent || element.innerText || '').trim();
                const locationNode = element.querySelector('[data-testid*="location"], .location, .job-location') as HTMLElement | null;
                const locationText = (locationNode?.innerText || '').trim();
                output.push({ id: jobId, title: titleText, url: href, location: locationText });
                seen.add(href);
            }

            // Fallback pattern used by some Teamtailor pages: job links only.
            const jobAnchors = Array.from(document.querySelectorAll('a[href*="/jobs/"]')) as HTMLAnchorElement[];
            for (const anchor of jobAnchors) {
                const href = anchor.href || '';
                if (!href || seen.has(href)) continue;
                const titleText = (anchor.textContent || '').trim();
                if (!titleText) continue;
                const card = anchor.closest('li, article, div, section') as HTMLElement | null;
                const locationNode = card?.querySelector('[data-testid*="location"], .location, .job-location, [class*="location"]') as HTMLElement | null;
                const locationText = (locationNode?.innerText || '').trim();
                output.push({ id: '', title: titleText, url: href, location: locationText });
                seen.add(href);
            }

            return output;
        });

        await browser.close();

        return jobs
            .filter((j: any) => j.title && j.url && isValidJobTitle(j.title))
            .map((j: any) => ({
                title: j.title,
                location: j.location || '',
                url: j.url,
                department: '',
                salary: undefined
            }));
    } catch {
        if (browser) await browser.close();
        return [];
    }
}

async function fetchPersonio(token: string): Promise<Job[]> {
    try {
        const r = await fetchWithTimeout(`https://${token}.jobs.personio.de/xml?language=en`);
        if (!r.ok) return [];
        const xml = await r.text();
        const posBlocks = xml.match(/<position>([\s\S]*?)<\/position>/g) || [];
        return posBlocks.map(block => {
            const get = (tag: string) => {
                const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`));
                return m ? m[1].trim() : '';
            };
            return {
                title: get('name') || get('title'),
                location: get('office') || get('location'),
                url: get('jobUrl') || `https://${token}.jobs.personio.de`,
                department: get('department'),
                salary: undefined
            };
        });
    } catch { return []; }
}

async function fetchWorkday(token: string): Promise<Job[]> {
    let slug = '';
    let board = '';
    let detectedWd = '';
    let dbAppliedFacets: any = null;

    if (token.startsWith('{')) {
        try {
            const config = JSON.parse(token);
            if (config.appliedFacets) dbAppliedFacets = config.appliedFacets;
            if (config.url) token = config.url;
            else if (config.token) token = config.token;
        } catch { /* ignore */ }
    }

    if (token.startsWith('http')) {
        try {
            const parsed = new URL(token);
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const hostParts = parsed.hostname.split('.');

            // Extract wd subdomain if present (e.g., company.wd3.myworkdayjobs.com)
            const wdPart = hostParts.find(p => /^wd\d+$/.test(p));
            if (wdPart) detectedWd = wdPart;

            const filteredParts = pathParts.filter(p => !['wday', 'cxs', 'en-us', 'en-gb', 'jobs'].includes(p.toLowerCase()));

            if (hostParts[0] && !hostParts[0].startsWith('wd')) {
                slug = hostParts[0];
                board = filteredParts.find(p => p !== slug) || filteredParts[0] || '';
            } else if (pathParts.length >= 2) {
                slug = pathParts[0];
                board = filteredParts.find(p => p !== slug) || filteredParts[1] || '';
            }
        } catch { /* ignore */ }
    } else {
        const parts = token.split('/');
        slug = parts[0];
        board = parts.slice(1).join('/');
    }

    if (!slug || !board) return [];

    // Wells Fargo uses myworkdaysite.com.
    const isWorkdaySite = slug === 'wf' || slug.includes('hcahealthcare');

    // Subdomains to try. If we detected one from the URL, put it first.
    const wds = ['wd3', 'wd1', 'wd5', 'wd103', 'wd107', 'wd108', 'wd12', 'wd2'];
    if (detectedWd && wds.includes(detectedWd)) {
        wds.splice(wds.indexOf(detectedWd), 1);
        wds.unshift(detectedWd);
    }

    for (const wd of wds) {
        const ukFacetId = WORKDAY_UK_FACETS[slug] || WORKDAY_UK_FACETS['default'];
        // Try both slug.wd.domain and wd.domain
        const domains = isWorkdaySite
            ? [`${slug}.${wd}.myworkdaysite.com`, `${wd}.myworkdaysite.com`]
            : [`${slug}.${wd}.myworkdayjobs.com`, `${wd}.myworkdayjobs.com`];

        for (const domain of domains) {
            const apiUrl = `https://${domain}/wday/cxs/${slug}/${board}/jobs`;
            const publicBase = `https://${domain}/en-US/${board}`;

            try {
                let currentFacets: any = { locationCountry: [ukFacetId] };
                if (dbAppliedFacets?.locations) {
                    currentFacets = { locations: dbAppliedFacets.locations };
                } else if (dbAppliedFacets?.locationCountry) {
                    currentFacets = { locationCountry: dbAppliedFacets.locationCountry };
                } else if (dbAppliedFacets?.Location_Country) {
                    currentFacets = { Location_Country: dbAppliedFacets.Location_Country };
                }

                let res = await fetchWithTimeout(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                    body: JSON.stringify({
                        appliedFacets: currentFacets,
                        limit: 20, offset: 0, searchText: ''
                    })
                });

                if (!res.ok && !dbAppliedFacets) {
                    // Try alternate location facet (only if no explicit DB config)
                    currentFacets = { Location_Country: [ukFacetId] };
                    res = await fetchWithTimeout(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                        body: JSON.stringify({
                            appliedFacets: currentFacets,
                            limit: 20, offset: 0, searchText: ''
                        })
                    });
                }

                if (!res.ok) {
                    // Fallback: no facets
                    currentFacets = {};
                    res = await fetchWithTimeout(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                        body: JSON.stringify({ appliedFacets: currentFacets, limit: 20, offset: 0, searchText: '' })
                    });
                }

                if (!res.ok) {
                    continue;
                }

                const data = await res.json();
                let posts = data?.jobPostings || [];

                let total = data.total || 0;

                // If UK facet returned 0, but the company is expected to have jobs, try without facet
                if (posts.length === 0) {
                    currentFacets = {};
                    const noFacetRes = await fetchWithTimeout(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                        body: JSON.stringify({ appliedFacets: currentFacets, limit: 20, offset: 0, searchText: '' })
                    });
                    if (noFacetRes.ok) {
                        const noFacetData = await noFacetRes.json();
                        posts = noFacetData.jobPostings || [];
                        total = noFacetData.total || 0;
                    }
                }

                if (posts.length === 0) {
                    if (isWorkdaySite) break;
                    continue;
                }

                const allJobs: Job[] = [];
                let offset = 0;
                const finalFacets = data.appliedFacets || currentFacets || {};

                // Sanity check: did the UK facet actually work?
                let facetIsTrusted = Object.keys(finalFacets).length > 0;
                if (facetIsTrusted && posts.length > 0) {
                    const sample = posts.slice(0, 20);
                    let hasExplicitUK = false;
                    let hasExplicitNonUK = false;

                    for (const p of sample) {
                        const loc = normalizeLocation(p.locationsText || p.bulletFields?.[1] || '');
                        const isUK = isUKLocation(loc);
                        const isNonUK = !isUK && !/^(remote|flexible|hybrid|anywhere|worldwide|global|distributed|not specified)$/.test(loc) && !/\d+\s+locations?/.test(loc);

                        if (isUK) hasExplicitUK = true;
                        if (isNonUK) {
                            hasExplicitNonUK = true;
                            break;
                        }
                    }

                    // If we found ANY explicit non-UK, or we found NO explicit UK (only ambiguous), don't trust.
                    if (hasExplicitNonUK || !hasExplicitUK) {
                        facetIsTrusted = false;
                    }
                }

                while (offset < total || (offset === 0 && posts.length > 0)) {
                    let currentPosts = posts;
                    if (offset > 0) {
                        const nextRes = await fetchWithTimeout(apiUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                            body: JSON.stringify({
                                appliedFacets: finalFacets,
                                limit: 20, offset, searchText: ''
                            })
                        });
                        if (nextRes.ok) {
                            const nextData = await nextRes.json();
                            currentPosts = nextData.jobPostings || [];
                        } else break;
                    }

                    if (currentPosts.length === 0) break;
                    allJobs.push(...currentPosts.map((j: any) => ({
                        title: j.title || '',
                        location: j.locationsText || j.bulletFields?.[1] || '',
                        url: `${publicBase}${j.externalPath}`,
                        department: '',
                        salary: undefined,
                        verified: facetIsTrusted,
                        atsProvider: 'workday',
                        locationsText: j.locationsText || j.bulletFields?.[1] || ''
                    })));

                    offset += 20;
                    await sleep(300);
                }
                return allJobs;
            } catch (err: any) {
                // Silently ignore "fetch failed" as it's expected when brute-forcing subdomains
                if (!err.message?.includes('fetch failed')) {
                    console.log(`[WORKDAY] Error fetching ${domain}: ${err.message}`);
                }
                continue;
            }
        }
    }
    return [];
}

async function fetchOracleCloud(token: string): Promise<Job[]> {
    try {
        const [domain, site] = token.split('|');
        const url = `https://${domain}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation,requisitionList.otherWorkLocations,requisitionList.secondaryLocations,flexFieldsFacet.values,requisitionList.requisitionFlexFields&finder=findReqs;siteNumber=${site},facetsList=LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS,limit=100,sortBy=POSTING_DATES_DESC`;
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return [];
        const data: any = await res.json();
        return (data.items?.[0]?.requisitionList || []).map((j: any) => ({
            title: j.Title || '',
            location: j.PrimaryLocation || j.workLocation?.Region || '',
            url: `https://${domain}/hcmUI/CandidateExperience/en/sites/${site}/job/${j.Id}`,
            department: j.Organization || '',
            salary: undefined
        }));
    } catch { return []; }
}

async function fetchWipro(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let pageNumber = 0;
    while (true) {
        try {
            const r = await fetchWithTimeout("https://careers.wipro.com/services/recruiting/v1/jobs", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0",
                },
                body: JSON.stringify({
                    locale: "en_US",
                    pageNumber: pageNumber,
                    sortBy: "",
                    keywords: "",
                    location: "United Kingdom",
                    facetFilters: {},
                    brand: "",
                    skills: [],
                    categoryId: 0,
                    alertId: "",
                    rcmCandidateId: ""
                })
            });
            if (!r.ok) break;
            const d = await r.json();
            const results = d.jobSearchResult || [];
            if (results.length === 0) break;

            allJobs.push(...results.map((item: any) => {
                const j = item.response;
                return {
                    title: j.unifiedStandardTitle || "",
                    location: (j.jobLocationShort && j.jobLocationShort[0]) || "",
                    url: `https://careers.wipro.com/job/${j.unifiedUrlTitle}/${j.id}-en_US`,
                    department: (j.custRMKMappingPicklist && j.custRMKMappingPicklist[0]) || "",
                    salary: undefined
                };
            }));

            if (results.length < 10) break; // Wipro seems to return 10 per page by default
            pageNumber++;
            await sleep(300);
        } catch { break; }
    }
    return allJobs;
}

async function fetchSuccessFactors(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let startrow = 0;
    while (true) {
        try {
            const url = `https://careers.${token}/search/?q=&locationsearch=united+kingdom&startrow=${startrow}`;
            const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) break;
            const html = await res.text();
            const $ = cheerio.load(html);
            const rows = $('tr.data-row');
            if (rows.length === 0) break;
            rows.each((_, el) => {
                const row = $(el);
                const titleLink = row.find('.jobTitle a');
                const title = titleLink.text().trim();
                const jobUrl = titleLink.attr('href');
                const location = row.find('.jobLocation').text().trim();
                if (title && jobUrl) {
                    allJobs.push({
                        title,
                        location: location.split('\n')[0].trim(),
                        url: jobUrl.startsWith('http') ? jobUrl : `https://careers.${token}${jobUrl}`
                        ,
                        salary: undefined
                    });
                }
            });
            if (rows.length < 20) break;
            startrow += 20;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

async function fetchHibob(token: string): Promise<Job[]> {
    try {
        // token is the company identifier, e.g. "ustwo"
        const domain = token.includes('.') ? token : `${token}.careers.hibob.com`;
        const companyId = token.split('.')[0];

        const r = await fetchWithTimeout(`https://${domain}/api/job-ad`, {
            headers: {
                'Accept': 'application/json',
                'companyidentifier': companyId,
                'referer': `https://${domain}/jobs`
            }
        });
        if (!r.ok) return [];
        const d = await r.json();
        return (d.jobAdDetails || []).map((j: any) => ({
            title: j.title || '',
            location: `${j.site || ''} ${j.country || ''}`.trim(),
            url: `https://${domain}/jobs/${j.id}`,
            department: typeof j.department === 'string' ? j.department : (j.department?.name || ''),
            salary: undefined
        }));
    } catch { return []; }
}

async function fetchEightfold(token: string): Promise<Job[]> {
    // token format: "domain.com|filter_country" e.g. "vodafone.com|United Kingdom"
    const [domain, country] = token.split('|');
    if (!domain) return [];

    const allJobs: Job[] = [];
    let start = 0;
    const PAGE_SIZE = 10;

    while (true) {
        try {
            const countryFilter = country ? `&filter_country=${encodeURIComponent(country)}` : '';
            const url = `https://jobs.${domain}/api/pcsx/search?domain=${domain}&query=&location=&start=${start}&sort_by=timestamp${countryFilter}`;

            const res = await fetchWithTimeout(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0',
                    'Accept': 'application/json'
                }
            });

            if (!res.ok) break;
            const d = await res.json();
            const positions = d.data?.positions || [];
            if (positions.length === 0) break;

            allJobs.push(...positions.map((p: any) => ({
                title: p.name || '',
                location: p.locations?.[0] || p.standardizedLocations?.[0] || '',
                url: `https://jobs.${domain}${p.positionUrl}`,
                department: p.department || '',
                salary: (typeof p !== 'undefined' && (p as any)?.salary) ? String(typeof (p as any).salary === 'object' ? JSON.stringify((p as any).salary) : (p as any).salary) : undefined
            })));

            if (positions.length < PAGE_SIZE) break;
            start += positions.length;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

async function fetchICIMS(token: string): Promise<Job[]> {
    try {
        // iCIMS usually has a job search JSON endpoint at [customer].icims.com/jobs/search?pr=[page]&in_iframe=1&schemaId=job&json=1
        // But for LSL Property Services specifically, we might need a different pattern if the above fails.
        // Let's implement a robust version that tries the common JSON endpoint.
        const allJobs: Job[] = [];
        let pr = 0;

        while (true) {
            const url = `https://${token}.icims.com/jobs/search?pr=${pr}&in_iframe=1&schemaId=job&json=1`;
            const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) break;

            const data: any = await res.json();
            // iCIMS JSON structure is often an array of job objects directly or in a 'results' field
            const results = Array.isArray(data) ? data : (data.results || []);
            if (results.length === 0) break;

            allJobs.push(...results.map((j: any) => ({
                title: j.title || j.JobTitle || '',
                location: j.location || j.JobLocation || '',
                url: j.url || `https://${token}.icims.com/jobs/${j.id || j.JobId}/job`,
                department: j.department || j.JobCategory || '',
                salary: undefined
            })));

            if (results.length < 10) break; // Arbitrary small page size check
            pr++;
        }
        return allJobs;
    } catch { return []; }
}

async function fetchRippling(token: string): Promise<Job[]> {
    // Rippling uses Next.js - job data is embedded in __NEXT_DATA__ script tag
    try {
        const url = `https://ats.rippling.com/${token}/jobs`;
        const r = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
        });
        if (!r.ok) return [];
        const html = await r.text();
        const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (!match) return [];
        const data = JSON.parse(match[1]);
        // Job data is nested in dehydratedState queries
        const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
        const items: any[] = queries.flatMap((q: any) => q?.state?.data?.items || []);
        return items.map((j: any) => ({
            title: j.name || '',
            location: (j.locations || []).map((l: any) => l.name || l.city || '').join(', '),
            url: j.url || `https://ats.rippling.com/${token}/jobs/${j.id}`,
            department: j.department?.name || '',
            salary: undefined
        }));
    } catch { return []; }
}

async function fetchAmazon(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    const batchSize = 100;
    let offset = 0;
    while (true) {
        const url = `https://www.amazon.jobs/en/search.json?offset=${offset}&result_limit=${batchSize}&sort=relevant&job_type%5B%5D=Full-Time&country%5B%5D=GBR`;
        try {
            const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) break;
            const data: any = await res.json();
            if (!data.jobs || data.jobs.length === 0) break;
            const ukJobs = data.jobs.filter((j: any) => j.country_code === 'UK' || j.country_code === 'GB' || j.country_code === 'GBR');
            for (const job of ukJobs) {
                const locParts = [job.normalized_location || job.city, job.state].filter(Boolean);
                allJobs.push({
                    title: job.title || '',
                    location: locParts.join(', ') || 'United Kingdom',
                    url: `https://www.amazon.jobs${job.job_path}`,
                    department: job.job_category || job.job_family_name || 'Various',
                    salary: undefined
                });
            }
            if (offset >= data.hits) break;
            offset += batchSize;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

async function fetchJPMorgan(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let offset = 0;
    let total = 1;

    // Default to CX_1001 and London/UK ID
    let siteNumber = 'CX_1001';
    let locationId = '300000000289276';

    // If token is a full URL, try to extract siteNumber and locationId
    if (token.startsWith('http')) {
        const siteMatch = token.match(/sites\/([^/?#]+)/);
        if (siteMatch) siteNumber = siteMatch[1];

        const locMatch = token.match(/locationId=([^&]+)/);
        if (locMatch) locationId = locMatch[1];
    }

    try {
        while (offset < total) {
            const url = `https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&finder=findReqs;siteNumber=${siteNumber},facetsList=LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS,limit=25,locationId=${locationId},offset=${offset},sortBy=POSTING_DATES_DESC`;
            const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) {
                console.log(`[JPMC] API returned status ${res.status} at offset ${offset}`);
                break;
            }
            const data: any = await res.json();
            if (!data.items || data.items.length === 0) {
                if (offset === 0) console.log(`[JPMC] No items returned from API`);
                break;
            }
            const pageData = data.items[0];
            total = pageData.TotalJobsCount || 0;
            if (pageData.requisitionList) {
                for (const job of pageData.requisitionList) {
                    allJobs.push({
                        title: job.Title || '',
                        location: job.PrimaryLocation || 'United Kingdom',
                        url: `https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${job.Id}`,
                        department: '',
                        salary: undefined
                    });
                }
            } else { break; }
            offset += 25;
            await sleep(500);
        }
    } catch (e: any) {
        console.error(`[JPMC] Fetch error at offset ${offset}:`, e.message);
    }
    return allJobs;
}

async function fetchGoldmanSachs(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let page = 1;
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0' });
        const pageSession = await context.newPage();

        while (true) {
            const url = `https://higher.gs.com/results?LOCATION=Birmingham%7CLondon&page=${page}&sort=RELEVANCE`;
            await pageSession.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
            await pageSession.waitForTimeout(4000);
            const html = await pageSession.content();
            const $ = cheerio.load(html);
            let found = 0;
            $('a.text-decoration-none[href^="/roles/"]').each((i: number, el: any) => {
                const link = $(el).attr('href');
                const title = $(el).find('span.gs-text').first().text().trim();
                const location = $(el).find('[data-testid="location"]').first().text().replace(/·/g, ', ').replace(/\s+/g, ' ').trim();
                const department = $(el).parent().find('button.gs-tag__button').text().trim();
                if (isValidJobTitle(title) && link) {
                    allJobs.push({
                        title,
                        location: location || 'London, United Kingdom',
                        url: `https://higher.gs.com${link}`,
                        department: department || 'General',
                        salary: undefined
                    });
                    found++;
                }
            });
            if (found === 0) break;
            page++;
        }
    } catch (e) { console.error("Goldman Sachs Error:", e); } finally {
        if (browser) await browser.close();
    }
    return allJobs;
}

async function fetchGoogle(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let page = 1;
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0', viewport: { width: 1280, height: 1080 } });
        const pageSession = await context.newPage();

        while (true) {
            const url = `https://www.google.com/about/careers/applications/jobs/results?location=United%20Kingdom&page=${page}`;
            await pageSession.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
            try { await pageSession.waitForSelector('.sMn82b', { timeout: 10000 }); } catch { break; }
            await pageSession.waitForTimeout(2000);
            const html = await pageSession.content();
            const $ = cheerio.load(html);
            let found = 0;
            $('div.sMn82b').each((i: number, el: any) => {
                const title = $(el).find('h3.Qk805e').text().trim() || $(el).find('h3').text().trim();
                let location = $(el).find('span.r0wTof').text().trim() || 'United Kingdom';
                if (location.length > 5) {
                    const half = Math.floor(location.length / 2);
                    if (location.substring(0, half) === location.substring(half)) location = location.substring(0, half);
                }
                const linkStr = $(el).html()?.match(/jobs\/results\/[a-zA-Z0-9-]+/);
                if (isValidJobTitle(title) && linkStr) {
                    allJobs.push({
                        title,
                        location,
                        url: `https://www.google.com/about/careers/applications/${linkStr[0]}`,
                        department: 'General',
                        salary: undefined
                    });
                    found++;
                }
            });
            if (found === 0) break;
            page++;
        }
    } catch (e) { console.error("Google Error:", e); } finally {
        if (browser) await browser.close();
    }
    const uniqueMap = new Map();
    for (const j of allJobs) { uniqueMap.set(j.url, j); }
    return Array.from(uniqueMap.values());
}

// ─── Apple Jobs Fetcher ────────────────────────────────────────────────────────
// Uses Apple's public JSON search API filtered to GBR country code
async function fetchApple(_token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let page = 0;
    const PAGE_SIZE = 20;

    while (true) {
        try {
            const url = `https://jobs.apple.com/api/role/search?filters.countryID=GBR&page=${page}&locale=en-GB&query=`;
            const res = await fetchWithTimeout(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Referer': 'https://jobs.apple.com/en-gb/search',
                }
            }, 20000);

            if (!res.ok) break;
            const data: any = await res.json();
            const roles: any[] = data?.searchResults || [];
            if (roles.length === 0) break;

            for (const r of roles) {
                const locParts = [
                    r.homeOffice?.name,
                    r.locations?.[0]?.city,
                    r.locations?.[0]?.countryCode === 'GBR' ? 'United Kingdom' : r.locations?.[0]?.countryName,
                ].filter(Boolean);
                allJobs.push({
                    title: r.postingTitle || r.title || '',
                    location: locParts.join(', ') || 'United Kingdom',
                    url: `https://jobs.apple.com/en-gb/details/${r.positionId}`,
                    department: r.team?.teamName || '',
                    salary: undefined,
                });
            }

            // Apple API returns totalRecords — stop when we've consumed all
            const total: number = data?.totalRecords ?? 0;
            if ((page + 1) * PAGE_SIZE >= total || roles.length < PAGE_SIZE) break;
            page++;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

// ─── Meta / Facebook Jobs Fetcher ─────────────────────────────────────────────
// Scrapes metacareers.com using Playwright since it is a heavy React SPA
async function fetchMeta(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0',
            viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();

        // Use provided token as search URL if it's a full URL
        const searchUrl = token.startsWith('http') ? token : 'https://www.metacareers.com/jobs?offices[0]=London%2C%20England';
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(8000);

        // Scroll and load all results
        let prevHeight = 0;
        for (let i = 0; i < 40; i++) {
            const currHeight: number = await page.evaluate(() => document.body.scrollHeight);
            if (currHeight === prevHeight) break;
            prevHeight = currHeight;
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(2000);
        }

        const html = await page.content();
        const $ = cheerio.load(html);

        $('a').each((_, el) => {
            const anchor = $(el);
            const href = anchor.attr('href') || '';
            const card = anchor.closest('[class*="jobsearch"], [class*="job-"], article, li');
            const title = (
                anchor.find('[class*="title"], h2, h3, strong').first().text().trim() ||
                anchor.text().trim()
            );
            const locationText = card.find('[class*="location"], [class*="office"]').first().text().trim();

            if (!isValidJobTitle(title)) return;

            allJobs.push({
                title,
                location: locationText || 'London, United Kingdom',
                url: href.startsWith('http') ? href : `https://www.metacareers.com${href}`,
                department: card.find('[class*="department"], [class*="team"]').first().text().trim() || '',
                salary: undefined,
            });
        });

        await browser.close();
    } catch (e) {
        console.error('Meta scraper error:', e);
        if (browser) await browser.close();
    }

    // Deduplicate by URL
    return Array.from(new Map(allJobs.map(j => [j.url, j])).values());
}

// ─── LinkedIn Jobs Fetcher ────────────────────────────────────────────────────
// Scrapes public LinkedIn job search pages to bypass login walls
async function fetchLinkedin(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    
    // Normalize URL: convert /company/SLUG/jobs/ to /jobs/SLUG-jobs-worldwide/
    let targetUrl = token;
    if (token.includes('linkedin.com/company/')) {
        const slugMatch = token.match(/company\/([^/]+)/);
        if (slugMatch) {
            targetUrl = `https://www.linkedin.com/jobs/${slugMatch[1]}-jobs-worldwide/`;
        }
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 1000 }
        });
        const page = await context.newPage();
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Try to dismiss any sign-in modals that appear
        try {
            await page.keyboard.press('Escape');
            const closeBtn = await page.$('button[aria-label="Dismiss"]');
            if (closeBtn) await closeBtn.click();
        } catch { /* ignore */ }

        // Scroll to load more jobs
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1500);
        }

        const jobs = await page.evaluate(() => {
            const results: any[] = [];
            // Selectors for public LinkedIn job search cards
            const cards = document.querySelectorAll('.jobs-search__results-list > li, .base-search-card');
            cards.forEach(card => {
                const titleEl = card.querySelector('.base-search-card__title, .job-search-card__title');
                const locEl = card.querySelector('.job-search-card__location');
                const linkEl = card.querySelector('a.base-card__full-link, a.base-search-card__title-link');
                const deptEl = card.querySelector('.base-search-card__subtitle');

                if (titleEl && linkEl) {
                    results.push({
                        title: titleEl.textContent?.trim() || '',
                        location: locEl?.textContent?.trim() || '',
                        url: (linkEl as HTMLAnchorElement).href.split('?')[0],
                        department: deptEl?.textContent?.trim() || ''
                    });
                }
            });
            return results;
        });

        allJobs.push(...jobs);
        await browser.close();
    } catch (e) {
        console.error('LinkedIn scraper error:', e);
        if (browser) await browser.close();
    }

    return allJobs;
}

// ─── Publicis Groupe Fetcher ──────────────────────────────────────────────────
// Scrapes Publicis using Playwright to handle its Angular SPA
async function fetchPublicis(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    const targetUrl = token.startsWith('http') ? token : 'https://careers.publicisgroupe.com/jobs';
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0',
        });
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000); // Wait for Angular to load jobs

        const jobs = await page.evaluate(() => {
            const results: any[] = [];
            // Target Publicis mat-expansion-panels
            const cards = document.querySelectorAll('mat-expansion-panel, .job-card, [class*="job-item"], tr.job-row');
            cards.forEach(card => {
                const titleEl = card.querySelector('.job-title-link, .job-title, [class*="title"], h3, h4, a');
                const locEl = card.querySelector('.job-card-column-value, .job-location, [class*="location"], .office');
                const linkEl = card.querySelector('a.job-title-link, a');
                
                if (titleEl && linkEl) {
                    const title = titleEl.textContent?.trim() || '';
                    if (title) {
                        results.push({
                            title,
                            location: locEl?.textContent?.trim() || 'United Kingdom',
                            url: (linkEl as HTMLAnchorElement).href,
                            department: ''
                        });
                    }
                }
            });
            return results;
        });

        for (const j of jobs) {
            if (isValidJobTitle(j.title)) {
                allJobs.push(j);
            }
        }

        await browser.close();
    } catch (e) {
        console.error('Publicis scraper error:', e);
        if (browser) await browser.close();
    }
    return allJobs;
}

async function fetchNHS(token: string): Promise<Job[]> {
    const startUrl = token.startsWith('http') ? token : `https://www.jobs.nhs.uk/candidate/search/results?keyword=${encodeURIComponent(token)}`;
    const allJobs: Job[] = [];
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/122.0.0.0',
            viewport: { width: 1280, height: 800 },
            extraHTTPHeaders: {
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Upgrade-Insecure-Requests': '1',
            }
        });
        const page = await context.newPage();
        await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 90000 });

        // Handle cookie banner if present
        try {
            const cookieButton = await page.$('button#nhsuk-cookie-banner__link_accept_analytics');
            if (cookieButton) {
                await cookieButton.click();
                await page.waitForTimeout(2000);
            }
        } catch { /* ignore */ }

        // Scroll down to ensure jobs are loaded/visible
        await page.evaluate(() => window.scrollTo(0, 1000));
        await page.waitForTimeout(3000);

        // Wait for at least one job link to appear
        try {
            await page.waitForSelector('a[href*="/candidate/jobadvert/"]', { timeout: 15000 });
        } catch { }

        // Extract all job links
        const jobLinks = await page.$$eval('a[href*="/candidate/jobadvert/"]', links => {
            return links.map(a => ({
                title: a.textContent?.trim() || '',
                url: (a as HTMLAnchorElement).href,
                // The location and agency are usually in the same container
                containerText: a.parentElement?.parentElement?.innerText || ''
            }));
        });

        const pushJobs = (links: any[]) => {
            for (const link of links) {
                if (!link.title || !link.url) continue;
                const lines = link.containerText.split('\n').map((l: string) => l.trim()).filter(Boolean);
                const agency = lines[1] || 'NHS';
                const location = lines[2] || 'United Kingdom';
                allJobs.push({
                    title: link.title,
                    url: link.url,
                    location: location,
                    department: agency,
                    verified: true
                });
            }
        };

        pushJobs(jobLinks);

        // Pagination loop
        let pageNum = 2;
        const baseSearchUrl = startUrl.replace(/#.*$/, ''); // Strip fragment so &page= works
        while (true) {
            const nextUrl = baseSearchUrl.includes('?') ? `${baseSearchUrl}&page=${pageNum}` : `${baseSearchUrl}?page=${pageNum}`;
            await page.goto(nextUrl, { waitUntil: 'networkidle', timeout: 60000 });
            await page.evaluate(() => window.scrollTo(0, 1000));
            await page.waitForTimeout(2000);

            const pageLinks = await page.$$eval('a[href*="/candidate/jobadvert/"]', links => {
                return links.map(a => ({
                    title: a.textContent?.trim() || '',
                    url: (a as HTMLAnchorElement).href,
                    containerText: a.parentElement?.parentElement?.innerText || ''
                }));
            });

            if (pageLinks.length === 0) break;

            // Check if we are seeing the same jobs again (end of pagination)
            const firstNewJobUrl = pageLinks[0].url;
            if (allJobs.some(j => j.url === firstNewJobUrl)) break;

            pushJobs(pageLinks);
            pageNum++;

            // Optional: safety break at 500 pages (5000 jobs)
            if (pageNum > 500) break;
        }

        await browser.close();
    } catch (e: any) {
        if (browser) await browser.close();
    }
    return allJobs;
}

export const FETCHERS: Record<string, (token: string) => Promise<Job[]>> = {
    greenhouse: fetchGreenhouse,
    ashby: fetchAshby,
    lever: fetchLever,
    workable: fetchWorkable,
    teamtailor: fetchTeamtailor,
    teamtailor_html: fetchTeamtailorHtml,
    bamboohr: fetchBambooHR,
    smartrecruiters: fetchSmartRecruiters,
    pinpoint: fetchPinpoint,
    breezy: fetchBreezy,
    recruitee: fetchRecruitee,
    jobvite: fetchJobvite,
    avature: fetchAvature,
    personio: fetchPersonio,
    workday: fetchWorkday,
    oracle_cloud: fetchOracleCloud,
    wipro: fetchWipro,
    successfactors: fetchSuccessFactors,
    eightfold: fetchEightfold,
    hibob: fetchHibob,
    icims: fetchICIMS,
    rippling: fetchRippling,
    generic_careers: fetchGenericCareersPage,

    // Special / Custom Scrapers
    amazon: fetchAmazon,
    google: fetchGoogle,
    apple: fetchApple,
    meta: fetchMeta,
    nhs: fetchNHS,
    goldmansachs: fetchGoldmanSachs,
    jpmc: fetchJPMorgan,
    publicis: fetchPublicis,
    linkedin: fetchLinkedin,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const ATS_FAILURE_THRESHOLD = 3;

async function markCompanyFailure(companyId: number): Promise<void> {
    const { data: current } = await supabase
        .from('companies')
        .select('ats_failure_count')
        .eq('id', companyId)
        .single();

    const nextCount = (current?.ats_failure_count || 0) + 1;
    const nextStatus = nextCount >= ATS_FAILURE_THRESHOLD ? 'needs_manual_review' : 'dead';

    await supabase
        .from('companies')
        .update({
            ats_status: nextStatus,
            ats_failure_count: nextCount,
            ats_last_validated: new Date().toISOString(),
        })
        .eq('id', companyId);
}

export async function syncAll() {
    const startTime = Date.now();
    const syncRunId = crypto.randomUUID();
    console.log('\n════════════════════════════════════════════════════');
    console.log('  DAILY SYNC — ' + new Date().toISOString());
    console.log('════════════════════════════════════════════════════\n');

    const args = process.argv.slice(2);
    const idIndex = args.indexOf('--ids');
    const specificIds = idIndex !== -1 ? args[idIndex + 1].split(',').map(id => parseInt(id.trim())) : null;

    const providerIndex = args.indexOf('--provider');
    const targetProvider = providerIndex !== -1 ? args[providerIndex + 1].toLowerCase() : null;

    const startIndex = args.indexOf('--start-from-provider');
    const startFromProvider = startIndex !== -1 ? args[startIndex + 1].toLowerCase() : null;

    const startCompanyIndex = args.indexOf('--start-from-company');
    const startFromCompany = startCompanyIndex !== -1 ? args[startCompanyIndex + 1] : null;

    const startIdIndex = args.indexOf('--start-from-id');
    const startFromId = startIdIndex !== -1 ? parseInt(args[startIdIndex + 1]) : null;

    const fallbackOnlyDryRun = args.includes('--dry-run-custom-fallback');

    const includeLinkedin = !args.includes('--exclude-linkedin');

    if (fallbackOnlyDryRun) {
        console.log('Running in custom fallback DRY RUN mode (no DB writes)');
    }
    if (includeLinkedin) {
        console.log('LinkedIn companies are INCLUDED in this run (use --exclude-linkedin to skip)');
    } else {
        console.log('LinkedIn companies will be SKIPPED');
    }

    if (specificIds) {
        console.log(`Filtering for ${specificIds.length} specific IDs: ${specificIds.join(', ')}`);
    }

    let companies: CompanyRow[] = [];
    try {
        companies = await loadAllCompanies(specificIds);
    } catch (e: any) {
        console.error('❌ Could not load companies from DB:', e.message);
        return;
    }

    const { count: statusCount, error: statusCountError } = await supabase
        .from('companies')
        .select('*', { count: 'exact', head: true })
        .not('ats_status', 'is', null);

    if (statusCountError) {
        console.warn(`Could not determine health tracking state: ${statusCountError.message}`);
    }
    const healthTrackingEnabled = !!statusCount && statusCount > 0;
    if (!healthTrackingEnabled) {
        console.warn('Health tracking disabled - run validateAtsTokens.ts and repairBadTokens.ts first');
    }

    if (targetProvider) {
        companies = companies.filter(c => normalizeProviderName(c.ats_provider) === targetProvider || String(c.ats_provider).toLowerCase() === targetProvider);
        console.log(`Filtering for provider: ${targetProvider} (${companies.length} companies)`);
    }

    if (startFromProvider) {
        const index = companies.findIndex(c => normalizeProviderName(c.ats_provider) === startFromProvider || String(c.ats_provider).toLowerCase() === startFromProvider);
        if (index !== -1) {
            companies = companies.slice(index);
            console.log(`Starting from first ${startFromProvider} company: ${companies[0].trading_name} (${companies.length} remaining)`);
        } else {
            console.warn(`No company found with provider: ${startFromProvider}`);
        }
    }

    if (startFromCompany) {
        const index = companies.findIndex(c => String(c.trading_name || '').toLowerCase().includes(startFromCompany.toLowerCase()));
        if (index !== -1) {
            companies = companies.slice(index);
            console.log(`Resuming from company: ${companies[0].trading_name} (${companies.length} remaining)`);
        } else {
            console.warn(`No company found matching name: ${startFromCompany}`);
        }
    }

    if (startFromId) {
        const index = companies.findIndex(c => c.id === startFromId);
        if (index !== -1) {
            companies = companies.slice(index);
            console.log(`Resuming from company ID ${startFromId}: ${companies[0].trading_name} (${companies.length} remaining)`);
        } else {
            console.warn(`No company found with ID: ${startFromId}`);
        }
    }

    console.log(`Found ${companies.length} companies with configured ATS\n`);

    if (fallbackOnlyDryRun && !specificIds) {
        companies = companies.filter((company) => {
            const provider = normalizeProviderName(company.ats_provider);
            return !provider || provider === 'custom' || !FETCHERS[provider];
        });
        console.log(`Filtered to ${companies.length} custom/no-ATS companies for fallback dry run\n`);
    } else if (fallbackOnlyDryRun) {
        console.log(`Using explicit IDs for fallback dry run (${companies.length} companies)\n`);
    }

    const results: SyncResult[] = [];
    let totalSaved = 0;

    for (const company of companies) {
        const { id, trading_name, ats_provider } = company;
        let logBuffer = '';

        if (String(ats_provider || '').toLowerCase() === 'linkedin' && !includeLinkedin) {
            continue;
        }

        const resolved = resolveProviderAndToken(
            company.ats_provider,
            company.ats_board_token,
            company.careers_url ?? null
        );
        const displayProvider = (resolved?.provider || normalizeProviderName(ats_provider) || ats_provider || 'custom').toUpperCase();
        const isNHS = /\bnhs\b/i.test(trading_name);

        const result: SyncResult = {
            company: trading_name,
            provider: displayProvider.toLowerCase(),
            fetched: 0, ukJobs: 0, saved: 0, rejected: 0, needsReview: 0
        };

        try {
            const fetchOutcome = await fetchJobsWithFallback(company, { fallbackOnly: fallbackOnlyDryRun });
            const allJobs = fetchOutcome.jobs;
            result.fetched = allJobs.length;

            if (!allJobs.length) {
                console.log(`[${displayProvider.padEnd(12)}] ${trading_name.padEnd(30)} ⚪ Fetch: 0 | UK: 0 | Saved: 0`);
                results.push(result);
                continue;
            }

            const ukJobs: Job[] = [];
            let rejectedCount = 0;
            let needsReviewCount = 0;

            for (const j of allJobs) {
                const atsProvider = j.atsProvider ?? j.source ?? '';
                const adapterKey = `${atsProvider.toLowerCase()}ToJobLocationInput` as keyof typeof Adapters;
                const adapter = Adapters[adapterKey];

                const locationInput = adapter ? adapter(j) : { locations: [j.location ?? ''], isRemote: false, isTrustedSource: false };
                if (isNHS || isUKJob(locationInput)) {
                    ukJobs.push(j);
                    if (j.needs_review) needsReviewCount++;
                } else {
                    rejectedCount++;
                    globalRejectionLog.push({
                        company: trading_name,
                        provider: displayProvider,
                        title: j.title,
                        location: j.location,
                        url: j.url,
                        reason: j.rejection_reason || 'unknown'
                    });
                }
            }

            result.ukJobs = ukJobs.length;
            result.rejected = rejectedCount;
            result.needsReview = needsReviewCount;

            if (ukJobs.length > 0) {
                const dedupedJobs = new Map<string, Job>();
                for (const j of ukJobs) {
                    if (!j.url || !j.title) continue;
                    const dedupKey = `${id}_${j.title.toLowerCase().trim()}_${(j.location || '').toLowerCase().trim()}`;
                    if (!dedupedJobs.has(dedupKey) && !Array.from(dedupedJobs.values()).some(existing => existing.url === j.url)) {
                        dedupedJobs.set(dedupKey, j);
                    }
                }

                const uniqueJobs = Array.from(dedupedJobs.values());
                const rows = uniqueJobs.map(j => ({
                    company_id: id,
                    company_name: trading_name,
                    title: safeStr(j.title, 255),
                    location: safeStr(j.location, 255),
                    url: j.url,
                    department: j.department ? safeStr(j.department, 255) : null,
                    level: inferJobLevel(safeStr(j.title)),
                    updated_at: new Date().toISOString()
                }));

                if (!fallbackOnlyDryRun) {
                    const { error: jobErr } = await supabase.from('jobs').upsert(rows, { onConflict: 'url' });
                    if (jobErr) {
                    } else {
                        result.saved = rows.length;
                        totalSaved += rows.length;

                        // Cleanup stale jobs
                        const currentUrls = uniqueJobs.map(j => j.url);
                        const { data: existingJobs } = await supabase.from('jobs').select('url').eq('company_id', id);
                        if (existingJobs && existingJobs.length > 0) {
                            const staleUrls = existingJobs.map(r => r.url).filter(url => !currentUrls.includes(url));
                            if (staleUrls.length > 0) {
                                for (const chunk of chunkArray(staleUrls, 100)) {
                                    await supabase.from('jobs').delete().in('url', chunk).eq('company_id', id);
                                }
                            }
                        }
                    }
                } else {
                    result.saved = rows.length;
                    totalSaved += rows.length;
                }
            } else {
                // No UK jobs fetched
                if (!fallbackOnlyDryRun) {
                    await supabase.from('jobs').delete().eq('company_id', id);
                }
            }
            if (healthTrackingEnabled && !fallbackOnlyDryRun) {
                await supabase.from('companies').update({
                    ats_status: 'ok',
                    ats_failure_count: 0,
                    ats_last_validated: new Date().toISOString(),
                }).eq('id', id);
            }

            // Update active jobs count
            if (!fallbackOnlyDryRun) {
                const { count: finalCount } = await supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('company_id', id);
                await supabase.from('companies').update({ active_jobs_count: finalCount || 0 }).eq('id', id);
            }

            const statusEmoji = result.ukJobs > 0 ? '✅' : '⚪';
            console.log(`[${displayProvider.padEnd(12)}] ${trading_name.padEnd(30)} ${statusEmoji} Fetch: ${result.fetched.toString().padEnd(3)} | UK: ${result.ukJobs.toString().padEnd(3)} | Saved: ${result.saved.toString().padEnd(3)} | Rej: ${result.rejected.toString().padEnd(3)} | Rev: ${result.needsReview}`);

            results.push(result);
            await sleep(500); // Politeness delay
        } catch (err: any) {
            console.log(`[${displayProvider}] ${trading_name} ... ❌ ERROR: ${err.message}`);
            results.push({ ...result, error: err.message });
            if (healthTrackingEnabled && !fallbackOnlyDryRun) {
                await markCompanyFailure(id);
            }
        }
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const withJobs = results.filter(r => r.saved > 0);
    const noJobs = results.filter(r => r.saved === 0 && !r.error);
    const errored = results.filter(r => r.error);

    console.log('\n════════════════════════════════════════════════════');
    console.log('  SYNC COMPLETE');
    console.log('════════════════════════════════════════════════════');
    console.log(`  ⏱  Time:          ${elapsed}s`);
    console.log(`  🏢 Companies:      ${companies.length} processed`);
    console.log(`  ✅ With UK jobs:   ${withJobs.length}`);
    console.log(`  ➕ Jobs saved:     ${totalSaved}`);
    console.log(`  ⚪ No UK jobs:     ${noJobs.length}`);
    if (fallbackOnlyDryRun) {
        console.log('  🧪 Mode:          custom fallback dry run (no writes)');
    }
    if (SERPER_API_KEY) {
        console.log(`  🔎 Serper hits:    ${serperHitCount}/${serperCallCount}`);
    }
    if (errored.length > 0) {
        console.log(`  ❌ Errors:        ${errored.length}`);
        errored.forEach(r => console.log(`     - ${r.company}: ${r.error}`));
    }

    // Gap 9: Print Rejection Summary
    if (globalRejectionLog.length > 0) {
        const fs = await import('fs');
        const path = await import('path');
        const logPath = path.resolve(process.cwd(), 'rejection_log.json');
        fs.writeFileSync(logPath, JSON.stringify(globalRejectionLog, null, 2));

        console.log(`\n  📝 Rejection Log saved to ${logPath}`);
        console.log(`  Total rejected: ${globalRejectionLog.length}`);

        // Count top rejection reasons
        const reasons: Record<string, number> = {};
        for (const log of globalRejectionLog) {
            reasons[log.reason] = (reasons[log.reason] || 0) + 1;
        }
        console.log('  Top rejection reasons:');
        Object.entries(reasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .forEach(([reason, count]) => {
                console.log(`     - ${reason}: ${count}`);
            });
    }
    console.log('');

    if (withJobs.length > 0) {
        console.log('  Top results:');
        withJobs
            .sort((a, b) => b.saved - a.saved)
            .slice(0, 10)
            .forEach(r => console.log(`     ${r.company.padEnd(35)} ${r.saved} jobs  [${r.provider}]`));
    }
    console.log('════════════════════════════════════════════════════\n');
}

const isDirectExecution = process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;

if (isDirectExecution) {
    syncAll().catch(console.error);
}
