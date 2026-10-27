# Roteiro de Teste de Concorrência — RPC `seat_table_reservation`

Este roteiro descreve o procedimento manual, controlado e reproduzível para auditar a segurança contra condições de corrida (race conditions) da função transacional `public.seat_table_reservation` utilizando duas sessões simultâneas de banco de dados (`psql` ou abas concorrentes do editor SQL).

> **Atenção:** Execute este roteiro exclusivamente em ambiente local de teste ou container isolado. Nunca aplique dados sintéticos ou testes no banco de produção remoto.

---

## 1. Princípio da Concorrência e Modelo de Bloqueio

A RPC `seat_table_reservation` utiliza bloqueio pessimista em nível de linha (*Row-Level Lock*) direcionado estritamente à reserva informada:
```sql
SELECT * INTO v_target_row
FROM public.reservations
WHERE id = p_reservation_id
  AND restaurant_id = p_restaurant_id
FOR UPDATE;
```

### Garantias do Modelo:
1. **ID Estritamente Obrigatório:** Não há seleção automática de registros no banco. Cada chamada transita um único registro de reserva explícito.
2. **Serialização por ID:** Se duas requisições tentarem atender simultaneamente a **mesma reserva** (mesmo ID), a primeira adquire o bloqueio da linha e transita o status para `seated`. A segunda transação aguarda e, ao ser desbloqueada, detecta que a reserva já foi atendida, retornando `ALREADY_SEATED` de forma idempotente e segura.
3. **Independência de Reservas da Mesma Mesa:** Se a Mesa 10 possuir **duas reservas distintas** agendadas (ex.: Reserva A às 19:30 e Reserva B às 21:30), o atendimento da Reserva A bloqueia e atualiza apenas a linha da Reserva A. A Reserva B permanece livre, destravada e em status `confirmed`.

---

## 2. Preparação do Cenário de Teste

Abra uma sessão administrativa e execute a configuração inicial:

```sql
BEGIN;

-- 1. Restaurante de Teste
INSERT INTO public.restaurants (id, name, slug, timezone)
VALUES ('11111111-1111-1111-1111-111111111111', 'Restaurante Concorrência Test', 'conc-test', 'America/Sao_Paulo')
ON CONFLICT (id) DO UPDATE SET timezone = 'America/Sao_Paulo';

-- 2. Mesa 10 Ativa
INSERT INTO public.restaurant_tables (id, restaurant_id, table_number, active)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 10, true)
ON CONFLICT DO NOTHING;

-- 3. Garçom Ativo
INSERT INTO auth.users (id, email)
VALUES ('33333333-3333-3333-3333-333333333333', 'garcom-conc@test.com')
ON CONFLICT DO NOTHING;

INSERT INTO public.restaurant_members (restaurant_id, user_id, role, active)
VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'waiter', true)
ON CONFLICT DO NOTHING;

-- 4. Limpeza prévia e criação de DUAS reservas ativas na mesma Mesa 10 para hoje
DELETE FROM public.reservations WHERE restaurant_id = '11111111-1111-1111-1111-111111111111';

-- Reserva A (Mesa 10, Turno 1)
INSERT INTO public.reservations (
  id, restaurant_id, table_number, customer_name, phone,
  date, time, status, guests_count, origin_id
) VALUES (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  10,
  'Cliente A (Turno 1)',
  '11999990001',
  (now() at time zone 'America/Sao_Paulo')::date,
  '19:30',
  'confirmed',
  4,
  'test-conc-res-a'
);

-- Reserva B (Mesa 10, Turno 2 - mesma mesa, cliente diferente)
INSERT INTO public.reservations (
  id, restaurant_id, table_number, customer_name, phone,
  date, time, status, guests_count, origin_id
) VALUES (
  '55555555-5555-5555-5555-555555555555',
  '11111111-1111-1111-1111-111111111111',
  10,
  'Cliente B (Turno 2)',
  '11999990002',
  (now() at time zone 'America/Sao_Paulo')::date,
  '21:30',
  'confirmed',
  2,
  'test-conc-res-b'
);

COMMIT;
```

---

## 3. Teste Concorrente 1: Disputa Simultânea Pelo Mesmo ID de Reserva

Simula dois garçons clicando ao mesmo tempo para acomodar a **Reserva A** (`44444444-4444-4444-4444-444444444444`).

### Passo 1: Sessão 1 inicia a transação e trava a Reserva A
No Terminal 1:
```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
SET LOCAL "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}';

SELECT public.seat_table_reservation(
  '11111111-1111-1111-1111-111111111111'::uuid,
  10::smallint,
  '44444444-4444-4444-4444-444444444444'::uuid
);
-- NÃO EXECUTE COMMIT AINDA. O lock de linha da Reserva A está retido.
```

### Passo 2: Sessão 2 tenta confirmar a mesma Reserva A
No Terminal 2:
```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
SET LOCAL "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}';

SELECT public.seat_table_reservation(
  '11111111-1111-1111-1111-111111111111'::uuid,
  10::smallint,
  '44444444-4444-4444-4444-444444444444'::uuid
);
-- Comportamento esperado no Terminal 2: Fica BLOQUEADO aguardando a liberação do lock da Reserva A.
```

### Passo 3: Sessão 1 conclui e Sessão 2 é liberada
No Terminal 1:
```sql
COMMIT;
```

**Resultado Esperado no Terminal 1:**
- `success`: `true`
- `code`: `'SEATED_SUCCESS'`
- `reservation.status`: `'seated'`

**Resultado Esperado no Terminal 2 (ao ser desbloqueado imediatamente após o COMMIT do Terminal 1):**
- `success`: `false`
- `code`: `'ALREADY_SEATED'`
- `reservation.status`: `'seated'`
- `message`: `'Esta reserva já foi marcada como atendida anteriormente.'`

No Terminal 2:
```sql
COMMIT;
```

---

## 4. Teste Concorrente 2: Confirmação Concorrente com Cancelamento (Cenário B)

Valida a disputa concorrente entre o atendimento de uma reserva pelo garçom e o cancelamento simultâneo pelo administrador:

### Passo 1: Sessão 1 inicia atendimento e retém lock de linha
No Terminal 1:
```sql
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
SET LOCAL "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}';

SELECT public.seat_table_reservation(
  '11111111-1111-1111-1111-111111111111'::uuid,
  10::smallint,
  '66666666-6666-6666-6666-666666666666'::uuid
);
-- Mantém a transação aberta por alguns segundos sem commit.
```

### Passo 2: Sessão 2 tenta cancelar a mesma reserva
No Terminal 2:
```sql
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '11111111-0000-0000-0000-111111111111';
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-0000-0000-0000-111111111111","role":"authenticated","is_anonymous":false}';

-- O UPDATE bloqueia aguardando o lock exclusivo da linha retido pela Sessão 1:
UPDATE public.reservations
SET status = 'cancelled'
WHERE id = '66666666-6666-6666-6666-666666666666'
  AND status in ('confirmed', 'agendada', 'reservada');
```

### Passo 3: Sessão 1 comita
No Terminal 1:
```sql
COMMIT;
```

**Resultado:**
- A Sessão 1 conclui com `SEATED_SUCCESS`.
- A Sessão 2 é liberada imediatamente: avalia a nova versão da linha (`status = 'seated'`), não encontra linhas correspondentes ao predicado `status in ('confirmed', ...)`, atualizando 0 linhas de forma segura, ou atualiza para cancelado se for cancelamento forçado administrativo. Em qualquer caso, não há deadlocks nem anomalias transacionais.

No Terminal 2:
```sql
COMMIT;
```

---

## 5. Teste Concorrente 3: Duas Reservas Simultâneas na Mesma Mesa

Valida a independência de duas reservas na Mesa 10. Enquanto a Sessão 1 atende a Reserva A, a Sessão 2 atende a Reserva B.

### Procedimento:
1. Terminal 1 atende a Reserva A (`44444444-4444-4444-4444-444444444444`).
2. Terminal 2 atende a Reserva B (`55555555-5555-5555-5555-555555555555`).

### Verificação do Estado Final no Banco:
```sql
SELECT id, table_number, customer_name, status
FROM public.reservations
WHERE restaurant_id = '11111111-1111-1111-1111-111111111111'
ORDER BY time ASC;
```

**Resultado Esperado:**
- Reserva A: `seated`.
- Reserva B: transita para `seated` independentemente, sem colisão de locks indevidos.

---

## 6. Limpeza do Ambiente de Teste

Execute para expurgar todos os registros sintéticos de teste:
```sql
BEGIN;
DELETE FROM public.reservations WHERE restaurant_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM public.restaurant_members WHERE restaurant_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM public.restaurant_tables WHERE restaurant_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM public.restaurants WHERE id = '11111111-1111-1111-1111-111111111111';
DELETE FROM auth.users WHERE id in ('33333333-3333-3333-3333-333333333333', '11111111-0000-0000-0000-111111111111');
COMMIT;
```
