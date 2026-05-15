import { createClient } from '@supabase/supabase-js';

// If we are in a Node.js environment (e.g. CLI script), load dotenv
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    try {
        const dotenv = require('dotenv');
        dotenv.config({ path: '.env.local' });
    } catch (e) {
        // dotenv might not be available in browser, which is fine
    }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'mock-key';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
