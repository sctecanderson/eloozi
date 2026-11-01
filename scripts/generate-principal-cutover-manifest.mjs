// Source-only release manifest; reads private rehearsal evidence without copying its data.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const proof=JSON.parse(fs.readFileSync(path.join(process.argv[2],'restore-review/result.json'),'utf8'));
assert.equal(proof.rehearsal.length,19);assert.equal(proof.final_success,true);assert.equal(proof.cluster_stopped,true);
const entry=file=>{const b=fs.readFileSync(path.join(root,file));return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const migrations=proof.rehearsal.map((r,i)=>{const e=entry('supabase/migrations/'+r.migration);assert.equal(e.sha256,r.sha256,'migration changed after rehearsal: '+r.migration);return {order:i+1,...e};});
const handlers=['asaas-checkout','asaas-webhook'].flatMap(name=>['handler.ts','index.ts'].map(f=>entry('supabase/functions/'+name+'/'+f)));
const result={project_ref:'llhujxzefujdsthpezag',generated_utc:new Date().toISOString(),hash_algorithm:'SHA-256 over exact source bytes; no CRLF normalization',rehearsal_archive_sha256:proof.archive_sha256,migrations,handlers};
fs.writeFileSync(path.join(root,'docs/principal-cutover-manifest-20261031.json'),JSON.stringify(result,null,2)+'\n');
let text='# Ordem e hashes — principal Eloozi\n\nSHA-256 dos bytes exatos, conferido com a evidência do ensaio. Não executar como lote.\n\n| Ordem | Migration | SHA-256 |\n|---:|---|---|\n';
for(const m of migrations)text+=`| ${m.order} | ${path.basename(m.path)} | ${m.sha256} |\n`;
text+='\n## Handlers locais a publicar somente na janela autorizada\n\n| Arquivo | SHA-256 |\n|---|---|\n';for(const h of handlers)text+=`| ${h.path} | ${h.sha256} |\n`;
fs.writeFileSync(path.join(root,'docs/principal-migrations-ordem-hashes-20261031.md'),text);
console.log('MANIFEST_PASS: 19 migration byte hashes match approved rehearsal; 4 handler hashes recorded.');
