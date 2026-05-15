/**
 * detectAtsFromCareersPage.ts
 *
 * 4-layer ATS detection pipeline:
 *   L1 — Direct API probe   (token variants → ashby/greenhouse/lever/workable/smartrecruiters)
 *   L2 — Website crawl      (homepage → /careers → /jobs → scan all hrefs/iframes/scripts)
 *   L3 — DuckDuckGo search  (site: query → snippet scan → crawl top results)
 *   L4 — Gemini grounded search (Google Search tool → structured JSON response)
 *
 * Writes verified results to Supabase companies table.
 * Outputs ats_detection_results.csv + needs_manual_review.csv.
 *
 * Usage:
 *   npm run detect:ats:test          --limit 20
 *   npm run detect:ats               (full run)
 *   npm run detect:ats:single -- --company-id 42
 *   npm run detect:ats -- --provider greenhouse
 *   npm run detect:ats -- --recheck  (re-validates ok companies too)
 */

import axios, { AxiosError } from 'axios'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createAdminClient } from './src/utils/supabase/admin'

const scriptDir = path.dirname(path.resolve(process.argv[1] || '.'))
const envCandidatePaths = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(scriptDir, '.env.local'),
    path.resolve(scriptDir, '..', '.env.local'),
    path.resolve(scriptDir, '..', '..', '.env.local'),
    path.resolve(scriptDir, '..', '..', '..', '.env.local'),
]

const triedEnvPaths = Array.from(new Set(envCandidatePaths))
for (const envPath of triedEnvPaths) {
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath, override: false })
        break
    }
}

const REQUIRED_ENV_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key])
if (missingEnvVars.length > 0) {
    console.error(`Missing env vars: ${missingEnvVars.join(', ')}`)
    console.error(`Looked for .env.local at: ${triedEnvPaths.join(' | ')}`)
    process.exit(1)
}

// ─── Types ────────────────────────────────────────────────────────────────────

type AtsStatus =
    | 'ok'
    | 'bad_token'
    | 'auth_or_bot_protected'
    | 'dead'
    | 'unchecked'
    | 'needs_manual_review'
    | 'no_careers_page_found'

type Confidence = 'high' | 'medium' | 'low' | 'none'

type LayerName = 'api_probe' | 'website_crawl' | 'duckduckgo' | 'duckduckgo_snippet'
    | 'duckduckgo_crawl' | 'gemini_search' | 'heuristic_probe' | 'none'

interface CompanyRow {
    id: number
    trading_name: string
    url: string | null
    url_linkedin?: string | null
    careers_url?: string | null
    ats_provider: string | null
    ats_board_token: string | null
    ats_status: string | null
}

interface AtsMatch {
    provider: string
    token: string
    careersUrl: string
    confidence: Confidence
    layer: LayerName
}

interface RunRow {
    company: CompanyRow
    careersUrlFound: string | null
    oldProvider: string | null
    oldToken: string | null
    newProvider: string | null
    newToken: string | null
    status: AtsStatus
    probeCode: number | ''
    layer: LayerName
    notes: string
    changed: boolean
}

interface CliArgs {
    limit: number | null
    provider: string | null
    recheck: boolean
    companyId: number | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 12_000
const PROBE_TIMEOUT_MS = 7_000
const GEMINI_TIMEOUT_MS = 60_000
const BATCH_SIZE = 5
const BATCH_DELAY_MS = 400

const VALID_PROVIDERS = new Set([
    'greenhouse', 'greenhouse_eu', 'lever', 'lever_eu', 'ashby',
    'workable', 'recruitee', 'smartrecruiters', 'teamtailor',
    'bamboohr', 'personio', 'jobvite', 'workday', 'oracle_cloud',
    'icims', 'successfactors', 'taleo', 'avature', 'pinpoint',
    'breezy', 'custom', 'none',
])

const GENERIC_TOKENS = new Set([
    'www', 'jobs', 'careers', 'apply', 'hire', 'work', 'en-us', 'en',
    'job', 'career', 'about', 'company', 'portal', 'external', 'internal',
    'search', 'listing', 'us', 'uk', 'eu', 'fr', 'de', 'v1', 'v2', 'api',
    'home', 'index', 'page', 'post', 'category', 'app', 'careersite',
    'data', 'team', 'corp', 'ltd', 'group', 'solutions', 'services',
    'global', 'international', 'tech', 'digital', 'media',
])

const EXCLUDED_HOMEPAGE_PATHS = new Set([
    '/', '#', '', '/about', '/contact', '/blog', '/news',
    '/pricing', '/product', '/solutions', '/platform',
    '/login', '/signup', '/docs', '/support', '/terms', '/privacy',
])

// ─── Clients ──────────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')

let _supabase: ReturnType<typeof createAdminClient> | null = null
async function getSupabase() {
    if (!_supabase) _supabase = createAdminClient()
    return _supabase
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toTimeString().slice(0, 8)
const log = {
    info:  (m: string) => console.log(`[${ts()}]        ${m}`),
    ok:    (m: string) => console.log(`[${ts()}] ✅     ${m}`),
    warn:  (m: string) => console.log(`[${ts()}] ⚠️      ${m}`),
    skip:  (m: string) => console.log(`[${ts()}] ✗      ${m}`),
    row:   (r: RunRow) => {
        const label = rowLabel(r)
        const p = r.newProvider ?? '—'
        const t = r.newToken ?? '—'
        const code = r.probeCode === '' ? '—' : String(r.probeCode)
        console.log(`${label} ${r.company.trading_name.padEnd(26)} ${p.padEnd(14)} / ${t.padEnd(22)} [L:${r.layer} code:${code}]`)
    },
}

function rowLabel(r: RunRow): string {
    if (r.status === 'ok' && r.layer === 'api_probe')     return '[OK-L1]  '
    if (r.status === 'ok' && r.layer === 'website_crawl') return '[OK-L2]  '
    if (r.status === 'ok' && r.layer.startsWith('duck'))  return '[OK-L3]  '
    if (r.status === 'ok' && r.layer === 'gemini_search') return '[OK-L4]  '
    if (r.status === 'ok')                                return '[OK]     '
    if (r.status === 'unchecked')                         return '[UNCHK]  '
    if (r.status === 'no_careers_page_found')             return '[NO_PAGE]'
    if (r.status === 'bad_token')                         return '[BAD_TOK]'
    if (r.status === 'auth_or_bot_protected')             return '[AUTH]   '
    if (r.status === 'dead')                              return '[DEAD]   '
    return '[MANUAL] '
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function normalizeToken(raw: string): string {
    return raw.trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
}

function isGeneric(token: string): boolean {
    if (!token) return true
    const n = normalizeToken(token)
    return !n || n.length < 3 || GENERIC_TOKENS.has(n)
}

function normalizeUrl(base: string, raw: string): string | null {
    try {
        if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return null
        return new URL(raw, base).toString()
    } catch { return null }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
    let settled = false
    const guarded = p
        .then((value) => {
            settled = true
            return value
        })
        .catch((e) => {
            settled = true
            log.warn(`Error in ${label}: ${(e as Error).message}`)
            return null
        })

    const timeout = sleep(ms).then(() => {
        if (!settled) {
            log.warn(`Timeout ${ms}ms: ${label}`)
        }
        return null as T | null
    })

    return Promise.race([guarded, timeout])
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseCli(): CliArgs {
    const args = process.argv.slice(2)
    const out: CliArgs = { limit: null, provider: null, recheck: false, companyId: null }
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit')      { out.limit = parseInt(args[++i]); continue }
        if (args[i] === '--provider')   { out.provider = args[++i].toLowerCase(); continue }
        if (args[i] === '--company-id') { out.companyId = parseInt(args[++i]); continue }
        if (args[i] === '--recheck')    { out.recheck = true; continue }
    }
    return out
}

// ─── ATS URL Matcher ──────────────────────────────────────────────────────────
// Precise host-based matching — no regex false positives

function matchAtsUrl(url: string): AtsMatch | null {
    try {
        const u = new URL(url)
        const host = u.hostname.toLowerCase()
        const parts = u.pathname.split('/').filter(Boolean)

        const tok = (t?: string): string | null => (t && !isGeneric(t)) ? normalizeToken(t) : null

        // Greenhouse
        if (host === 'boards.greenhouse.io') {
            const embedToken = u.searchParams.get('for')
            const t = tok(embedToken ?? parts[0])
            return t ? { provider: 'greenhouse', token: t, careersUrl: `https://boards.greenhouse.io/${t}`, confidence: 'high', layer: 'website_crawl' } : null
        }
        if (host === 'job-boards.eu.greenhouse.io') {
            const t = tok(parts[0])
            return t ? { provider: 'greenhouse_eu', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Lever
        if (host === 'jobs.lever.co') {
            const t = tok(parts[0])
            return t ? { provider: 'lever', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }
        if (host === 'jobs.eu.lever.co') {
            const t = tok(parts[0])
            return t ? { provider: 'lever_eu', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Ashby
        if (host === 'jobs.ashbyhq.com') {
            const t = tok(parts[0])
            return t ? { provider: 'ashby', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Workable
        if (host === 'apply.workable.com') {
            const t = tok(parts[0])
            return t ? { provider: 'workable', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }
        if (host.endsWith('.workable.com') && host !== 'apply.workable.com') {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'workable', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // SmartRecruiters
        if (host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') {
            const t = tok(parts[0])
            return t ? { provider: 'smartrecruiters', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Recruitee
        if (host.endsWith('.recruitee.com')) {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'recruitee', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // TeamTailor
        if (host.endsWith('.teamtailor.com')) {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'teamtailor', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // BambooHR
        if (host.endsWith('.bamboohr.com')) {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'bamboohr', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Pinpoint
        if (host.endsWith('.pinpointhq.com')) {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'pinpoint', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Breezy
        if (host.endsWith('.breezy.hr')) {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'breezy', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Jobvite
        if (host === 'jobs.jobvite.com') {
            const t = tok(parts[0])
            return t ? { provider: 'jobvite', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Personio
        if (host.endsWith('.jobs.personio.com') || host.endsWith('.jobs.personio.de')) {
            const t = tok(host.split('.')[0])
            return t ? { provider: 'personio', token: t, careersUrl: url, confidence: 'high', layer: 'website_crawl' } : null
        }

        // Workday — token is the full URL (tenant subdomain required)
        if (host.endsWith('.myworkdayjobs.com') && host !== 'www.myworkdayjobs.com' && host !== 'myworkdayjobs.com') {
            const site = parts[0]
            if (!site) return null
            const fullToken = `${u.protocol}//${u.host}/${site}`
            return { provider: 'workday', token: fullToken, careersUrl: url, confidence: 'high', layer: 'website_crawl' }
        }

        // Oracle / Taleo — token is full URL
        if (host.endsWith('.taleo.net') || (host.endsWith('.oraclecloud.com') && u.pathname.includes('hcmUI'))) {
            return { provider: 'oracle_cloud', token: `${u.protocol}//${u.host}`, careersUrl: url, confidence: 'high', layer: 'website_crawl' }
        }

        // iCIMS — token is full URL
        if (host.endsWith('.icims.com') && !host.startsWith('api.')) {
            return { provider: 'icims', token: `${u.protocol}//${u.host}`, careersUrl: url, confidence: 'high', layer: 'website_crawl' }
        }

        // SuccessFactors
        if (host.endsWith('.successfactors.com') || host.endsWith('.successfactors.eu')) {
            return { provider: 'successfactors', token: `${u.protocol}//${u.host}`, careersUrl: url, confidence: 'high', layer: 'website_crawl' }
        }

        return null
    } catch { return null }
}

// ─── Token variants from company name + website ───────────────────────────────

function tokenVariants(name: string, website?: string | null): string[] {
    const candidates = new Set<string>()

    const add = (v: string) => {
        const n = normalizeToken(v)
        if (n.length >= 3 && !isGeneric(n)) candidates.add(n)
    }

    add(name.replace(/\s+/g, ''))          // "incidentio"
    add(name.replace(/\s+/g, '-'))         // "incident-io"
    add(name.split(/\s+/)[0])             // "incident"
    add(name.replace(/\s+(.)/g, (_, c: string) => c.toUpperCase())) // "incidentIo"

    // From website domain
    if (website) {
        try {
            const hostname = new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '')
            const root = hostname.split('.')[0]
            add(root)
        } catch { /* skip */ }
    }

    return [...candidates].slice(0, 8)
}

// ─── Layer 1: Direct API probe ────────────────────────────────────────────────
// Only probes providers where 404 = wrong token (not subdomain-any-200).
// TeamTailor/BambooHR/Recruitee use subdomains — any slug returns 200.

async function httpOk(url: string): Promise<boolean> {
    try {
        const res = await axios.get(url, {
            timeout: PROBE_TIMEOUT_MS,
            maxRedirects: 3,
            validateStatus: s => s === 200,
            headers: { 'User-Agent': UA },
        })
        return res.status === 200 && (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).length > 50
    } catch { return false }
}

async function checkAshby(token: string): Promise<AtsMatch | null> {
    if (!await httpOk(`https://api.ashbyhq.com/posting-api/job-board/${token}`)) return null
    return { provider: 'ashby', token, careersUrl: `https://jobs.ashbyhq.com/${token}`, confidence: 'high', layer: 'api_probe' }
}

async function checkGreenhouse(token: string): Promise<AtsMatch | null> {
    if (!await httpOk(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`)) return null
    return { provider: 'greenhouse', token, careersUrl: `https://boards.greenhouse.io/${token}`, confidence: 'high', layer: 'api_probe' }
}

async function checkGreenhouseEu(token: string): Promise<AtsMatch | null> {
    if (!await httpOk(`https://job-boards.eu.greenhouse.io/${token}`)) return null
    return { provider: 'greenhouse_eu', token, careersUrl: `https://job-boards.eu.greenhouse.io/${token}`, confidence: 'high', layer: 'api_probe' }
}

async function checkLever(token: string): Promise<AtsMatch | null> {
    if (!await httpOk(`https://api.lever.co/v0/postings/${token}?mode=json`)) return null
    return { provider: 'lever', token, careersUrl: `https://jobs.lever.co/${token}`, confidence: 'high', layer: 'api_probe' }
}

async function checkWorkable(token: string): Promise<AtsMatch | null> {
    try {
        const res = await axios.get(`https://apply.workable.com/api/v1/widget/accounts/${token}`, {
            timeout: PROBE_TIMEOUT_MS, headers: { 'User-Agent': UA }, validateStatus: s => s === 200,
        })
        if (res.status !== 200) return null
        const subdomain = res.data?.account?.subdomain?.toString().trim()
        const finalToken = (subdomain && !isGeneric(subdomain)) ? normalizeToken(subdomain) : token
        return { provider: 'workable', token: finalToken, careersUrl: `https://apply.workable.com/${finalToken}/`, confidence: 'high', layer: 'api_probe' }
    } catch { return null }
}

async function checkSmartRecruiters(token: string): Promise<AtsMatch | null> {
    try {
        const res = await axios.get(`https://api.smartrecruiters.com/v1/companies/${token}`, {
            timeout: PROBE_TIMEOUT_MS, headers: { 'User-Agent': UA }, validateStatus: s => s === 200,
        })
        if (res.status !== 200) return null
        const id = res.data?.identifier
        if (!id) return null
        return { provider: 'smartrecruiters', token: id, careersUrl: `https://careers.smartrecruiters.com/${id}`, confidence: 'high', layer: 'api_probe' }
    } catch { return null }
}

async function layer1ApiProbe(company: CompanyRow): Promise<AtsMatch | null> {
    const tokens = tokenVariants(company.trading_name, company.url)
    log.info(`  L1 tokens: [${tokens.join(', ')}]`)

    for (const token of tokens) {
        const results = await Promise.all([
            checkAshby(token),
            checkGreenhouse(token),
            checkGreenhouseEu(token),
            checkLever(token),
            checkWorkable(token),
            checkSmartRecruiters(token),
        ])
        const hit = results.find(r => r !== null)
        if (hit) { log.info(`  L1 hit: ${hit.provider}/${hit.token}`); return hit }
    }
    return null
}

// ─── Layer 2: Website crawl ───────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<{ finalUrl: string; html: string } | null> {
    try {
        const res = await axios.get<string>(url, {
            timeout: FETCH_TIMEOUT_MS,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: s => s < 400,
            headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        })
        return { finalUrl: (res.request?.res?.responseUrl as string) || url, html: res.data ?? '' }
    } catch { return null }
}

function extractAllUrls(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html)
    const urls = new Set<string>()

    const push = (raw?: string | null) => {
        const n = normalizeUrl(baseUrl, raw ?? '')
        if (n) urls.add(n)
    }

    $('a[href]').each((_, el) => push($(el).attr('href')))
    $('iframe[src], script[src], link[href]').each((_, el) => {
        push($(el).attr('src') || $(el).attr('href'))
    })

    // Also pull raw URLs from JS blobs — catches embedded ATS config
    for (const m of html.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) push(m)

    return [...urls]
}

function scoreCareersLink(url: string, text: string): number {
    const combined = `${url} ${text}`.toLowerCase()
    let score = 0
    if (/careers/.test(combined)) score += 4
    if (/jobs/.test(combined)) score += 3
    if (/work.?with.?us|join.?us|we.?are.?hiring|open.?roles|vacancies/.test(combined)) score += 2
    if (/careers/.test(url)) score += 2  // double weight if in href
    return score
}

async function findCareersUrl(homepageUrl: string): Promise<string | null> {
    const page = await fetchHtml(homepageUrl)
    if (!page) return null

    const $ = cheerio.load(page.html)
    const candidates: { url: string; score: number }[] = []

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        const text = $(el).text().trim()
        const normalized = normalizeUrl(page.finalUrl, href)
        if (!normalized) return

        try {
            const pathname = new URL(normalized).pathname.replace(/\/+$/, '') || '/'
            if (EXCLUDED_HOMEPAGE_PATHS.has(pathname)) return
            if (pathname.split('/').filter(Boolean).length === 0) return
        } catch { return }

        const score = scoreCareersLink(normalized, text)
        if (score > 0) candidates.push({ url: normalized, score })
    })

    candidates.sort((a, b) => b.score - a.score)
    if (candidates[0]) return candidates[0].url

    // Fallback: try common paths
    for (const p of ['/careers', '/jobs', '/about/careers']) {
        const candidate = normalizeUrl(page.finalUrl, p)
        if (!candidate) continue
        const test = await fetchHtml(candidate)
        if (test && test.html.length > 500) return test.finalUrl
    }

    return null
}

async function layer2WebsiteCrawl(company: CompanyRow): Promise<AtsMatch | null> {
    if (!company.url) return null
    log.info(`  L2 finding careers page...`)

    const careersUrl = await findCareersUrl(company.url)
    if (!careersUrl) { log.info(`  L2 no careers page`); return null }
    log.info(`  L2 careers: ${careersUrl}`)

    const careersPage = await fetchHtml(careersUrl)
    if (!careersPage) return null

    // Check final URL after redirects first
    const directMatch = matchAtsUrl(careersPage.finalUrl)
    if (directMatch) { log.info(`  L2 hit from redirect: ${directMatch.provider}/${directMatch.token}`); return { ...directMatch, layer: 'website_crawl' } }

    // Scan all URLs on the careers page
    const allUrls = extractAllUrls(careersPage.html, careersPage.finalUrl)
    for (const u of allUrls) {
        const hit = matchAtsUrl(u)
        if (hit) { log.info(`  L2 hit from href: ${hit.provider}/${hit.token}`); return { ...hit, layer: 'website_crawl' } }
    }

    // Follow one job listing link deeper
    const jobLink = allUrls.find(u => /\/job\/|\/jobs\/|\/role\/|\/opening\/|\/position\//i.test(u))
    if (jobLink) {
        const jobPage = await fetchHtml(jobLink)
        if (jobPage) {
            const jobMatch = matchAtsUrl(jobPage.finalUrl)
            if (jobMatch) { log.info(`  L2 hit from job link: ${jobMatch.provider}/${jobMatch.token}`); return { ...jobMatch, layer: 'website_crawl' } }
            for (const u of extractAllUrls(jobPage.html, jobPage.finalUrl)) {
                const hit = matchAtsUrl(u)
                if (hit) { log.info(`  L2 hit from job page href: ${hit.provider}/${hit.token}`); return { ...hit, layer: 'website_crawl' } }
            }
        }
    }

    return null
}

// ─── Layer 3: DuckDuckGo search ───────────────────────────────────────────────

let ddgCalls = 0
let ddgHits = 0

function parseDdgHtml(html: string, maxResults: number): Array<{ link: string; snippet: string }> {
    const $ = cheerio.load(html)
    const results: Array<{ link: string; snippet: string }> = []
    const seen = new Set<string>()

    const tryAdd = (rawLink: string, snippet: string) => {
        if (results.length >= maxResults) return
        try {
            const parsed = new URL(rawLink)
            // Unwrap DDG redirect
            const uddg = parsed.searchParams.get('uddg') || parsed.searchParams.get('u')
            const link = uddg ? decodeURIComponent(uddg) : rawLink
            if (!link.startsWith('http')) return
            if (new URL(link).hostname.includes('duckduckgo')) return
            if (seen.has(link)) return
            seen.add(link)
            results.push({ link, snippet: snippet.replace(/\s+/g, ' ').trim() })
        } catch { /* skip */ }
    }

    $('div.result').each((_, el) => {
        const link = $(el).find('a.result__a').attr('href') ?? ''
        const snippet = $(el).find('.result__snippet').text()
        tryAdd(link, snippet)
    })

    return results
}

async function duckDuckGoSearch(query: string, maxResults = 5): Promise<Array<{ link: string; snippet: string }>> {
    ddgCalls++
    try {
        const res = await axios.get<string>('https://html.duckduckgo.com/html/', {
            timeout: 10_000,
            responseType: 'text',
            params: { q: query },
            headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        })
        const results = parseDdgHtml(res.data ?? '', maxResults)
        if (results.length > 0) ddgHits++
        return results
    } catch {
        // Fallback to lite endpoint
        try {
            const body = new URLSearchParams({ q: query }).toString()
            const res = await axios.post<string>('https://lite.duckduckgo.com/lite/', body, {
                timeout: 10_000,
                responseType: 'text',
                headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
            })
            const results = parseDdgHtml(res.data ?? '', maxResults)
            if (results.length > 0) ddgHits++
            return results
        } catch { return [] }
    }
}

async function layer3DuckDuckGo(company: CompanyRow): Promise<AtsMatch | null> {
    log.info(`  L3 DDG search...`)

    // Query 1: Direct ATS site search — best signal
    const q1 = `"${company.trading_name}" site:jobs.ashbyhq.com OR site:boards.greenhouse.io OR site:job-boards.eu.greenhouse.io OR site:jobs.lever.co OR site:jobs.eu.lever.co OR site:apply.workable.com OR site:careers.smartrecruiters.com OR site:myworkdayjobs.com OR site:bamboohr.com OR site:recruitee.com OR site:teamtailor.com OR site:jobs.jobvite.com OR site:pinpointhq.com OR site:breezy.hr`
    const r1 = await duckDuckGoSearch(q1, 5)

    for (const { link, snippet } of r1) {
        const hit = matchAtsUrl(link)
        if (hit) { log.info(`  L3 hit from DDG link: ${hit.provider}/${hit.token}`); return { ...hit, layer: 'duckduckgo' } }
        const snippetHit = matchAtsUrl(snippet)
        if (snippetHit) { log.info(`  L3 hit from DDG snippet`); return { ...snippetHit, layer: 'duckduckgo_snippet' } }
    }

    await sleep(200)

    // Query 2: General careers page search, then crawl results
    const q2 = `${company.trading_name} careers jobs apply`
    const r2 = await duckDuckGoSearch(q2, 3)

    for (const { link } of r2) {
        if (company.url && link === company.url) continue
        const page = await fetchHtml(link)
        if (!page) continue
        const directHit = matchAtsUrl(page.finalUrl)
        if (directHit) { log.info(`  L3 hit from DDG crawl redirect: ${directHit.provider}/${directHit.token}`); return { ...directHit, layer: 'duckduckgo_crawl' } }
        for (const u of extractAllUrls(page.html, page.finalUrl)) {
            const hit = matchAtsUrl(u)
            if (hit) { log.info(`  L3 hit from DDG crawl page: ${hit.provider}/${hit.token}`); return { ...hit, layer: 'duckduckgo_crawl' } }
        }
    }

    return null
}

// ─── Layer 4: Gemini grounded search ─────────────────────────────────────────

function buildGeminiPrompt(company: CompanyRow): string {
    return `Find the ATS job board for this company.

Company: ${company.trading_name}
Website: ${company.url ?? 'unknown'}

Search Google for:
"${company.trading_name} site:jobs.ashbyhq.com OR site:boards.greenhouse.io OR site:job-boards.eu.greenhouse.io OR site:jobs.lever.co OR site:jobs.eu.lever.co OR site:apply.workable.com OR site:careers.smartrecruiters.com OR site:myworkdayjobs.com OR site:bamboohr.com OR site:recruitee.com OR site:teamtailor.com OR site:personio.com OR site:icims.com OR site:taleo.net"

Also try: "${company.trading_name} careers workday oracle icims taleo"

Return the ATS URL you find and the correct provider and token.

Provider mapping:
  jobs.ashbyhq.com/{token}               → ashby
  boards.greenhouse.io/{token}           → greenhouse
  job-boards.eu.greenhouse.io/{token}    → greenhouse_eu
  jobs.lever.co/{token}                  → lever
  jobs.eu.lever.co/{token}               → lever_eu
  apply.workable.com/{token}             → workable
  {token}.workable.com                   → workable
  careers.smartrecruiters.com/{token}    → smartrecruiters
  {token}.recruitee.com                  → recruitee
  {token}.teamtailor.com                 → teamtailor
  {token}.bamboohr.com                   → bamboohr
  {token}.jobs.personio.com              → personio
  {tenant}.wd{N}.myworkdayjobs.com/{X}   → workday (token = FULL URL, must include tenant subdomain)
  *.taleo.net / *.oraclecloud.com/hcmUI  → oracle_cloud (token = full base URL)
  *.icims.com                            → icims (token = full base URL)
  only on own domain                     → custom (token = full careers URL)
  nothing found                          → none

Return ONLY valid JSON, no markdown:
{"ats_provider":"...","ats_board_token":"...","verified":true,"careers_url":"...","confidence":"high","notes":""}`
}

async function layer4Gemini(company: CompanyRow): Promise<AtsMatch | null> {
    if (!process.env.GEMINI_API_KEY) { log.warn(`  L4 skipped — no GEMINI_API_KEY`); return null }
    log.info(`  L4 Gemini search...`)

    const run = async () => {
        try {
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                tools: [{ googleSearch: {} } as any],
            })
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: buildGeminiPrompt(company) }] }],
            })
            const text = result.response.text()
            if (!text?.trim()) return null

            const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
            const match = clean.match(/\{[\s\S]*\}/)
            if (!match) return null

            let parsed: any
            try { parsed = JSON.parse(match[0]) } catch { return null }

            const provider: string | null = parsed.ats_provider ?? null
            let token: string | null = parsed.ats_board_token ?? null
            const isFullUrlProvider = !!provider && FULL_URL_PROVIDERS.has(provider)

            if (!provider || provider === 'none' || !token) return null
            if (!VALID_PROVIDERS.has(provider)) { log.warn(`  L4 invalid provider: ${provider}`); return null }

            // If Gemini gave us a full URL as token for non-URL providers, extract slug
            if (token.startsWith('http') && !isFullUrlProvider) {
                const urlMatch = matchAtsUrl(token)
                if (urlMatch) token = urlMatch.token
            }

            if (!token) return null
            if (!isFullUrlProvider && isGeneric(token)) { log.warn(`  L4 generic token: ${token}`); return null }

            const finalToken = isFullUrlProvider ? token.trim() : normalizeToken(token)

            log.info(`  L4 hit: ${provider}/${finalToken}`)
            return {
                provider,
                token: finalToken,
                careersUrl: parsed.careers_url ?? ``,
                confidence: (parsed.confidence ?? 'medium') as Confidence,
                layer: 'gemini_search' as LayerName,
            }
        } catch (e: any) {
            log.warn(`  L4 Gemini error: ${e?.message ?? String(e)}`)
            return null
        }
    }

    return withTimeout(run(), GEMINI_TIMEOUT_MS, `Gemini for ${company.trading_name}`)
}

// ─── ATS probe (verify token returned by L2/L3/L4) ───────────────────────────

const PROBES: Record<string, (t: string) => string> = {
    greenhouse:      t => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    greenhouse_eu:   t => `https://job-boards.eu.greenhouse.io/${t}`,
    lever:           t => `https://api.lever.co/v0/postings/${t}?limit=1&mode=json`,
    lever_eu:        t => `https://api.lever.co/v0/postings/${t}?limit=1&mode=json`,
    ashby:           t => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    workable:        t => `https://apply.workable.com/api/v1/widget/jobs/?company=${t}&limit=1`,
    smartrecruiters: t => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=1`,
    recruitee:       t => `https://${t}.recruitee.com/api/offers`,
    pinpoint:        t => `https://${t}.pinpointhq.com/postings.json`,
    breezy:          t => `https://${t}.breezy.hr/json`,
    jobvite:         t => `https://jobs.jobvite.com/api/company/${t}/jobs`,
    teamtailor:      t => `https://${t}.teamtailor.com/jobs.json?page[size]=1`,
    bamboohr:        t => `https://${t}.bamboohr.com/careers/list`,
    personio:        t => `https://${t}.jobs.personio.com/jobs`,
}

// Providers where token is a full URL — skip standard probe, mark unchecked
const FULL_URL_PROVIDERS = new Set(['workday', 'oracle_cloud', 'icims', 'successfactors', 'custom'])

async function verifyToken(provider: string, token: string): Promise<{ status: AtsStatus; code: number | '' }> {
    if (FULL_URL_PROVIDERS.has(provider)) return { status: 'unchecked', code: '' }

    const probeFn = PROBES[provider]
    if (!probeFn) return { status: 'unchecked', code: '' }

    try {
        const res = await axios.get(probeFn(token), {
            timeout: PROBE_TIMEOUT_MS,
            maxRedirects: 3,
            validateStatus: () => true,
            headers: { 'User-Agent': UA, Accept: 'application/json,text/html,*/*' },
        })
        if (res.status === 200) return { status: 'ok', code: 200 }
        if (res.status === 404) return { status: 'bad_token', code: 404 }
        if (res.status === 401 || res.status === 403) return { status: 'auth_or_bot_protected', code: res.status }
        if (res.status >= 500) return { status: 'dead', code: res.status }
        return { status: 'bad_token', code: res.status }
    } catch (e: any) {
        if ((e as AxiosError).code === 'ECONNABORTED') return { status: 'dead', code: '' }
        return { status: 'dead', code: '' }
    }
}

// ─── Validation guard ─────────────────────────────────────────────────────────

function isWritable(provider: string | null, token: string | null, status: AtsStatus): boolean {
    if (!provider || !VALID_PROVIDERS.has(provider)) return false
    if (provider === 'none') return false
    if (!token) return false
    if (!FULL_URL_PROVIDERS.has(provider) && isGeneric(token)) return false
    if (token.length <= 2) return false
    if (FULL_URL_PROVIDERS.has(provider) && !/^https?:\/\//i.test(token)) return false
    if (provider === 'workday' && !token.includes('myworkdayjobs.com')) return false
    if (status === 'bad_token' || status === 'dead') return false
    return true
}

// ─── Main detection pipeline per company ─────────────────────────────────────

async function detectCompany(company: CompanyRow, providerFilter: string | null): Promise<RunRow> {
    const old = { provider: company.ats_provider, token: company.ats_board_token }
    log.info(`Processing: ${company.trading_name}`)

    const hasHomepage = !!company.url

    // L1 — Direct API probe
    const l1 = await withTimeout(layer1ApiProbe(company), 25_000, `L1:${company.trading_name}`)
    if (l1 && (!providerFilter || l1.provider === providerFilter)) {
        return makeRow(company, l1.careersUrl, old, l1.provider, l1.token, 'ok', 200, 'api_probe', 'l1_probe')
    }

    // L2 — Website crawl
    const l2 = hasHomepage
        ? await withTimeout(layer2WebsiteCrawl(company), 30_000, `L2:${company.trading_name}`)
        : null
    if (l2 && (!providerFilter || l2.provider === providerFilter)) {
        const verify = await verifyToken(l2.provider, l2.token)
        if (verify.status === 'ok' || verify.status === 'unchecked') {
            return makeRow(company, l2.careersUrl, old, l2.provider, l2.token, verify.status, verify.code, 'website_crawl', 'l2_crawl')
        }
    }

    // L3 — DuckDuckGo
    const l3 = await withTimeout(layer3DuckDuckGo(company), 40_000, `L3:${company.trading_name}`)
    if (l3 && (!providerFilter || l3.provider === providerFilter)) {
        const verify = await verifyToken(l3.provider, l3.token)
        if (verify.status === 'ok' || verify.status === 'unchecked') {
            return makeRow(company, l3.careersUrl, old, l3.provider, l3.token, verify.status, verify.code, l3.layer, 'l3_ddg')
        }
    }

    // L4 — Gemini
    const l4 = await withTimeout(layer4Gemini(company), GEMINI_TIMEOUT_MS + 5000, `L4:${company.trading_name}`)
    if (l4 && (!providerFilter || l4.provider === providerFilter)) {
        const verify = await verifyToken(l4.provider, l4.token)
        if (verify.status === 'ok' || verify.status === 'unchecked') {
            return makeRow(company, l4.careersUrl, old, l4.provider, l4.token, verify.status, verify.code, 'gemini_search', 'l4_gemini')
        }
    }

    const notes = hasHomepage
        ? 'all_layers_exhausted'
        : (company.url_linkedin ? 'all_layers_exhausted_no_homepage_url_linkedin_only' : 'all_layers_exhausted_no_homepage')
    return makeRow(company, null, old, old.provider, old.token, 'needs_manual_review', '', 'none', notes)
}

function makeRow(
    company: CompanyRow,
    careersUrlFound: string | null,
    old: { provider: string | null; token: string | null },
    newProvider: string | null,
    newToken: string | null,
    status: AtsStatus,
    probeCode: number | '',
    layer: LayerName,
    notes: string,
): RunRow {
    const changed = newProvider !== old.provider || newToken !== old.token || status !== company.ats_status
    return { company, careersUrlFound, oldProvider: old.provider, oldToken: old.token, newProvider, newToken, status, probeCode, layer, notes, changed }
}

// ─── DB persistence ───────────────────────────────────────────────────────────

async function persist(row: RunRow, careersColExists: boolean): Promise<void> {
    if (!row.changed) return
    if (!isWritable(row.newProvider, row.newToken, row.status)) {
        log.skip(`  Not written (failed validation): ${row.company.trading_name} → ${row.newProvider}/${row.newToken} [${row.status}]`)
        return
    }

    const supabase = await getSupabase()
    const payload: Record<string, unknown> = {
        ats_provider: row.newProvider,
        ats_board_token: row.newToken,
        ats_status: row.status,
        ats_last_validated: new Date().toISOString(),
    }
    if (careersColExists) payload.careers_url = row.careersUrlFound

    const { error } = await supabase.from('companies').update(payload).eq('id', row.company.id)
    if (error) log.warn(`  DB write failed for ${row.company.id}: ${error.message}`)
    else log.ok(`  Written: ${row.company.trading_name} → ${row.newProvider}/${row.newToken}`)
}

// ─── Load companies ───────────────────────────────────────────────────────────

async function loadCompanies(args: CliArgs, careersColExists: boolean): Promise<CompanyRow[]> {
    const supabase = await getSupabase()
    const cols = careersColExists
        ? 'id, trading_name, url, url_linkedin, careers_url, ats_provider, ats_board_token, ats_status'
        : 'id, trading_name, url, url_linkedin, ats_provider, ats_board_token, ats_status'

    const rows: CompanyRow[] = []
    let from = 0
    const PAGE = 500

    while (true) {
        let q = supabase.from('companies').select(cols).order('id').range(from, from + PAGE - 1)

        if (args.companyId !== null) {
            q = q.eq('id', args.companyId)
        } else if (args.recheck) {
            q = q.or('ats_provider.is.null,ats_board_token.is.null,ats_status.in.(bad_token,dead,needs_manual_review,unsupported_provider,ok)')
        } else {
            q = q.or('ats_provider.is.null,ats_board_token.is.null,ats_status.in.(bad_token,dead,needs_manual_review,unsupported_provider)')
        }

        if (args.provider) q = q.eq('ats_provider', args.provider)

        const { data, error } = await q
        if (error) throw new Error(`Load failed: ${error.message}`)
        if (!data || data.length === 0) break

        rows.push(...(data as unknown as CompanyRow[]))
        if (data.length < PAGE || args.companyId !== null) break
        from += PAGE
    }

    return args.limit !== null ? rows.slice(0, args.limit) : rows
}

// ─── CSV + summary ────────────────────────────────────────────────────────────

function writeCsv(rows: RunRow[]): void {
    const escape = (v: unknown) => {
        const s = v == null ? '' : String(v)
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = 'company_id,trading_name,url,careers_url_found,old_provider,old_token,new_provider,new_token,status,probe_code,layer,notes'
    const lines = rows.map(r => [
        r.company.id, r.company.trading_name, r.company.url, r.careersUrlFound,
        r.oldProvider, r.oldToken, r.newProvider, r.newToken,
        r.status, r.probeCode, r.layer, r.notes,
    ].map(escape).join(','))
    fs.writeFileSync(path.resolve(process.cwd(), 'ats_detection_results.csv'), `${header}\n${lines.join('\n')}\n`)

    const manual = rows.filter(r => r.status === 'needs_manual_review')
    if (manual.length > 0) {
        const mLines = manual.map(r => [r.company.id, r.company.trading_name, r.company.url ?? ''].map(escape).join(','))
        fs.writeFileSync(path.resolve(process.cwd(), 'needs_manual_review.csv'), `company_id,trading_name,url\n${mLines.join('\n')}\n`)
    }
}

function printSummary(rows: RunRow[]): void {
    const count = (fn: (r: RunRow) => boolean) => rows.filter(fn).length
    console.log('\n── Summary ──────────────────────────────────────────────')
    console.log(`Total processed:      ${rows.length}`)
    console.log(`Newly configured:     ${count(r => (!r.oldProvider || !r.oldToken) && !!r.newProvider && !!r.newToken && r.status === 'ok')}`)
    console.log(`Token corrected:      ${count(r => r.oldProvider === r.newProvider && !!r.oldToken && r.oldToken !== r.newToken && r.status === 'ok')}`)
    console.log(`Verified ok (L1):     ${count(r => r.status === 'ok' && r.layer === 'api_probe')}`)
    console.log(`Verified ok (L2):     ${count(r => r.status === 'ok' && r.layer === 'website_crawl')}`)
    console.log(`Verified ok (L3 DDG): ${count(r => r.status === 'ok' && r.layer.startsWith('duckduckgo'))}`)
    console.log(`Verified ok (L4 AI):  ${count(r => r.status === 'ok' && r.layer === 'gemini_search')}`)
    console.log(`Unchecked (no probe): ${count(r => r.status === 'unchecked')}`)
    console.log(`No careers page:      ${count(r => r.status === 'no_careers_page_found')}`)
    console.log(`Auth protected:       ${count(r => r.status === 'auth_or_bot_protected')}`)
    console.log(`Dead:                 ${count(r => r.status === 'dead')}`)
    console.log(`Needs manual review:  ${count(r => r.status === 'needs_manual_review')}`)
    console.log(`DDG calls / hits:     ${ddgCalls} / ${ddgHits}`)
    console.log('─────────────────────────────────────────────────────────\n')
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    const args = parseCli()
    const supabase = await getSupabase()

    // Check if careers_url column exists
    const { error: colCheck } = await supabase.from('companies').select('careers_url').limit(1)
    const careersColExists = !colCheck

    // Add careers_url column if missing
    if (!careersColExists) {
        log.warn('careers_url column not found — add with: ALTER TABLE companies ADD COLUMN IF NOT EXISTS careers_url text;')
    }

    const companies = await loadCompanies(args, careersColExists)
    log.info(`Loaded ${companies.length} companies`)

    const rows: RunRow[] = []

    for (let i = 0; i < companies.length; i += BATCH_SIZE) {
        const batch = companies.slice(i, i + BATCH_SIZE)
        const batchRows = await Promise.all(batch.map(c => detectCompany(c, args.provider)))

        for (const row of batchRows) {
            await persist(row, careersColExists)
            log.row(row)
            rows.push(row)
        }

        if (i + BATCH_SIZE < companies.length) {
            log.info(`Progress: ${Math.min(i + BATCH_SIZE, companies.length)}/${companies.length}`)
            await sleep(BATCH_DELAY_MS)
        }
    }

    writeCsv(rows)
    printSummary(rows)
}

run().catch(e => { console.error('Fatal:', e); process.exit(1) })