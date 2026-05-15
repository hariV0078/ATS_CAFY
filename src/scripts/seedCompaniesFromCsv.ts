/**
 * seedCompaniesFromCsv.ts
 *
 * Reads  "ATS compnies - industry_grade_ats_database_fixed.csv"
 * and upserts every "Good" row into public.companies so that:
 *   1. The syncAll scraper knows which ATS to call (ats_provider + ats_board_token)
 *   2. The job cards can display the company name (trading_name)
 *
 * Run:  npm run seed:companies
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load env the same way syncAll.ts does (tries .env.local first, then .env)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ─── Supabase client (uses service role so it can bypass RLS) ─────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
                  || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
                  || '';

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    console.error('URL found:', !!SUPABASE_URL, '| Key found:', !!SERVICE_KEY);
    process.exit(1);
}

console.log('Connecting to:', SUPABASE_URL);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
});

// ─── CSV config ───────────────────────────────────────────────────────────────
// CSV columns: Company ID, Company Name, ATS Provider, ATS Board Token, URL, Verification, Status
const CSV_PATH = path.resolve(
    __dirname,
    '../../ATS compnies - industry_grade_ats_database_fixed.csv'
);

// Only import rows with this status (set to null to import ALL rows)
const ONLY_STATUS = 'Good';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeProvider(raw: string): string {
    return raw.trim().toLowerCase();
}

function parseCSV(content: string): Record<string, string>[] {
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim());
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
        // Simple CSV split — handles basic cases (no embedded commas in fields)
        const cols = lines[i].split(',');
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => {
            row[h] = (cols[idx] ?? '').trim();
        });
        rows.push(row);
    }

    return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!fs.existsSync(CSV_PATH)) {
        console.error(`CSV not found at: ${CSV_PATH}`);
        process.exit(1);
    }

    const content = fs.readFileSync(CSV_PATH, 'utf-8');
    const rows = parseCSV(content);
    console.log(`Parsed ${rows.length} rows from CSV`);

    // Filter by status if needed
    const filtered = ONLY_STATUS
        ? rows.filter(r => r['Status']?.toLowerCase() === ONLY_STATUS.toLowerCase())
        : rows;

    console.log(`Rows to import (status="${ONLY_STATUS}"): ${filtered.length}`);

    // Map CSV columns → companies table columns
    const records = filtered
        .filter(r => r['Company ID'] && !isNaN(Number(r['Company ID'])))
        .map(r => ({
            id:              Number(r['Company ID']),
            trading_name:    r['Company Name'],
            ats_provider:    normalizeProvider(r['ATS Provider']),
            ats_board_token: r['ATS Board Token'] || null,
            careers_url:     r['URL'] || null,
        }));

    if (records.length === 0) {
        console.log('No valid records to import.');
        return;
    }

    // Upsert in batches of 200
    const BATCH = 200;
    let inserted = 0;
    let failed   = 0;

    for (let i = 0; i < records.length; i += BATCH) {
        const chunk = records.slice(i, i + BATCH);

        const { error } = await supabase
            .from('companies')
            .upsert(chunk, {
                onConflict: 'id',          // update if id already exists
                ignoreDuplicates: false,   // always overwrite ats fields + name
            });

        if (error) {
            console.error(`Batch ${i}–${i + chunk.length - 1} FAILED:`, error.message);
            failed += chunk.length;
        } else {
            inserted += chunk.length;
            console.log(`  ✓ Upserted rows ${i + 1}–${i + chunk.length}`);
        }
    }

    console.log(`\nDone. Upserted: ${inserted} | Failed: ${failed}`);

    // Reset the serial sequence so new auto-inserted rows don't clash
    const { error: seqErr } = await supabase.rpc('reset_companies_sequence');
    if (seqErr) {
        // Not critical — sequence reset can also be done manually in SQL editor:
        // SELECT setval(pg_get_serial_sequence('public.companies','id'), (SELECT MAX(id) FROM public.companies));
        console.warn('Sequence reset skipped (run manually if needed):', seqErr.message);
    }

    // Verify a sample
    const { data: sample } = await supabase
        .from('companies')
        .select('id, trading_name, ats_provider, ats_board_token')
        .order('id', { ascending: true })
        .limit(5);

    console.log('\nSample rows in companies table:');
    console.table(sample);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
