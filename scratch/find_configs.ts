import fs from 'fs';

const content = fs.readFileSync('company_ats_config_rows.sql', 'utf8');
const barclaysMatch = content.match(/\('([^']+)',\s*'1700'[^)]+\)/);
const accentureMatch = content.match(/\('([^']+)',\s*'521'[^)]+\)/);

console.log('Barclays:', barclaysMatch ? barclaysMatch[0] : 'Not found');
console.log('Accenture:', accentureMatch ? accentureMatch[0] : 'Not found');
