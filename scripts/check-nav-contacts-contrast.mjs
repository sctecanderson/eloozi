// Measures browser-computed colors exported by the local UI bench, not CSS names.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const transfer = v => v <= .0031308 ? 12.92*v : 1.055*Math.pow(Math.max(0,v),1/2.4)-.055;
function color(s) {
  if (s.startsWith('rgb')) {
    const n=s.match(/[\d.]+/g).map(Number); return [n[0]/255,n[1]/255,n[2]/255,n[3]??1];
  }
  if (s.startsWith('okl')) {
    const n=s.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi).map(Number);
    const [L,x,y,alpha=1]=n;
    const a=s.startsWith('oklch')?x*Math.cos(y*Math.PI/180):x;
    const b=s.startsWith('oklch')?x*Math.sin(y*Math.PI/180):y;
    const l=(L+.3963377774*a+.2158037573*b)**3;
    const m=(L-.1055613458*a-.0638541728*b)**3;
    const t=(L-.0894841775*a-1.291485548*b)**3;
    return [4.0767416621*l-3.3077115913*m+.2309699292*t,-1.2684380046*l+2.6097574011*m-.3413193965*t,-.0041960863*l-.7034186147*m+1.707614701*t].map(v=>Math.max(0,Math.min(1,transfer(v)))).concat(alpha);
  }
  throw new Error('Unsupported computed color: '+s);
}
const blend=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3])).concat(1);
const lum=c=>c.slice(0,3).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
const out=[]; let failed=0;
for(const theme of ['light','dark']){
 const data=JSON.parse(fs.readFileSync(path.join(root,`docs/nav-contacts-measurements-${theme}.json`),'utf8'));
 out.push(`${theme}: viewport ${data.width}x${data.height}; scrollWidth=${data.scrollWidth}`);
 for(const row of data.rows){
  const localBg=row.bgChain.reduce((bg,s)=>blend(color(s),bg),[1,1,1,1]);
  const parentBg=row.bgChain.slice(0,-1).reduce((bg,s)=>blend(color(s),bg),[1,1,1,1]);
  const opacity=Number(row.opacity);
  const bg=blend(localBg.slice(0,3).concat(opacity),parentBg);
  const fg=blend(blend(color(row.fg),localBg).slice(0,3).concat(opacity),parentBg); const value=ratio(fg,bg);
  // Inactive controls are exempt from WCAG 1.4.3; still report their ratio.
  const disabled=row.selector.includes(':disabled');
  const threshold=row.threshold??(row.selector.endsWith('svg')?3:4.5);
  const pass=disabled||value>=threshold;
  if(!pass)failed++;
  out.push(`${pass?'PASS':'FAIL'} ${row.selector} ${row.label}: ${value.toFixed(2)}:1 ${disabled?'(inactive control, exempt)':`(required ${threshold})`}`);
  if(row.border && row.placeholder){
   const border=ratio(color(row.border),bg);
   const placeholder=ratio(color(row.placeholder),bg);
   if(border<3||placeholder<4.5)failed++;
   out.push(`${border>=3&&placeholder>=4.5?'PASS':'FAIL'} control border ${border.toFixed(2)}:1; placeholder ${placeholder.toFixed(2)}:1`);
  }
 }
}
out.push(`RESULT: ${failed===0?'PASS':'FAIL'}; ${failed} failed measurements. This is a sample, not a whole-app AA certification.`);
fs.writeFileSync(path.join(root,'docs/nav-contacts-ratios.log'),out.join('\n')+'\n');
console.log(out.join('\n')); if(failed)process.exitCode=1;
