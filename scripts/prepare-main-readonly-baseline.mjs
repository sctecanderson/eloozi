// Generate only local fingerprints and a read-only comparison query; no network or DB writes.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const work=path.resolve(process.argv[2]);const dir=path.join(work,'restore-review');
const hash=s=>crypto.createHash('md5').update(s).digest('hex');
const schema=fs.readFileSync(path.join(dir,'archive-schema.sql'),'utf8').replace(/\r/g,'');
const lines=fs.readFileSync(path.join(dir,'archive-data.sql'),'utf8').replace(/\r/g,'').split('\n');
const literal=s=>"'"+s.replaceAll("'","''")+"'";
let current;const tables=[];
for(const line of lines){if(!current){const m=line.match(/^COPY (.+) \((.+)\) FROM stdin;$/);if(m)current={table:m[1],columns:m[2],rows:[]};}else if(line==='\\.'){tables.push(current);current=null;}else current.rows.push(line);}
const queries=[],baseline=[];
for(const t of tables){
 const def=schema.match(new RegExp('CREATE TABLE '+t.table.replaceAll('.','\\.')+' \\(([\\s\\S]*?)\\n\\);'))?.[1]??'';
 const expressions=t.columns.split(', ').map(col=>{
  assert.match(col,/^"?[a-zA-Z0-9_]+"?$/);
  const bool=new RegExp('^    '+col+' boolean\\b','m').test(def);
  let expr=bool?`case when ${col} then 't' else 'f' end`:`${col}::text`;
  expr=`replace(${expr},chr(92),chr(92)||chr(92))`;
  for(const [code,letter]of [[8,'b'],[9,'t'],[10,'n'],[11,'v'],[12,'f'],[13,'r']])expr=`replace(${expr},chr(${code}),chr(92)||'${letter}')`;
  return `case when ${col} is null then chr(92)||'N' else ${expr} end`;
 });
 queries.push(`select ${literal(t.table)} as relation,count(*)::bigint as rows,md5(coalesce(string_agg(line,chr(10) order by line collate "C"),'')) as copy_md5 from (select ${expressions.join('||chr(9)||')} as line from ${t.table}) q`);
 const rows=t.rows.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 baseline.push({relation:t.table,rows:rows.length,copy_md5:hash(rows.join('\n'))});
}
const funcs=[];
const markers=[...schema.matchAll(/^-- Name: (.*); Type: FUNCTION; Schema: (.*); Owner: (.*)$/gm)];
for(const m of markers){const start=schema.indexOf('CREATE FUNCTION ',m.index),end=schema.indexOf('\n--\n-- Name:',start);const ddl=schema.slice(start,end<0?undefined:end);const body=ddl.match(/\bAS (\$[^$]*\$)([\s\S]*?)\1/);assert.ok(body,'unparsed function '+m[1]);const header=ddl.slice(0,body.index);const settings=[...header.matchAll(/^\s*SET (\w+) TO (.+)$/gm)].map(s=>{const values=[...s[2].matchAll(/'((?:[^']|'')*)'/g)].map(x=>x[1].replaceAll("''","'"));return s[1]+'='+(values.length===1&&values[0]===''?'""':values.join(', '));});funcs.push({schema:m[2],identity:m[1],body_md5:hash(body[2]),owner:m[3],security_definer:/SECURITY DEFINER/.test(header),volatility:/\bIMMUTABLE\b/.test(header)?'i':/\bSTABLE\b/.test(header)?'s':'v',settings:settings.sort()});}
function clause(ddl,label){const start=ddl.indexOf(label+' (');if(start<0)return null;let depth=0,quote=false;const begin=start+label.length+2;for(let i=begin;i<ddl.length;i++){const ch=ddl[i];if(ch==="'"){if(quote&&ddl[i+1]==="'"){i++;continue;}quote=!quote;}if(quote)continue;if(ch==='(')depth++;if(ch===')'){if(depth===0)return ddl.slice(begin,i);depth--;}}throw new Error('unterminated policy clause');}
const policies=[...schema.matchAll(/^CREATE POLICY (\S+) ON (\S+)[\s\S]*?;$/gm)].map(m=>{const ddl=m[0];const roleMatch=ddl.match(/\bTO (.*?)(?= USING | WITH CHECK |;)/s);return {policyname:m[1],relation:m[2],permissive:ddl.includes('AS RESTRICTIVE')?'RESTRICTIVE':'PERMISSIVE',roles:(roleMatch?roleMatch[1].split(',').map(s=>s.trim().replaceAll('"','').replace(/^PUBLIC$/,'public')):['public']).sort(),cmd:ddl.match(/\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)\b/)?.[1]??'ALL',qual:clause(ddl,'USING'),with_check:clause(ddl,'WITH CHECK')};});
const readQuery="begin isolation level repeatable read read only; set local statement_timeout='15s'; set local timezone='UTC'; set local datestyle='ISO, MDY'; set local bytea_output='hex';\n"+queries.join('\nunion all\n')+';\ncommit;';
fs.writeFileSync(path.join(dir,'main-readonly-comparison.sql'),readQuery);
const relations=[...schema.matchAll(/^-- Name: (.*); Type: TABLE; Schema: (.*); Owner: (.*)$/gm)].map(m=>({relation:m[2]+'.'+m[1],owner:m[3],rls:new RegExp('ALTER TABLE (?:ONLY )?'+(m[2]+'.'+m[1]).replaceAll('.','\\.')+' ENABLE ROW LEVEL SECURITY;').test(schema)}));
fs.writeFileSync(path.join(dir,'main-readonly-baseline.json'),JSON.stringify({tables:baseline,functions:funcs,policies,relations}));
console.log('LOCAL_BASELINE_READY tables='+baseline.length+' functions='+funcs.length+'; no source rows printed');
