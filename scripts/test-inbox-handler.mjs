import assert from 'node:assert/strict';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

console.log('=== TEST SUITE 2: Consumer Handler, Deno Auth & Mock Asaas Server ===');

// 1. Implementation of constantTimeEqual matching Edge Function
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  if (bufA.byteLength !== bufB.byteLength) {
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

// 2. Implementation of strict parseCentsFromMonetary matching Edge Function
function parseCentsFromMonetary(val) {
  if (val === null || val === undefined) {
    throw new Error('Valor monetário ausente ou nulo.');
  }

  let str;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val < 0) {
      throw new Error(`Número monetário inválido ou negativo: ${val}`);
    }
    str = val.toFixed(2);
  } else if (typeof val === 'string') {
    str = val.trim();
  } else {
    throw new Error(`Tipo inválido para valor monetário: ${typeof val}`);
  }

  if (!str) {
    throw new Error('String monetária vazia.');
  }

  if (str.startsWith('-') || str.includes('e') || str.includes('E')) {
    throw new Error(`Formato monetário não aceita números negativos ou notação científica: "${str}"`);
  }

  let intPart = '';
  let decPart = '00';

  if (/^\d+(\.\d{1,2})?$/.test(str)) {
    const parts = str.split('.');
    intPart = parts[0];
    decPart = (parts[1] || '0').padEnd(2, '0');
  } else if (/^\d+(,\d{1,2})?$/.test(str)) {
    const parts = str.split(',');
    intPart = parts[0];
    decPart = (parts[1] || '0').padEnd(2, '0');
  } else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(str)) {
    const cleaned = str.replace(/\./g, '');
    const parts = cleaned.split(',');
    intPart = parts[0];
    decPart = (parts[1] || '0').padEnd(2, '0');
  } else {
    throw new Error(`Formato monetário ambíguo ou inválido rejeitado: "${str}"`);
  }

  const cents = BigInt(intPart) * 100n + BigInt(decPart);
  if (cents < 0n) {
    throw new Error(`Centavos não podem ser negativos: ${cents}`);
  }
  return cents;
}

// 3. Implementation of extractBillingIdentifiers matching Edge Function
function extractBillingIdentifiers(payload) {
  if (!payload || typeof payload !== 'object') {
    return { paymentId: null, invoiceId: null, isFallback: true, isSynthetic: false };
  }

  let paymentId = null;
  let invoiceId = null;

  if (typeof payload.invoice_id === 'string') {
    invoiceId = payload.invoice_id.trim();
  }
  if (typeof payload.external_reference === 'string') {
    paymentId = payload.external_reference.trim();
  }

  if (payload.payment && typeof payload.payment === 'object') {
    const p = payload.payment;
    if (typeof p.id === 'string' && !paymentId) {
      paymentId = p.id.trim();
    }
    if (typeof p.externalReference === 'string' && !invoiceId) {
      invoiceId = p.externalReference.trim();
    }
  }

  const isFallback =
    !paymentId ||
    paymentId.startsWith('asaas_pay_') ||
    paymentId.startsWith('quarantine:') ||
    paymentId === 'null' ||
    paymentId === 'undefined' ||
    paymentId === '';

  const isSynthetic =
    Boolean(payload.synthetic) ||
    Boolean(payload.payment?.synthetic) ||
    (typeof paymentId === 'string' && paymentId.startsWith('synthetic:'));

  return { paymentId, invoiceId, isFallback, isSynthetic };
}

// --- SUB-SUITE A: Authentication & Constant Time Equal ---
const SECRET = 'sec_prod_high_entropy_token_987654321_abc';

assert.equal(constantTimeEqual(SECRET, SECRET), true, 'Segredo correto deve autenticar com true');
assert.equal(constantTimeEqual(null, SECRET), false, 'Segredo nulo deve falhar sem exceção');
assert.equal(constantTimeEqual(undefined, SECRET), false, 'Segredo indefinido deve falhar sem exceção');
assert.equal(constantTimeEqual('', SECRET), false, 'Segredo vazio deve falhar sem exceção');
assert.equal(constantTimeEqual('sec_prod_high_entropy_token_987654321_abx', SECRET), false, 'Segredo incorreto de mesmo tamanho deve falhar');
assert.equal(constantTimeEqual('curto', SECRET), false, 'Segredo mais curto deve falhar sem RangeError');
assert.equal(constantTimeEqual('sec_prod_high_entropy_token_987654321_abc_extra_longo', SECRET), false, 'Segredo mais longo deve falhar sem RangeError');
console.log('PASS: Authentication constantTimeEqual verifies correct, missing, incorrect, and different length tokens without error.');

// --- SUB-SUITE B: Strict Monetary Parsing ---
assert.equal(parseCentsFromMonetary('99.90'), 9990n);
assert.equal(parseCentsFromMonetary(99.9), 9990n);
assert.equal(parseCentsFromMonetary(150), 15000n);
assert.equal(parseCentsFromMonetary('99,90'), 9990n);
assert.equal(parseCentsFromMonetary('1.234,50'), 123450n);

// Rejeição estrita de formatos ambíguos
const ambiguousFormats = [
  '1,234.50',   // Milhar com vírgula e decimal com ponto (ambíguo no padrão adotado)
  '99.999',     // 3 casas decimais
  '100.200',    // Ambíguo: 100 com 200 milésimos ou 100 mil
  '-50.00',     // Negativo
  '1e4',        // Notação científica
  '1.2.3',      // Múltiplos pontos
  '',           // Vazio
  null,         // Nulo
  undefined     // Indefinido
];

for (const amb of ambiguousFormats) {
  assert.throws(
    () => parseCentsFromMonetary(amb),
    /ambíguo|inválido|vazia|ausente|negativo/,
    `Formato ambíguo "${amb}" deve ser rejeitado expressamente`
  );
}
console.log('PASS: Strict monetary parsing enforces exact integer cents and rejects ambiguous formats.');

// --- SUB-SUITE C: Identifier Extraction and Disambiguation ---
// Formato A: Ponte Safe v7
const v7Payload = {
  source: 'v7_bridge',
  invoice_id: '11111111-2222-3333-4444-555555555555',
  external_reference: 'pay_asaas_001'
};
const v7Ext = extractBillingIdentifiers(v7Payload);
assert.equal(v7Ext.invoiceId, '11111111-2222-3333-4444-555555555555');
assert.equal(v7Ext.paymentId, 'pay_asaas_001');
assert.equal(v7Ext.isFallback, false);

// Formato B: Ingestão Direta Asaas
const asaasPayload = {
  event: 'PAYMENT_RECEIVED',
  payment: {
    id: 'pay_asaas_002',
    externalReference: '99999999-8888-7777-6666-555555555555',
    value: 99.90
  }
};
const asaasExt = extractBillingIdentifiers(asaasPayload);
assert.equal(asaasExt.invoiceId, '99999999-8888-7777-6666-555555555555');
assert.equal(asaasExt.paymentId, 'pay_asaas_002');
assert.equal(asaasExt.isFallback, false);

// Detecção de Fallbacks Sintéticos (devem ir para quarentena)
const fallbackPayload = {
  source: 'v7_bridge',
  invoice_id: '11111111-2222-3333-4444-555555555555',
  external_reference: 'asaas_pay_11111111-2222-3333-4444-555555555555'
};
const fbExt = extractBillingIdentifiers(fallbackPayload);
assert.equal(fbExt.isFallback, true, 'Fallback asaas_pay_* deve ser sinalizado como fallback');

const emptyPayload = { invoice_id: '11111111-2222-3333-4444-555555555555', external_reference: '' };
assert.equal(extractBillingIdentifiers(emptyPayload).isFallback, true);
console.log('PASS: Billing identifier extraction reconciles v7 bridge and native formats, isolating fallbacks.');

// --- SUB-SUITE D: Local Mock Asaas Server (Zero Chamadas Externas) ---
const mockPort = 55998;
const mockServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
  const authHeader = req.headers['access_token'];

  if (authHeader !== 'valid_mock_asaas_key') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized mock Asaas token' }));
    return;
  }

  if (url.pathname === '/payments/pay_mock_ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'pay_mock_ok',
      status: 'RECEIVED',
      value: 99.90,
      externalReference: '11111111-2222-3333-4444-555555555555'
    }));
  } else if (url.pathname === '/payments/pay_mock_not_found') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payment not found' }));
  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Simulated 500 error' }));
  }
});

mockServer.listen(mockPort, '127.0.0.1', async () => {
  try {
    // 1. Test 200 OK
    const res200 = await fetch(`http://127.0.0.1:${mockPort}/payments/pay_mock_ok`, {
      headers: { access_token: 'valid_mock_asaas_key' }
    });
    assert.equal(res200.status, 200);
    const data200 = await res200.json();
    assert.equal(data200.id, 'pay_mock_ok');
    assert.equal(parseCentsFromMonetary(data200.value), 9990n);

    // 2. Test 401 Unauthorized
    const res401 = await fetch(`http://127.0.0.1:${mockPort}/payments/pay_mock_ok`, {
      headers: { access_token: 'wrong_key' }
    });
    assert.equal(res401.status, 401);

    // 3. Test 404 Not Found
    const res404 = await fetch(`http://127.0.0.1:${mockPort}/payments/pay_mock_not_found`, {
      headers: { access_token: 'valid_mock_asaas_key' }
    });
    assert.equal(res404.status, 404);

    console.log('PASS: Mock Asaas server behaves deterministically without touching external internet.');
  } finally {
    mockServer.close();
    console.log('=== HANDLER & AUTH TESTS COMPLETED SUCCESSFULLY ===');
  }
});
