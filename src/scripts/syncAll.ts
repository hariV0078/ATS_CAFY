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
 *   personio, hibob, custom_scraper, custom_nhs
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
import crypto from 'crypto';
import { chromium } from 'playwright';
import { inferJobLevel } from '../lib/inferJobLevel';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
}

type LocationDecision = {
    isUK: boolean;
    reason: string;
};

interface SyncResult {
    company: string;
    provider: string;
    fetched: number;
    ukJobs: number;
    saved: number;
    error?: string;
}

interface CompanyRow {
    id: number;
    trading_name: string;
    ats_provider: string;
    ats_board_token: string;
    careers_url?: string | null;
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
    const maxAttempts = 2;
    const retryDelayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);

            const transientStatus = response.status === 429 || response.status >= 500;
            if (transientStatus && attempt < maxAttempts) {
                await sleep(retryDelayMs);
                continue;
            }

            return response;
        } catch (error: any) {
            clearTimeout(id);
            const transientNetworkError =
                error?.name === 'AbortError' ||
                error?.name === 'TypeError';

            if (transientNetworkError && attempt < maxAttempts) {
                await sleep(retryDelayMs);
                continue;
            }
            throw error;
        }
    }

    throw new Error('Unexpected fetch retry failure state');
}

const UK_COUNTRIES = ["uk", "united kingdom", "gb", "gbr", "gbi", "gbre", "great britain"];
const UK_NATIONS = ["england", "scotland", "wales", "northern ireland"];
const UK_CITIES = [
    "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh",
    "bristol", "liverpool", "nottingham", "sheffield", "cardiff", "belfast",
    "newcastle", "cambridge", "oxford", "reading", "brighton", "southampton",
    "coventry", "leicester", "york", "bath", "milton keynes", "derby",
    "portsmouth", "exeter", "plymouth", "aberdeen", "dundee", "stoke",
    "luton", "swindon", "warrington", "bolton", "rochdale", "sunderland"
];

const NON_UK_LOCATION_PHRASES = [
    "united states", "usa", "u.s.", "us", "canada", "india", "australia", "new zealand",
    "new york", "new jersey", "san francisco", "los angeles", "seattle", "chicago", "boston",
    "singapore", "hong kong", "tokyo", "sydney", "melbourne", "berlin", "munich", "paris",
    "amsterdam", "madrid", "barcelona", "dublin", "toronto", "vancouver"
];

const UK_URL_HINTS = [
    "/uk/", "united-kingdom", "country=gb", "country=uk", "location=uk", "locale=en-gb",
    "city=london", "city=manchester", "city=birmingham", "city=leeds", "city=bristol", "city=liverpool",
    "city=edinburgh", "city=glasgow", "city=cardiff", "city=belfast"
];

const NON_UK_URL_HINTS = [
    "country=us", "country=usa", "country=ca", "country=au", "country=sg", "country=in",
    "location=united-states", "location=usa", "location=us",
    "city=new-york", "city=san-francisco", "city=seattle", "city=toronto", "city=singapore"
];

function normalizeLocation(str: string): string {
    return String(str || '')
        .toLowerCase()
        .replace(/[()]/g, '')
        .replace(/[\/\-_|,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Parse multi-location strings like "London / New York / Singapore" into individual locations
function parseMultiLocationString(location: string): string[] {
    if (!location) return [];
    // Split by delimiters that separate distinct locations while preserving phrases like "New York"
    return location
        .split(/\s*(?:\/|\||;|&|\s+and\s+|\s+or\s+)\s*/i)
        .map(loc => loc.trim())
        .filter(loc => loc.length > 0);
}

// Check if ANY location in a multi-location string is UK
function isAnyLocationUK(location: string): boolean {
    const locations = parseMultiLocationString(location);
    for (const loc of locations) {
        if (isUKLocation(loc)) {
            return true;
        }
    }
    return false;
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

    // STRICT BLOCKLIST: Canadian/US/non-UK false positives
    // "London, ON" → reject (Ontario)
    // "New York" → reject (standalone)
    // "Dublin, CA" → reject (California)
    const strictBlockList = [
        { phrase: "london on", reason: "london_ontario" },
        { phrase: "london ontario", reason: "london_ontario" },
        { phrase: "london canada", reason: "london_canada" },
        { phrase: "dublin ca", reason: "dublin_california" },
        { phrase: "york pa", reason: "york_pennsylvania" },
        { phrase: "york pennsylvania", reason: "york_pennsylvania" },
        { phrase: "bristol va", reason: "bristol_virginia" },
        { phrase: "bristol virginia", reason: "bristol_virginia" },
        { phrase: "bath me", reason: "bath_maine" },
        { phrase: "cambridge ma", reason: "cambridge_massachusetts" },
        { phrase: "cambridge massachusetts", reason: "cambridge_massachusetts" },
        { phrase: "richmond va", reason: "richmond_virginia" },
        { phrase: "oxford ms", reason: "oxford_mississippi" },
        { phrase: "new york", reason: "new_york_state" },
        { phrase: "new jersey", reason: "new_jersey_state" },
        { phrase: "new hampshire", reason: "new_hampshire_state" },
        { phrase: "new mexico", reason: "new_mexico_state" },
        { phrase: "united states", reason: "explicit_usa" },
        { phrase: "usa", reason: "explicit_usa" },
        { phrase: "u.s.", reason: "explicit_usa" },
        { phrase: "canada", reason: "explicit_canada" },
        { phrase: "india", reason: "explicit_india" },
        { phrase: "australia", reason: "explicit_australia" },
        { phrase: "singapore", reason: "explicit_singapore" },
        { phrase: "hong kong", reason: "explicit_hong_kong" },
        { phrase: "berlin", reason: "explicit_berlin" },
        { phrase: "paris", reason: "explicit_paris" },
        { phrase: "amsterdam", reason: "explicit_amsterdam" },
        { phrase: "dublin", reason: "explicit_dublin_ireland" },
        { phrase: "ukraine", reason: "explicit_ukraine" },
    ];
    
    for (const block of strictBlockList) {
        // Special case: "ireland" alone should block, but "northern ireland" should pass
        if (block.phrase === "ireland" && normalized.includes('northern ireland')) {
            continue;
        }
        // Use word boundaries for single words to avoid "York" matching "New York"
        const pattern = block.phrase.includes(' ')
            ? block.phrase // phrase: use exact substring match
            : `\\b${block.phrase}\\b`; // single word: word boundary
        if (new RegExp(pattern, 'i').test(normalized)) {
            return false;
        }
    }

    // Also block standalone "us" or 2-letter state codes if they are distinct words
    if (/\b(us|ny|nj|ca|tx|ma|il|wa|fl)\b/.test(normalized)) {
        return false;
    }

    if (normalized.includes("remote") && (normalized.includes("uk") || normalized.includes("united kingdom"))) {
        return true;
    }

    const tokens = normalized.split(/\s+/);
    for (const token of tokens) {
        if (UK_COUNTRIES.includes(token) || UK_NATIONS.includes(token) || UK_CITIES.includes(token)) {
            return true;
        }
    }

    // Word-boundary match for "england" to avoid false positives like "New England"
    if (/\bengland\b/i.test(normalized)) {
        return true;
    }

    // Multi-word exact phrase match fallback
    const multiWords = [...UK_COUNTRIES, ...UK_NATIONS, ...UK_CITIES].filter(w => w.includes(' '));
    for (const phrase of multiWords) {
        if (normalized.includes(phrase)) {
            return true;
        }
    }

    return false;
}

function hasAnyHint(text: string, hints: string[]): boolean {
    return hints.some((hint) => text.includes(hint));
}

// Audit log for job filtering decisions
const jobFilterAudit: Array<{ title: string; location: string; reason: string }> = [];

function evaluateUKLocationDecision(job: Job): LocationDecision {
    const locationRaw = job.location || '';
    const locationNorm = normalizeLocation(locationRaw);
    const titleNorm = normalizeLocation(job.title || '');
    const urlNorm = String(job.url || '').toLowerCase();
    const combinedNorm = `${locationNorm} ${titleNorm}`.trim();

    let rejectReason: string | null = null;

    // PRIMARY DECISION: if any explicit location segment is UK, keep it.
    // Example: "London / New York / Singapore" should pass.
    if (isAnyLocationUK(locationRaw)) {
        return { isUK: true, reason: 'passed_location_segment' };
    }

    // HARD BLOCK 1: Explicit non-UK phrases in combined location+title
    const hasNonUkPhrase = NON_UK_LOCATION_PHRASES.some((p) => combinedNorm.includes(p));
    if (hasNonUkPhrase && !combinedNorm.includes('northern ireland')) {
        rejectReason = `explicit_non_uk_phrase`;
        jobFilterAudit.push({ title: job.title, location: locationRaw, reason: rejectReason });
        return { isUK: false, reason: rejectReason };
    }

    // HARD BLOCK 2: Non-UK URL hints
    if (hasAnyHint(urlNorm, NON_UK_URL_HINTS)) {
        rejectReason = `non_uk_url_hint`;
        jobFilterAudit.push({ title: job.title, location: locationRaw, reason: rejectReason });
        return { isUK: false, reason: rejectReason };
    }

    // SECONDARY SIGNALS: Title or URL contains UK indicator
    if (/\b(uk|united kingdom|england|scotland|wales|northern ireland)\b/i.test(`${titleNorm} ${urlNorm}`)) {
        return { isUK: true, reason: 'passed_uk_signal' };
    }
    if (hasAnyHint(urlNorm, UK_URL_HINTS)) {
        return { isUK: true, reason: 'passed_uk_url_hint' };
    }

    // FALLBACK: Known UK city mention in title or URL
    const ukCityRegex = /\b(london|manchester|birmingham|leeds|bristol|liverpool|edinburgh|glasgow|cardiff|belfast|newcastle|cambridge|oxford)\b/i;
    if (ukCityRegex.test(`${titleNorm} ${urlNorm}`)) {
        return { isUK: true, reason: 'passed_uk_city_signal' };
    }

    // NO UK SIGNALS FOUND
    rejectReason = `no_uk_signals`;
    jobFilterAudit.push({ title: job.title, location: locationRaw, reason: rejectReason });
    return { isUK: false, reason: rejectReason };
}

function isLikelyUKJob(job: Job): boolean {
    return evaluateUKLocationDecision(job).isUK;
}

function safeStr(s: any, maxLen = 500): string {
    return String(s || '').slice(0, maxLen);
}

function normalizeProviderName(value: string | null | undefined): string | null {
    if (!value) return null;
    return String(value).trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeCareersUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
}

const NHS_JOBS_SEARCH_URL = 'https://www.jobs.nhs.uk/candidate/search/results?workingPattern=full-time&contractType=Permanent&payRange=30-40%2C40-50%2C50-60%2C60-70%2C70-80%2C80-90%2C90-100%2C100&language=en';

function normalizeNhsSearchUrl(token: string | null | undefined): string {
    const raw = String(token || '').trim();
    if (!raw) return NHS_JOBS_SEARCH_URL;

    if (!/^https?:\/\//i.test(raw)) {
        return NHS_JOBS_SEARCH_URL;
    }

    try {
        const parsed = new URL(raw);
        if (!parsed.hostname.includes('jobs.nhs.uk')) {
            return NHS_JOBS_SEARCH_URL;
        }

        if (!parsed.pathname.includes('/candidate/search/results')) {
            return NHS_JOBS_SEARCH_URL;
        }

        parsed.hash = '';
        parsed.searchParams.delete('page');
        if (!parsed.searchParams.has('workingPattern')) parsed.searchParams.set('workingPattern', 'full-time');
        if (!parsed.searchParams.has('contractType')) parsed.searchParams.set('contractType', 'Permanent');
        if (!parsed.searchParams.has('payRange')) parsed.searchParams.set('payRange', '30-40,40-50,50-60,60-70,70-80,80-90,90-100,100');
        if (!parsed.searchParams.has('language')) parsed.searchParams.set('language', 'en');
        return parsed.toString();
    } catch {
        return NHS_JOBS_SEARCH_URL;
    }
}

function getNhsPageUrl(baseUrl: string, pageNumber: number): string {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set('page', String(pageNumber));
    return pageUrl.toString();
}

function parseNhsTotalPages(html: string): number | null {
    const match = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
    if (!match?.[1]) return null;

    const total = parseInt(match[1], 10);
    return Number.isFinite(total) && total > 0 ? total : null;
}

async function fetchNhsJobsPage(pageUrl: string): Promise<{ jobs: Job[]; totalPages: number | null }> {
    try {
        const res = await fetchWithTimeout(pageUrl, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml',
                'User-Agent': 'Mozilla/5.0',
            },
        }, 20000);

        if (!res.ok) return { jobs: [], totalPages: null };

        const html = await res.text();
        const $ = cheerio.load(html);
        const jobs: Job[] = [];

        $('.search-result').each((_, el) => {
            const card = $(el);
            const titleEl = card.find('a').first();
            if (!titleEl.length) return;

            const title = titleEl.text().replace(/\s+/g, ' ').trim();
            const href = String(titleEl.attr('href') || '').trim();
            if (!title || !href) return;

            let jobUrl = href;
            try {
                const absolute = new URL(href, 'https://www.jobs.nhs.uk');
                absolute.hash = '';
                absolute.search = '';
                jobUrl = absolute.toString();
            } catch {
                jobUrl = href.startsWith('/') ? `https://www.jobs.nhs.uk${href.split('?')[0]}` : href.split('?')[0];
            }

            const rawLocation = card.find('[data-test="search-result-location"]').text().trim() ||
                card.find('.search-result-location').text().trim() ||
                card.find('li:contains("Location")').text().replace('Location:', '').trim() ||
                'United Kingdom';

            const location = rawLocation.replace(/\n+/g, ', ').replace(/\s{2,}/g, ' ').trim();

            jobs.push({
                title,
                location,
                url: jobUrl,
                department: '',
                salary: undefined,
            });
        });

        const totalPages = parseNhsTotalPages(html);
        const dedupedJobs = Array.from(new Map(jobs.map((job) => [job.url, job])).values());

        return { jobs: dedupedJobs, totalPages };
    } catch {
        return { jobs: [], totalPages: null };
    }
}

async function fetchNHS(token: string): Promise<Job[]> {
    const baseUrl = normalizeNhsSearchUrl(token);
    const firstPageUrl = getNhsPageUrl(baseUrl, 1);
    const firstPage = await fetchNhsJobsPage(firstPageUrl);
    const allJobs = [...firstPage.jobs];

    const totalPages = firstPage.totalPages || 1;
    const concurrency = 8;

    for (let page = 2; page <= totalPages; page += concurrency) {
        const batch: Promise<{ jobs: Job[]; totalPages: number | null }>[] = [];

        for (let offset = 0; offset < concurrency && page + offset <= totalPages; offset++) {
            batch.push(fetchNhsJobsPage(getNhsPageUrl(baseUrl, page + offset)));
        }

        const results = await Promise.all(batch);
        for (const result of results) {
            allJobs.push(...result.jobs);
        }

        await sleep(250);
    }

    return Array.from(new Map(allJobs.filter((job) => job.title && job.url).map((job) => [job.url, job])).values());
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
            const token = parts[0] || host.split('.')[0] || '';
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
            const site = parts[0] || '';
            const token = site ? `${parsed.protocol}//${parsed.host}/${site}` : '';
            return token ? { provider: 'workday', token } : null;
        }
        if (host.includes('jobs.nhs.uk') || host === 'nhs.uk' || host.endsWith('.nhs.uk')) {
            return { provider: 'custom_nhs', token: normalizedUrl };
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
                if (!href || !title || title.length < 3) return;

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
    const primaryProvider = normalizeProviderName(company.ats_provider) || company.ats_provider;
    const primaryToken = String(company.ats_board_token || '').trim();
    const fallbackPlan = inferAtsFromCareersUrl(company.careers_url);

    const attempts: FetchAttempt[] = [];
    const fallbackOnly = !!options?.fallbackOnly;

    if (!fallbackOnly && primaryProvider && FETCHERS[primaryProvider] && primaryToken) {
        attempts.push({ provider: primaryProvider, token: primaryToken, source: 'primary' });
    }

    if (fallbackPlan && FETCHERS[fallbackPlan.provider]) {
        const alreadyPrimary =
            primaryProvider === fallbackPlan.provider &&
            primaryToken === fallbackPlan.token;

        if (!alreadyPrimary) {
            attempts.push({ provider: fallbackPlan.provider, token: fallbackPlan.token, source: 'fallback' });
        }
    }

    if (attempts.length === 0) {
        return {
            jobs: [],
            provider: primaryProvider || '',
            token: primaryToken,
            source: 'primary',
            fallbackUsed: false,
        };
    }

    const errors: string[] = [];
    for (const attempt of attempts) {
        const fetcher = FETCHERS[attempt.provider];
        if (!fetcher) continue;

        try {
            const jobs = await fetcher(attempt.token);
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
            const jobs = await fetcher(inferred.token);
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
    if (specificIds && specificIds.length > 0) {
        const { data, error } = await supabase
            .from('companies')
            .select('id, trading_name, ats_provider, ats_board_token')
            .in('id', specificIds)
            .order('trading_name');

        if (error) {
            throw new Error(`Could not load filtered companies: ${error.message}`);
        }

        const companies = (data || []) as CompanyRow[];
        const overrides = await loadAtsOverrides(companies.map(c => c.id));

        return companies.map(company => {
            const override = overrides.get(company.id);
            if (!override) return company;

            return {
                ...company,
                ats_provider: normalizeProviderName(override.sync_provider || override.provider_raw) || company.ats_provider,
                ats_board_token: override.board_token_raw?.trim() || company.ats_board_token,
                careers_url: normalizeCareersUrl(override.careers_url_raw),
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
            .select('id, trading_name, ats_provider, ats_board_token')
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
        if (!override) return company;

        return {
            ...company,
            ats_provider: normalizeProviderName(override.sync_provider || override.provider_raw) || company.ats_provider,
            ats_board_token: override.board_token_raw?.trim() || company.ats_board_token,
            careers_url: normalizeCareersUrl(override.careers_url_raw),
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
            const jobs: Job[] = (d.jobs || []).map((j: any) => ({
                title: j.title || '',
                location: j.location?.name || '',
                url: j.absolute_url || j.url || '',
                department: j.departments?.[0]?.name || '',
                salary: undefined
            }));
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
            return {
                title: j.title || '',
                location: `${locRaw} ${secLocs}`.trim(),
                url: j.jobUrl || '',
                department: j.department || '',
                salary: undefined
            };
        });
    } catch { return []; }
}

async function fetchLever(token: string): Promise<Job[]> {
    // Try EU lever first (easol etc uses eu subdomain)
    for (const base of ['https://api.eu.lever.co/v0/postings', 'https://api.lever.co/v0/postings']) {
        try {
            const r = await fetchWithTimeout(`${base}/${token}`);
            console.log(`[DEBUG] Lever ${token} ${base} status: ${r.status}`);
            if (r.ok) {
                const d = await r.json();
                if (Array.isArray(d) && d.length > 0) {
                    return d.map((j: any) => ({
                        title: j.text || '',
                        location: j.categories?.location || j.workplaceType || '',
                        url: j.hostedUrl || '',
                        department: j.categories?.department || j.categories?.team || '',
                        salary: undefined
                    }));
                }
            }
        } catch (e: any) {
            console.log(`[DEBUG] Lever error: ${e.message}`);
        }
    }
    return [];
}

async function fetchWorkable(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let nextToken = '';
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    while (true) {
        try {
            const body: any = { query: '', location: [], department: [], worktype: [], remote: [] };
            if (nextToken) body.next = nextToken;

            const r = await fetchWithTimeout(`https://apply.workable.com/api/v3/accounts/${token}/jobs`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'User-Agent': ua,
                    'Referer': `https://apply.workable.com/${token}/`
                },
                body: JSON.stringify(body)
            });
            if (!r.ok) break;
            const d = await r.json();
            const results = d.results || [];
            if (results.length === 0) break;

            allJobs.push(...results.map((j: any) => ({
                title: j.title || '',
                location: j.location?.city ? `${j.location.city}, ${j.location.country || ''}` : (j.location?.country || j.country || ''),
                url: `https://apply.workable.com/${token}/j/${j.shortcode}/`,
                department: Array.isArray(j.department) ? j.department[0] : (j.department || ''),
                salary: undefined
            })));

            nextToken = d.nextPage;
            if (!nextToken) break;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

async function fetchTeamtailor(token: string): Promise<Job[]> {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
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
                location: item.find('description').text().split('·')[1]?.trim() || 'UK',
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
                location: `${j.location?.city || ''} ${j.location?.state || ''}`.trim(),
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
            if (!href || !title) return;

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
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
            .filter((j: any) => j.title && j.url)
            .map((j: any) => ({
                title: j.title,
                location: j.location || 'UK',
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
        // Personio XML endpoint — most reliable public endpoint
        const r = await fetchWithTimeout(`https://${token}.jobs.personio.de/xml?language=en`);
        if (!r.ok) return [];
        const xml = await r.text();
        // Simple XML parse without a library — extract <position> blocks
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
    const parts = token.split('/');
    if (parts.length < 2) return [];
    const slug = parts[0];
    const board = parts.slice(1).join('/');

    // Wells Fargo uses myworkdaysite.com. Willis Re uses standard myworkdayjobs.com.
    const isWorkdaySite = slug === 'wf' || slug.includes('hcahealthcare');

    for (const wd of ['wd3', 'wd1', 'wd5', 'wd103', 'wd107', 'wd108', 'wd12', 'wd2']) {
        // Try both slug.wd.domain and wd.domain
        const domains = isWorkdaySite
            ? [`${slug}.${wd}.myworkdaysite.com`, `${wd}.myworkdaysite.com`]
            : [`${slug}.${wd}.myworkdayjobs.com`, `${wd}.myworkdayjobs.com`];

        for (const domain of domains) {
            const apiUrl = `https://${domain}/wday/cxs/${slug}/${board}/jobs`;
            const publicBase = `https://${domain}/en-US/${board}`;

            try {
                let res = await fetchWithTimeout(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                    body: JSON.stringify({
                        appliedFacets: { locationCountry: ['29247e57dbaf46fb855b224e03170bc7'] },
                        limit: 20, offset: 0, searchText: ''
                    })
                });

                if (!res.ok) {
                    // Try alternate location facet
                    res = await fetchWithTimeout(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                        body: JSON.stringify({
                            appliedFacets: { Location_Country: ['29247e57dbaf46fb855b224e03170bc7'] },
                            limit: 20, offset: 0, searchText: ''
                        })
                    });
                }

                if (!res.ok) {
                    // Fallback: no facets
                    res = await fetchWithTimeout(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' })
                    });
                }

                if (!res.ok) {
                    continue;
                }

                const data = await res.json();
                const posts = data?.jobPostings || [];

                if (posts.length === 0) {
                    if (isWorkdaySite) break;
                    continue;
                }

                const allJobs: Job[] = [];
                let offset = 0;
                const total = data.total || 0;

                while (offset < total || offset === 0) {
                    let currentPosts = posts;
                    if (offset > 0) {
                        const nextRes = await fetchWithTimeout(apiUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': publicBase },
                            body: JSON.stringify({
                                appliedFacets: data.appliedFacets || {},
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
                        location: j.locationsText || '',
                        url: `${publicBase}${j.externalPath}`,
                        department: '',
                        salary: undefined
                    })));

                    offset += 20;
                    await sleep(300);
                }
                return allJobs;
            } catch {
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
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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
                    location: (j.jobLocationShort && j.jobLocationShort[0]) || "UK",
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
                        location: location.split('\n')[0].trim() || 'UK',
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
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });

            if (!res.ok) break;
            const d = await res.json();
            const positions = d.data?.positions || [];
            if (positions.length === 0) break;

            allJobs.push(...positions.map((p: any) => ({
                title: p.name || '',
                location: p.locations?.[0] || p.standardizedLocations?.[0] || 'UK',
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
                location: j.location || j.JobLocation || 'UK',
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
                    location: locParts.join(', ') || 'UK',
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
    while (offset < total) {
        const url = `https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&finder=findReqs;siteNumber=CX_1001,facetsList=LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS,limit=25,locationId=300000000289276,offset=${offset},sortBy=POSTING_DATES_DESC`;
        try {
            const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) break;
            const data: any = await res.json();
            if (!data.items || data.items.length === 0) break;
            const pageData = data.items[0];
            total = pageData.TotalJobsCount;
            if (pageData.requisitionList) {
                for (const job of pageData.requisitionList) {
                    allJobs.push({
                        title: job.Title || '',
                        location: job.PrimaryLocation || 'UK',
                        url: `https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/${job.Id}`,
                        department: '',
                        salary: undefined
                    });
                }
            } else { break; }
            offset += 25;
            await sleep(500);
        } catch { break; }
    }
    return allJobs;
}

async function fetchGoldmanSachs(token: string): Promise<Job[]> {
    const allJobs: Job[] = [];
    let page = 1;
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
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
                if (title && link) {
                    allJobs.push({
                        title,
                        location: location || 'UK',
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
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', viewport: { width: 1280, height: 1080 } });
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
                if (title && linkStr) {
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

export const FETCHERS: Record<string, (token: string) => Promise<Job[]>> = {
    greenhouse: fetchGreenhouse,
    ashby: fetchAshby,
    lever: fetchLever,
    workable: fetchWorkable,
    teamtailor: fetchTeamtailor,
    bamboohr: fetchBambooHR,
    smartrecruiters: fetchSmartRecruiters,
    pinpoint: fetchPinpoint,
    breezy: fetchBreezy,
    recruitee: fetchRecruitee,
    personio: fetchPersonio,
    workday: fetchWorkday,
    workday_enterprise: fetchWorkday,
    oracle_cloud: fetchOracleCloud,
    successfactors: fetchSuccessFactors,
    eightfold: fetchEightfold,
    hibob: fetchHibob,
    wipro: fetchWipro,
    icims: fetchICIMS,
    breezyhr: fetchBreezy,
    rippling: fetchRippling,
    amazon: fetchAmazon,
    goldmansachs: fetchGoldmanSachs,
    google: fetchGoogle,
    jpmc: fetchJPMorgan,
    jobvite: fetchJobvite,
    avature: fetchAvature,
    teamtailor_html: fetchTeamtailorHtml,
    custom_nhs: fetchNHS,
    nhs_jobs: fetchNHS,
    generic_careers: fetchGenericCareersPage,
};

// Providers that return UK-only results natively (no keyword filter needed)
// Removed for safety - always applying keyword filter
// const UK_NATIVE_PROVIDERS = new Set(['workday']);

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
    const fallbackOnlyDryRun = args.includes('--dry-run-custom-fallback');

    if (fallbackOnlyDryRun) {
        console.log('Running in custom fallback DRY RUN mode (no DB writes)');
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
    let locationLogEnabled = true;

    for (const company of companies) {
        const { id, trading_name, ats_provider } = company;

        if (!fallbackOnlyDryRun && !ats_provider) {
            console.log(`[UNCONFIGURED] ${trading_name} — no ATS provider assigned`);
            if (healthTrackingEnabled) {
                await supabase
                    .from('companies')
                    .update({
                        ats_status: 'needs_manual_review',
                        ats_last_validated: new Date().toISOString(),
                    })
                    .eq('id', id);
            }
            continue;
        }

        const primaryProvider = normalizeProviderName(ats_provider) || ats_provider || 'custom';
        process.stdout.write(`[${primaryProvider.toUpperCase()}] ${trading_name} ... `);

        const result: SyncResult = {
            company: trading_name,
            provider: primaryProvider,
            fetched: 0, ukJobs: 0, saved: 0
        };

        try {
            const fetchOutcome = await fetchJobsWithFallback(company, { fallbackOnly: fallbackOnlyDryRun });
            if (!fetchOutcome.jobs.length) {
                console.log(`0 jobs fetched from primary + fallback sources`);
                if (!fallbackOnlyDryRun && healthTrackingEnabled) {
                    await supabase
                        .from('companies')
                        .update({
                            ats_status: 'dead',
                            ats_last_validated: new Date().toISOString(),
                        })
                        .eq('id', id);
                }
                continue;
            }

            if (fetchOutcome.source === 'fallback') {
                console.log(`  [FALLBACK] used ${fetchOutcome.provider} from audit URL`);
                result.provider = fetchOutcome.provider;
            } else if (fetchOutcome.source === 'serper') {
                console.log(`  [FALLBACK] used ${fetchOutcome.provider} from Serper discovery`);
                result.provider = fetchOutcome.provider;
            }

            const allJobs = fetchOutcome.jobs;
            result.fetched = allJobs.length;

            // Apply UK keyword filter to all fetched jobs for safety
            const ukJobs: Job[] = [];
            const locationLogRows: Array<{
                company_id: number;
                job_url: string;
                raw_location: string;
                source: string;
                decision: string;
                sync_run_id: string;
            }> = [];

            for (const j of allJobs) {
                const decision = evaluateUKLocationDecision(j);
                if (decision.isUK) {
                    ukJobs.push(j);
                }

                locationLogRows.push({
                    company_id: id,
                    job_url: safeStr(j.url),
                    raw_location: safeStr(j.location),
                    source: safeStr(fetchOutcome.provider, 100),
                    decision: safeStr(decision.reason, 100),
                    sync_run_id: syncRunId,
                });
            }

            if (!fallbackOnlyDryRun && locationLogEnabled && locationLogRows.length > 0) {
                const chunks = chunkArray(locationLogRows, 500);
                for (const chunk of chunks) {
                    const { error: logErr } = await supabase
                        .from('location_filter_log')
                        .insert(chunk);
                    if (logErr) {
                        console.warn(`  [WARN] location_filter_log insert disabled: ${logErr.message}`);
                        locationLogEnabled = false;
                        break;
                    }
                }
            }

            if (ukJobs.length === 0 && allJobs.length > 0) {
                console.log(`  [DIAGNOSIS] No UK matches. Sample jobs: ${allJobs.slice(0, 3).map(x => `${x.title} @ ${x.location}`).join(' | ')}`);
            }

            result.ukJobs = ukJobs.length;
            console.log(`${allJobs.length} total → ${ukJobs.length} UK`);

            if (ukJobs.length > 0) {
                // Deduplicate by URL to avoid "ON CONFLICT" errors in Postgres upsert
                const uniqueJobs = Array.from(new Map(ukJobs.map(j => [j.url, j])).values());

                const rows = uniqueJobs
                    .filter(j => j.url && j.title)
                    .map(j => ({
                        company_id: id,
                        title: safeStr(j.title),
                        location: safeStr(j.location),
                        url: safeStr(j.url),
                        department: j.department ? safeStr(j.department) : null,
                        level: inferJobLevel(safeStr(j.title)),
                        last_seen_at: new Date().toISOString()
                    }));

                if (fallbackOnlyDryRun) {
                    result.saved = rows.length;
                    totalSaved += rows.length;
                    console.log(`  [DRY RUN] would upsert ${rows.length} UK jobs`);
                } else {
                    const { error: jobErr } = await supabase
                        .from('jobs')
                        .upsert(rows, { onConflict: 'url' });

                    if (jobErr) {
                        result.error = jobErr.message;
                        console.error(`  ❌ ${jobErr.message}`);
                        if (healthTrackingEnabled) {
                            await markCompanyFailure(id);
                        }
                    } else {
                        result.saved = rows.length;
                        totalSaved += rows.length;

                        // ─── Cleanup: Mark stale jobs (resilient to ATS downtime) ───
                        // Seen jobs get last_seen_at refreshed by upsert above.
                        // Delete only jobs not seen in 48+ hours (handles transient ATS downtime).
                        // This allows recovery if ATS API is temporarily down
                        const graceWindow = new Date();
                        graceWindow.setHours(graceWindow.getHours() - 48);
                        
                        const { error: delErr, count: delCount } = await supabase
                            .from('jobs')
                            .delete()
                            .eq('company_id', id)
                            .lt('last_seen_at', graceWindow.toISOString());

                        if (delErr) {
                            console.error(`  ⚠️ Cleanup error (delete old stale): ${delErr.message}`);
                        } else if (delCount && delCount > 0) {
                            console.log(`  🧹 Cleaned up ${delCount} jobs not seen in 48+ hours`);
                        }

                        if (healthTrackingEnabled) {
                            await supabase
                                .from('companies')
                                .update({
                                    ats_status: 'ok',
                                    ats_failure_count: 0,
                                    ats_last_validated: new Date().toISOString(),
                                })
                                .eq('id', id);
                        }
                    }
                }
            } else {
                // If no UK jobs were found, do not refresh last_seen_at; only prune rows older than grace window.
                console.log(`0 total → 0 UK. Applying 48h stale-job prune...`);
                if (!fallbackOnlyDryRun) {
                    const graceWindow = new Date();
                    graceWindow.setHours(graceWindow.getHours() - 48);

                    const { error: delErr, count: delCount } = await supabase
                        .from('jobs')
                        .delete()
                        .eq('company_id', id)
                        .lt('last_seen_at', graceWindow.toISOString());

                    if (delErr) {
                        console.error(`  ⚠️ Clear error: ${delErr.message}`);
                    } else if (delCount && delCount > 0) {
                        console.log(`  🧹 Removed ${delCount} jobs stale for 48+ hours`);
                    }
                } else {
                    console.log('  [DRY RUN] no UK jobs; would clear only jobs stale for 48h+');
                }

                if (!fallbackOnlyDryRun && healthTrackingEnabled) {
                    await supabase
                        .from('companies')
                        .update({
                            ats_status: 'ok',
                            ats_failure_count: 0,
                            ats_last_validated: new Date().toISOString(),
                        })
                        .eq('id', id);
                }
            }

            // Calculate exact active jobs count directly from DB
            if (!fallbackOnlyDryRun) {
                const { count: finalCount } = await supabase
                    .from('jobs')
                    .select('*', { count: 'exact', head: true })
                    .eq('company_id', id);

                await supabase
                    .from('companies')
                    .update({ active_jobs_count: finalCount || 0 })
                    .eq('id', id);
            }

        } catch (e: any) {
            result.error = e.message;
            console.error(`  ❌ ${e.message}`);

            if (healthTrackingEnabled) {
                await markCompanyFailure(id);
            }
        }

        results.push(result);
        await sleep(400); // be polite to APIs
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
    console.log('');

    if (withJobs.length > 0) {
        console.log('  Top results:');
        withJobs
            .sort((a, b) => b.saved - a.saved)
            .slice(0, 10)
            .forEach(r => console.log(`     ${r.company.padEnd(35)} ${r.saved} jobs  [${r.provider}]`));
    }
    console.log('════════════════════════════════════════════════════');

    // Job filter audit log
    if (jobFilterAudit.length > 0) {
        console.log('\n📋 LOCATION FILTER AUDIT (Blocked Jobs):');
        const auditByReason = jobFilterAudit.reduce((acc, entry) => {
            if (!acc[entry.reason]) acc[entry.reason] = [];
            acc[entry.reason].push(entry);
            return acc;
        }, {} as Record<string, Array<{ title: string; location: string; reason: string }>>);

        Object.entries(auditByReason).forEach(([reason, entries]) => {
            console.log(`\n  ${reason} (${entries.length}):`);
            entries.slice(0, 5).forEach(e => {
                console.log(`    - "${e.title}" @ "${e.location}"`);
            });
            if (entries.length > 5) {
                console.log(`    ... and ${entries.length - 5} more`);
            }
        });
        console.log('');
    }
    console.log('════════════════════════════════════════════════════\n');
}

const isDirectExecution = process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;

if (isDirectExecution) {
    syncAll().catch(console.error);
}
