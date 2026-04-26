
// Copied from syncAll.ts for testing
function normalizeLocation(loc: any): string {
    return String(loc || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const UK_COUNTRIES = ["UK", "United Kingdom", "GB", "GBR", "GBI", "GBRE", "Great Britain", "Rest of UK"];
const UK_NATIONS = ["scotland", "wales", "northern ireland", "england"];
const UK_CITIES = ["london", "manchester", "birmingham", "leeds"]; // truncated

function isUKLocation(loc: any): boolean {
    if (!loc) return false;
    const normalized = normalizeLocation(loc);
    if (!normalized) return false;

    // ✅ UK countries/nations/cities
    const tokens = normalized.split(/\s+/);
    for (const token of tokens) {
        if (UK_COUNTRIES.map(c => c.toLowerCase()).includes(token)) return true;
        if (UK_NATIONS.map(c => c.toLowerCase()).includes(token)) return true;
        if (UK_CITIES.map(c => c.toLowerCase()).includes(token)) return true;
    }

    // ✅ Multi-word phrases
    const multiWordUK = [...UK_COUNTRIES, ...UK_NATIONS, ...UK_CITIES].filter(w => w.includes(' '));
    for (const phrase of multiWordUK) {
        if (normalized.includes(phrase.toLowerCase())) return true;
    }

    return false;
}

function isLikelyUKJob(job: any): boolean {
    const locationNorm = normalizeLocation(job.location || '');
    const titleNorm = String(job.title || '').toLowerCase();

    if (locationNorm) {
        if (isUKLocation(locationNorm)) return true;

        const isAmbiguous = /^(remote|flexible|hybrid|anywhere|worldwide|global|distributed|not specified|multi location)$/.test(locationNorm) || 
                          /\d+\s+locations?/.test(locationNorm);

        if (!isAmbiguous) return false;
    }

    const ukTerms = [...UK_COUNTRIES, ...UK_NATIONS, ...UK_CITIES].map(s => s.toLowerCase());
    for (const term of ukTerms) {
        if (titleNorm.includes(term)) return true;
    }

    return false;
}

const testJobs = [
    { title: "Software Engineer", location: "Rest of UK" },
    { title: "Digital Technology Director - United Kingdom", location: "2 Locations" },
    { title: "Sales Manager", location: "5 Locations" },
    { title: "Project Manager (UK)", location: "Multi-location" },
    { title: "Engineer", location: "Flexible - UK Wide" }
];

testJobs.forEach(job => {
    const isUK = isLikelyUKJob(job);
    console.log(`Job: "${job.title}" | Loc: "${job.location}" => UK? ${isUK}`);
});
