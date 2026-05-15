import { JobLocationInput } from './ukFilter';

/**
 * ukFilterAdapters.ts — ATS-Specific Data Extractors
 * 
 * Each function takes a raw job object from a specific ATS provider and 
 * maps it to the standard JobLocationInput structure.
 */

// --- Utility ---
function containsRemote(str: string | null | undefined): boolean {
    if (!str) return false;
    return str.toLowerCase().includes('remote');
}

// --- Adapters ---

export function ashbyToJobLocationInput(job: any): JobLocationInput {
    const locs = [
        job.location?.name || job.location,
        ...(job.secondaryLocations || []).map((l: any) => l.location || l.name || l)
    ].filter(Boolean);

    return {
        locations: locs,
        isRemote: !!job.isRemote,
        isTrustedSource: false
    };
}

export function greenhouseToJobLocationInput(job: any): JobLocationInput {
    const locs = new Set<string>();
    if (job.location?.name) locs.add(job.location.name);
    (job.offices || []).forEach((o: any) => {
        if (o.name) locs.add(o.name);
        if (o.location) locs.add(o.location);
    });

    const locations = Array.from(locs).filter(Boolean);
    const isRemote = locations.some(l => containsRemote(l));

    return {
        locations,
        isRemote,
        isTrustedSource: false
    };
}

export function leverToJobLocationInput(job: any): JobLocationInput {
    const loc = job.categories?.location || job.workplaceType || '';
    const tags = (job.tags || []).filter((t: string) => containsRemote(t) || t.length > 2);
    
    return {
        locations: [loc, ...tags].filter(Boolean),
        isRemote: job.workplaceType?.toLowerCase() === 'remote',
        isTrustedSource: false
    };
}

export function workableToJobLocationInput(job: any): JobLocationInput {
    const locData = job.location || job;
    const locations = [
        locData.city,
        locData.state || locData.region,
        locData.country
    ].filter(Boolean);

    return {
        locations,
        isRemote: !!(job.telecommuting || job.remote),
        isTrustedSource: false
    };
}

export function workdayToJobLocationInput(job: any): JobLocationInput {
    const locations = (job.locationsText || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: !!job.verified // Use the existing verified/facetIsTrusted flag
    };
}

export function teamtailorToJobLocationInput(job: any): JobLocationInput {
    const humanLoc = job.attributes?.['human-location'] || job.location || '';
    const locations = humanLoc ? [humanLoc] : [];

    return {
        locations,
        isRemote: containsRemote(humanLoc),
        isTrustedSource: false
    };
}

export function smartrecruitersToJobLocationInput(job: any): JobLocationInput {
    const locations = [
        job.location?.city,
        job.location?.country
    ].filter(Boolean);

    const isRemote = job.typeOfEmployment?.toLowerCase().includes('remote') || 
                     locations.some((l: string) => containsRemote(l));

    return {
        locations,
        isRemote,
        isTrustedSource: false
    };
}

export function pinpointToJobLocationInput(job: any): JobLocationInput {
    const loc = job.location || {};
    const locations = [
        loc.name,
        loc.city,
        loc.province
    ].filter(Boolean);

    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function breezyToJobLocationInput(job: any): JobLocationInput {
    const locName = job.location?.name || '';
    return {
        locations: locName ? [locName] : [],
        isRemote: containsRemote(locName),
        isTrustedSource: false
    };
}

export function recruiteeToJobLocationInput(job: any): JobLocationInput {
    const locations = [job.location, job.city].filter(Boolean);
    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function bamboohrToJobLocationInput(job: any): JobLocationInput {
    const loc = job.location || {};
    const locations = [
        loc.city || job.city,
        loc.state || job.state,
        loc.country || job.country
    ].filter(Boolean);

    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function jobviteToJobLocationInput(job: any): JobLocationInput {
    const loc = job.location || '';
    return {
        locations: loc ? [loc] : [],
        isRemote: containsRemote(loc),
        isTrustedSource: false
    };
}

export function personioToJobLocationInput(job: any): JobLocationInput {
    const locations = [job.office, job.location].filter(Boolean);
    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function hibobToJobLocationInput(job: any): JobLocationInput {
    const locations = [job.site, job.country].filter(Boolean);
    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function icimsToJobLocationInput(job: any): JobLocationInput {
    const locations = [job.location, job.JobLocation].filter(Boolean);
    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function ripplingToJobLocationInput(job: any): JobLocationInput {
    const locs = new Set<string>();
    (job.locations || []).forEach((l: any) => {
        if (l.name) locs.add(l.name);
        if (l.city) locs.add(l.city);
    });
    const locations = Array.from(locs).filter(Boolean);

    return {
        locations,
        isRemote: locations.some((l: string) => containsRemote(l)),
        isTrustedSource: false
    };
}

export function nhsToJobLocationInput(job: any): JobLocationInput {
    return {
        locations: job.location ? [job.location] : [],
        isRemote: false,
        isTrustedSource: true
    };
}
