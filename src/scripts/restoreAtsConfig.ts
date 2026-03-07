import { supabase } from '../lib/supabase';

function extractToken(provider: string, endpoint: string): string | null {
    if (!endpoint) return null;
    if (!endpoint.startsWith('http')) return endpoint;

    try {
        const url = new URL(endpoint);

        switch (provider) {
            case 'greenhouse': {
                const match = endpoint.match(/\/boards\/([^\/]+)/);
                if (match) return match[1];
                break;
            }
            case 'lever': {
                const match = endpoint.match(/\/postings\/([^\/\?]+)/);
                if (match) return match[1];
                break;
            }
            case 'workable': {
                const match = endpoint.match(/\/accounts\/([^\/]+)/);
                if (match) return match[1];
                if (url.hostname.includes('apply.workable.com') && url.pathname.startsWith('/j/')) return endpoint;
                break;
            }
            case 'workday': {
                const match = endpoint.match(/\/cxs\/([^\/]+)\/([^\/]+)/);
                if (match) return `${match[1]}/${match[2]}`;
                break;
            }
            case 'smartrecruiters': {
                const match = endpoint.match(/smartrecruiters\.com\/([^\/]+)/);
                if (match) return match[1];
                break;
            }
            case 'teamtailor': {
                if (url.hostname.endsWith('teamtailor.com')) return url.hostname.split('.')[0];
                return url.hostname;
            }
            case 'pinpoint': {
                if (url.hostname.endsWith('pinpointhq.com')) return url.hostname.split('.')[0];
                break;
            }
            case 'bamboohr': {
                if (url.hostname.endsWith('bamboohr.com')) return url.hostname.split('.')[0];
                break;
            }
            case 'breezy': {
                if (url.hostname.endsWith('breezy.hr')) return url.hostname.split('.')[0];
                break;
            }
            case 'recruitee': {
                if (url.hostname.endsWith('recruitee.com')) return url.hostname.split('.')[0];
                break;
            }
        }
    } catch (e) {
        return endpoint;
    }

    return endpoint;
}

async function restoreAtsConfig() {
    console.log("Fetching data from company_ats_config...");

    let allConfigs: any[] = [];
    let offset = 0;

    while (true) {
        const { data: configs, error: fetchError } = await supabase
            .from('company_ats_config')
            .select('company_id, ats_provider, api_endpoint')
            .eq('is_active', true)
            .range(offset, offset + 999);

        if (fetchError) {
            console.error("Error fetching configs:", fetchError);
            return;
        }

        if (!configs || configs.length === 0) break;

        allConfigs = allConfigs.concat(configs);
        console.log(`Fetched ${allConfigs.length} config rows...`);

        if (configs.length < 1000) break;
        offset += 1000;
    }

    if (allConfigs.length === 0) {
        console.log("No configs found!");
        return;
    }

    console.log(`Found a total of ${allConfigs.length} active configs. Beginning restoration...`);

    let successCount = 0;

    for (const config of allConfigs) {
        let provider = config.ats_provider;
        let token = extractToken(provider, config.api_endpoint);

        if (provider?.startsWith('greenhouse_')) provider = 'greenhouse';
        if (provider?.startsWith('workable_')) provider = 'workable';

        const { error: updateError } = await supabase
            .from('companies')
            .update({
                ats_provider: provider,
                ats_board_token: token
            })
            .eq('id', config.company_id);

        if (updateError) {
            console.error(`Error updating company ID ${config.company_id}:`, updateError);
        } else {
            successCount++;
            if (successCount % 100 === 0) console.log(`Restored ${successCount} / ${allConfigs.length} companies...`);
        }
    }

    console.log(`\n--- Restoration Complete ---`);
    console.log(`Successfully updated ATS mapping for ${successCount} companies.`);
}

restoreAtsConfig();
