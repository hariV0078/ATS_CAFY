import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import Papa from 'papaparse';

// Load env
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('ERROR: Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
});

// Take the CSV filename from the command line argument, or default to a generic name
const fileName = process.argv[2] || 'my_companies_data.csv';
const CSV_PATH = path.resolve(process.cwd(), fileName);

function parseBoolean(val: string | undefined): boolean | null {
    if (!val) return null;
    const lower = val.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
    return null;
}

async function main() {
    if (!fs.existsSync(CSV_PATH)) {
        console.error(`❌ CSV not found at: ${CSV_PATH}`);
        console.log(`Usage: npm run import:full "path/to/your/file.csv"`);
        process.exit(1);
    }

    const csvText = fs.readFileSync(CSV_PATH, 'utf8');
    const parsed = Papa.parse<Record<string, any>>(csvText, {
        header: true,
        skipEmptyLines: true,
    });

    if (parsed.errors.length > 0) {
        console.error('❌ CSV parse errors:', parsed.errors[0].message);
        process.exit(1);
    }

    const rows = parsed.data;
    console.log(`Parsed ${rows.length} rows from CSV`);

    const records = rows.map((r: any) => ({
        id:                            r.id ? Number(r.id) : undefined,
        trading_name:                  r.trading_name,
        companies_house_name:          r.companies_house_name || null,
        url:                           r.url || null,
        url_linkedin:                  r.url_linkedin || null,
        description:                   r.description || null,
        policy:                        r.policy || null,
        open_to_sponsorship:           r.open_to_sponsorship ? Number(r.open_to_sponsorship) : null,
        active_jobs_count:             r.active_jobs_count ? Number(r.active_jobs_count) : 0,
        url_favicon:                   r.url_favicon || null,
        licensed_sponsor:              parseBoolean(r.licensed_sponsor),
        estimated_num_employees_label: r.estimated_num_employees_label || null,
        ats_provider:                  r.ats_provider || null,
        ats_board_token:               r.ats_board_token || null,
        // Fallback for timestamps if they exist in CSV
        created_at:                    r.created_at || new Date().toISOString(),
        updated_at:                    r.updated_at || new Date().toISOString(),
    })).filter((r: any) => r.trading_name); // Must have at least a trading_name

    if (records.length === 0) {
        console.log('No valid records to import.');
        return;
    }

    // Upsert in batches of 200
    const BATCH = 200;
    let inserted = 0;
    let failed = 0;

    for (let i = 0; i < records.length; i += BATCH) {
        const chunk = records.slice(i, i + BATCH);
        const { error } = await supabase
            .from('companies')
            .upsert(chunk, { onConflict: 'id' });

        if (error) {
            console.error(`❌ Batch ${i}-${i + chunk.length - 1} FAILED:`, error.message);
            failed += chunk.length;
        } else {
            inserted += chunk.length;
            console.log(`✓ Upserted rows ${i + 1} to ${i + chunk.length}`);
        }
    }

    console.log(`\n🎉 Done. Upserted: ${inserted} | Failed: ${failed}`);
    
    // Reset sequences so future additions don't crash
    await supabase.rpc('reset_companies_sequence');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
