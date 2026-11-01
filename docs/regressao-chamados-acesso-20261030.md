# Regressão de chamados, acesso e navegação

Atualizado em 30/10/2026 (America/Sao_Paulo). Diagnóstico local e leitura remota limitada ao Supabase de testes autorizado `rzhtndpselxsxgomclzo`. Nenhuma escrita remota, migration, deploy ou alteração de permissão nesta tarefa.

## Diagnóstico observado

- O `.env.local` e o marcador local do Supabase CLI apontam para o ref autorizado; nenhum segredo foi exibido. O CLI não estava disponível, portanto o marcador foi apenas conferido.
- Logs do projeto de testes mostraram cancelamentos SQLSTATE `57014`: quatro consultas de `service_requests`, cerca de trinta chamadas a `get_table_tab_consumption`, além de uma listagem de itens e uma chamada a `get_public_restaurant`. Também houve um 504 de Auth. Os logs não oferecem contexto suficiente para vincular cada erro a um usuário ou rota.
- No snapshot de `pg_stat_statements`, as formas de consulta da lista de chamados tiveram médias aproximadas de 23 ms (máximo 1,27 s) e 21 ms (máximo 172 ms). A RPC `get_table_tab_consumption` teve 184 chamadas acumuladas, média de 860 ms e máximo de 7,75 s. `get_public_restaurant` teve 2.280 chamadas, média de 62 ms e máximo de 5,95 s. Esses agregados não provam qual chamada causou cada cancelamento.
- `service_requests` tinha cinco linhas estimadas, `table_tab_items` 31; na leitura atual não havia lock waiter. Esse retrato não exclui lock histórico, mas não sustenta uma alteração de índice ou aumento de timeout.
- Foram inspecionados definição de `get_table_tab_consumption`, políticas RLS e índices. RLS estava habilitada e as políticas de leitura de chamados verificavam vínculo ativo e restaurante ativo. A consulta não retornou uma negativa de permissão correspondente ao erro relatado.

## Causa demonstrada no cliente e ajuste

`StaffChamadosContext` disparava leituras por montagem, confirmação inicial do Realtime, alterações em qualquer item, eventos Auth, reconexão, foco e retorno online. Cada leitura buscava KDS e chamados; `requestIdRef` descartava respostas antigas somente depois de as consultas já chegarem ao banco. Eventos de item em preparação podiam, portanto, reler a mesma fila sem alterá-la.

Foi adicionado um coordenador de recarga que serializa chamadas concorrentes e agrupa uma rajada em uma recarga posterior. Alterações em `table_tab_items` agora atualizam a fila somente quando o item entra em `ready`, sai de `ready` ou chega a `delivered`. Eventos `INITIAL_SESSION` e `TOKEN_REFRESHED` não reiniciam essa lista, pois a carga inicial e a sessão existente já cobrem esses casos.

O guard de acesso também coalesce verificações concorrentes e deixa de consultar novamente a cada renovação de token. Resposta sem restaurante/membro continua sendo `denied`; erro de consulta continua erro. SQLSTATE `57014` e HTTP 504 agora são apresentados como verificação temporariamente lenta, com acesso explicitamente não declarado como negado e retry manual disponível. Nenhuma permissão ou fallback de acesso foi ampliado.

Timeout da consulta de chamados recebe mensagem amigável que distingue falha temporária de ausência de vínculo. A fixture que cobre essa consulta foi corrigida para simular os dois filtros `.in()` reais (antes simulava `.eq()` e caía em exceção de mock).

## Guards e navegação Admin/KDS

`/admin` e `/admin/kds` ficam sob o mesmo `RequireStaffAccess requiredRole="admin"`; uma falha de consulta vai para estado de erro/retry, e somente retorno sem sessão/vínculo vai para a rota de acesso. Não há `Navigate`/redirect entre Admin e KDS. A busca de `navigate` em `KdsPage` encontrou somente saída explícita após confirmação de PIN/senha, para `/admin`. A alternância relatada não foi reproduzida; sua causa visual continua dependente de navegador.

## Verificações executadas

- `node --experimental-strip-types --loader ./tests/test_loader.mjs --test tests/chamados.test.ts tests/staffProfiles.test.ts` — passou, 37/37; inclui timeout, serialização de refresh e filtro de eventos relevantes.
- `npm.cmd test` — exit 0: 267 aprovados, 4 skips preexistentes, 0 falhas.
- `npm.cmd run typecheck` — exit 0.
- `npm.cmd run build` — exit 0.
- Nenhuma alteração SQL foi necessária, portanto não foi iniciado PostgreSQL descartável nesta correção.

## Validação pendente de navegador

O navegador automatizado permanece indisponível por interrupção de segurança anterior. Não foi contornado nem usado para declarar integração visual aprovada. Faça a conferência manual usando duas sessões autenticadas distintas no ambiente de teste autorizado:

1. Abra `/[slug]/equipe/chamados` em uma sessão de garçom e `/[slug]/admin/kds` em sessão de administrador. No Network, conte chamadas `service_requests` e confirme que abrir a fila produz carga inicial e, após `SUBSCRIBED`, no máximo uma reconciliação; itens `preparing` não devem disparar novas cargas da fila.
2. Navegue entre Admin e KDS; verifique que a rota não alterna sozinha. Simule/aguarde timeout de leitura e confirme mensagem temporária com retry, sem redirecionamento a `/acesso`.
3. Confirme que uma negativa real de vínculo ainda redireciona para acesso e que garçom sem cargo admin continua bloqueado do KDS.

A execução integrada de navegador e a associação de cada timeout histórico à rota permanecem pendentes. O ajuste reduz chamadas redundantes demonstradas no cliente; não afirma eliminar picos do servidor na RPC de consumo de comanda.
