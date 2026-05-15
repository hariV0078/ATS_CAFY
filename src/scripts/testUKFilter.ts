import { isUKJob } from '../lib/ukFilter';
import * as Adapters from '../lib/ukFilterAdapters';

/**
 * testUKFilter.ts — Dry-run test script for the new UK Filter logic.
 * Run with: npx tsx src/scripts/testUKFilter.ts
 */

const mockJobs: any[] = [
    // 1 & 2: Clearly UK
    {
        title: "Software Engineer (London)",
        location: { name: "London" },
        offices: [{ name: "London" }],
        atsProvider: "greenhouse"
    },
    {
        title: "Marketing Manager",
        location: { name: "Birmingham" },
        offices: [{ name: "Birmingham" }],
        atsProvider: "greenhouse"
    },
    // 3 & 4: Clearly non-UK
    {
        title: "Sales Rep",
        categories: { location: "San Francisco" },
        workplaceType: "on-site",
        atsProvider: "lever"
    },
    {
        title: "Product Designer",
        categories: { location: "Austin, TX" },
        workplaceType: "hybrid",
        atsProvider: "lever"
    },
    // 5 & 6: Remote
    {
        title: "Backend Dev (Fully Remote)",
        location: { name: "Remote" },
        isRemote: true,
        secondaryLocations: [],
        atsProvider: "ashby"
    },
    {
        title: "Frontend Dev (Global)",
        location: { name: "Anywhere" },
        isRemote: false,
        secondaryLocations: [{ name: "Remote" }],
        atsProvider: "ashby"
    },
    // 7 & 8: Multi-location with UK
    {
        title: "Solutions Architect",
        location: { name: "New York" },
        isRemote: false,
        secondaryLocations: [{ name: "Manchester" }],
        atsProvider: "ashby"
    },
    {
        title: "Data Scientist",
        location: { name: "San Francisco" },
        isRemote: false,
        secondaryLocations: [{ name: "Leeds" }],
        atsProvider: "ashby"
    },
    // 9 & 10: Ambiguous
    {
        title: "Recruiter",
        location: "",
        atsProvider: "bamboohr"
    },
    {
        title: "HR Admin",
        location: null,
        atsProvider: "bamboohr"
    }
];

console.log('\n' + '='.repeat(110));
console.log('  UK FILTER DRY-RUN TEST');
console.log('='.repeat(110));
console.log(`${'Job Title'.padEnd(30)} | ${'ATS'.padEnd(12)} | ${'Locations Passed'.padEnd(30)} | ${'Rem?'.padEnd(5)} | ${'Tru?'.padEnd(5)} | ${'Result'}`);
console.log('-'.repeat(110));

for (const j of mockJobs) {
    const atsProvider = j.atsProvider ?? j.source ?? '';
    const adapterKey = `${atsProvider.toLowerCase()}ToJobLocationInput` as keyof typeof Adapters;
    const adapter = Adapters[adapterKey];
    
    const locationInput = adapter 
        ? adapter(j) 
        : { locations: [j.location ?? ''], isRemote: false, isTrustedSource: false };

    const result = isUKJob(locationInput);

    const titleStr = String(j.title).slice(0, 28).padEnd(30);
    const providerStr = String(atsProvider).padEnd(12);
    const locsStr = locationInput.locations.join(', ').slice(0, 28).padEnd(30);
    const remoteStr = (locationInput.isRemote ? 'YES' : 'NO').padEnd(5);
    const trustedStr = (locationInput.isTrustedSource ? 'YES' : 'NO').padEnd(5);
    const finalResult = result ? '✅ INCLUDE' : '❌ EXCLUDE';

    console.log(`${titleStr} | ${providerStr} | ${locsStr} | ${remoteStr} | ${trustedStr} | ${finalResult}`);
}

console.log('='.repeat(110) + '\n');
