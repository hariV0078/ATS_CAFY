/**
 * ukFilter.ts — Deterministic UK Job Filter
 * 
 * Implements a 3-layer pipeline for filtering jobs based on structured location data.
 * Priority: Trusted Source > Remote Flag > UK Geography > Hard Block > Global Signal.
 */

export type JobLocationInput = {
    locations: string[];
    isRemote: boolean;
    isTrustedSource: boolean;
};

const UK_GEOGRAPHY = [
    // Nations
    "england", "scotland", "wales", "northern ireland",
    // Major Cities
    "london", "manchester", "birmingham", "leeds", "edinburgh", "glasgow", 
    "bristol", "cardiff", "belfast", "liverpool", "sheffield", "newcastle", 
    "nottingham", "leicester", "coventry", "brighton", "oxford", "cambridge", 
    "bath", "york",
    // Country Terms
    "united kingdom", "uk", "u.k.", "gb", "great britain", "remote uk", "hybrid uk"
];

const HARD_BLOCKS = [
    // Countries
    "india", "canada", "australia", "singapore", "germany", "france", 
    "netherlands", "spain", "poland", "uae", "dubai",
    // Ireland (Careful: must not block "Northern Ireland")
    "dublin", "ireland",
    // US States
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", 
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", 
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", 
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", 
    "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", 
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", 
    "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", 
    "wisconsin", "wyoming"
];

const GLOBAL_SIGNALS = ["global", "worldwide", "international", "emea", "remote"];

export function isUKJob(input: JobLocationInput): boolean {
    const { locations, isRemote, isTrustedSource } = input;

    // 1. Trust the Source
    if (isTrustedSource) return true;

    // 2. Trust the Data (Remote Flag)
    if (isRemote) return true;

    // Normalize locations once
    const normalizedLocs = locations.map(l => l.toLowerCase().trim());

    // 3. Trust the Signal (UK Geography)
    // Use word boundaries to prevent "New York" matching "York"
    for (const loc of normalizedLocs) {
        for (const uk of UK_GEOGRAPHY) {
            const regex = new RegExp(`\\b${uk.replace(/\./g, '\\.')}\\b`, 'i');
            if (regex.test(loc)) {
                // Specific fix for York matching New York
                if (uk === "york" && /\bnew\s+york\b/i.test(loc)) {
                    continue;
                }
                return true;
            }
        }
    }

    // 4. Hard Blocks
    for (const loc of normalizedLocs) {
        const isBlocked = HARD_BLOCKS.some(block => {
            // Special case for Ireland to avoid blocking Northern Ireland
            if (block === "ireland" && loc.includes("northern ireland")) {
                return false;
            }
            const regex = new RegExp(`\\b${block}\\b`, 'i');
            return regex.test(loc);
        });

        if (isBlocked) {
            return false;
        }
    }

    // 5. Global/EMEA Signals
    for (const loc of normalizedLocs) {
        if (GLOBAL_SIGNALS.some(signal => loc.includes(signal))) {
            return true;
        }
    }

    // Default: Reject
    return false;
}
