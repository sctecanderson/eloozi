
## Backup exportado: integridade e bloqueio da restauração — 31/10/2026

Nesta execução, metadata protegido foi lido e o dump original localizado pelo campo backup_file_name. SHA-256 calculado CONFERE: 9176bd202f2ca47cde5fc90f0d04814bc37d669c7e371465a7cc47aef815c26d. Projeto no metadata llhujxzefujdsthpezag; servidor e ferramentas 17.11. Original preservado. pg_restore --schema-only terminou exit 0; schema extraído ficou na pasta privada do backup, fora de Git/ZIPs.

Inspeção inicial encontrou extensões pg_stat_statements, pgcrypto, supabase_vault e uuid-ossp. supabase_vault e pg_net não estão disponíveis no diretório local de extensões. Referências textuais a pg_net, HTTP, cron e event triggers exigem classificação completa; não equivalem a tarefas ativas comprovadas. Nenhuma definição sensível foi publicada.

BLOQUEIO CONCRETO antes da restauração: token Windows sem privilégios administrativos, inclusive pela execução escalada disponível (ADMIN_TOKEN=False). MpsSvc está Running e New-NetFirewallRule existe, mas não foi possível estabelecer previamente a barreira de saída de rede exigida. Listen loopback não impede chamadas externas iniciadas por funções/triggers e não foi tratado como isolamento de saída. Nenhuma regra do Windows foi alterada; nenhum cluster foi iniciado, portanto não há cluster desta rodada para encerrar.

Próximo passo: sessão Windows efetivamente administrativa para configurar/verificar bloqueio temporário de saída do executável D:\pgSQL\bin\postgres.exe, preservando comunicação loopback necessária e com remoção garantida em finally; alternativamente bancada já isolada de rede. Não relaxar ACL do backup. Depois terminar inspeção de TOC/schema e dados de tarefas, documentar adaptação das dependências gerenciadas, restaurar em cluster privado descartável, comparar dados/objetos/RLS/grants/histórico e só então ensaiar individualmente o plano docs/plano-atualizacao-principal-local-20261031.md com snapshots privados antes/depois. Encerrar e remover cópia restaurada no finally.

Restauração e ensaio sobre este backup NÃO executados; recuperação NÃO comprovada. Contagens da origem não constam do metadata: comparação origem/clone no mesmo snapshot ainda não disponível. Backup PostgreSQL não cobre Storage binário, configuração Auth externa ao banco, roles globais/senhas, secrets/deploy Edge ou configuração da plataforma. Sem consultas remotas, Asaas, migrations, deploy, commit ou push nesta rodada. Os testes sintéticos antigos não foram repetidos nem apresentados como restauração atual.

Atualizacao: a restauracao e o ensaio posteriores foram concluidos com adaptacoes. Consulte docs/restore-ensaio-principal-20261031.md para o resultado atual; os bloqueios acima sao historicos.
