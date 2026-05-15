export {};

async function findUK() {
    const slug = 'globalhr';
    const board = 'REC_RTX_Ext_Gateway';
    const apiUrl = `https://globalhr.wd5.myworkdayjobs.com/wday/cxs/${slug}/${board}/jobs`;

    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' })
    });
    
    if (res.ok) {
        const data: any = await res.json();
        const matches: any[] = [];

        function traverse(obj: any, path: string) {
            if (obj && typeof obj === 'object') {
                if (obj.descriptor && (obj.descriptor.includes('United Kingdom') || obj.descriptor === 'United Kingdom')) {
                    matches.push({ path, descriptor: obj.descriptor, id: obj.id });
                }
                for (const key in obj) {
                    traverse(obj[key], `${path}.${key}`);
                }
            } else if (Array.isArray(obj)) {
                obj.forEach((item, i) => traverse(item, `${path}[${i}]`));
            }
        }

        traverse(data, 'root');
        console.log('Matches:', JSON.stringify(matches, null, 2));
    }
}

findUK().catch(console.error);
