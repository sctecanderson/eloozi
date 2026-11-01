// Read-only, redacted configuration audit. Never prints key values or loads dotenv.
import fs from 'node:fs';
const authorized='rzhtndpselxsxgomclzo';
function origin(file){const source=fs.readFileSync(file,'utf8');const raw=source.match(/^\s*VITE_SUPABASE_URL\s*=\s*([^\r\n]+)/m)?.[1].trim().replace(/^["']|["']$/g,'');return raw?new URL(raw).origin:null;}
const config={authorizedProject:authorized,frontendEnvFile:'.env.local',frontendSupabaseOrigin:origin('.env.local'),frontendConfigMatchesTest:origin('.env.local')===`https://${authorized}.supabase.co`,backupFileNotUsed:true,backupPointsToAuthorizedTest:origin('.env.local.backup-testes')===`https://${authorized}.supabase.co`,credentialsPrinted:false};
if(!config.frontendConfigMatchesTest)throw Error('Frontend is not configured for the authorized test project; no remote payment permitted.');
fs.writeFileSync('docs/downgrade-integrated-targets.json',JSON.stringify(config,null,2));console.log(JSON.stringify(config));
