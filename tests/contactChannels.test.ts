import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contactUrl, visibleContactUrls, parseContactChannels, type ContactChannels} from '../src/features/restaurants/contactChannels.ts';
import {brandForeground} from '../src/features/theme/brandContrast.ts';
test('canais: vazio/invalido nunca cria link; protocolos inseguros rejeitados',()=>{
 for(const k of ['instagram','whatsapp','facebook'] as const)for(const value of ['', ' ', 'javascript:alert(1)','https://user:pass@example.com'])assert.equal(contactUrl(k,value),null);
 assert.equal(contactUrl('whatsapp','(11) 99999-9999'),'https://wa.me/11999999999');
 assert.equal(contactUrl('instagram','@elozi'),'https://instagram.com/elozi');
 assert.equal(contactUrl('facebook','example.com'),'https://example.com/');
});
test('desativar preserva valor e recarga/reativacao reflete no cardapio',()=>{
 const cfg:ContactChannels={instagram:{value:'@elozi',enabled:true},whatsapp:{value:'',enabled:true},facebook:{value:'https://example.com',enabled:true}};
 assert.ok(visibleContactUrls(cfg).instagram);
 cfg.instagram.enabled=false;
 const loaded=parseContactChannels(JSON.parse(JSON.stringify(cfg)))!;
 assert.equal(loaded.instagram.value,'@elozi');assert.equal(visibleContactUrls(loaded).instagram,null);
 assert.equal(visibleContactUrls(loaded).whatsapp,null);
 loaded.instagram.enabled=true;assert.ok(visibleContactUrls(loaded).instagram);
});
test('contraste da cor primaria seleciona preto ou branco para AA',()=>{
 assert.equal(brandForeground('#610000'),'#ffffff');assert.equal(brandForeground('#FFFFFF'),'#000000');
 for(let n=0;n<=255;n++){const hex='#'+n.toString(16).padStart(2,'0').repeat(3);const c=n/255;const l=c<=.04045?c/12.92:((c+.055)/1.055)**2.4;const ratio=brandForeground(hex)==='#ffffff'?1.05/(l+.05):(l+.05)/.05;assert.ok(ratio>=4.5);}
});
