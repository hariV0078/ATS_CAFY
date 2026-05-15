import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import * as xlsx from 'xlsx';

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

const XLSX_PATH = path.resolve(__dirname, '../../Testing_jobs_data.xlsx');

function normalizeProvider(raw: string): string {
    return (raw || '').trim().toLowerCase();
}

async function main() {
    if (!fs.existsSync(XLSX_PATH)) {
        console.error(`XLSX not found at: ${XLSX_PATH}`);
        process.exit(1);
    }

    // Parse Excel file
    const workbook = xlsx.readFile(XLSX_PATH);
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json<Record<string, any>>(worksheet);

    console.log(`Parsed ${rows.length} rows from Excel`);

    const recordsMap = new Map();
    rows
        .filter(r => r['Company ID'] && !isNaN(Number(r['Company ID'])))
        .forEach(r => {
            recordsMap.set(Number(r['Company ID']), {
                id:              Number(r['Company ID']),
                trading_name:    r['Company Name'],
                ats_provider:    normalizeProvider(r['ATS Provider']),
                ats_board_token: r['ATS Board Token'] || null,
                careers_url:     r['URL'] || null,
            });
        });

    const records = Array.from(recordsMap.values());

    if (records.length === 0) {
        console.log('No valid records to import.');
        return;
    }

    // Upsert the companies
    const { error } = await supabase
        .from('companies')
        .upsert(records, {
            onConflict: 'id',
            ignoreDuplicates: false,
        });

    if (error) {
        console.error(`Upsert FAILED:`, error.message);
        process.exit(1);
    } else {
        console.log(`✓ Upserted ${records.length} testing companies into DB.`);
    }

    const ids = records.map(r => r.id);
    console.log(`\nCOMPANY_IDS_IMPORTED:${ids.join(',')}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
