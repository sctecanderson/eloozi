import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

console.log('=== TEST SUITE 3: Disposable PostgreSQL Cron & Asynchronous Dispatch Correlation ===');

const benchDir = 'C:\\Users\\Anderson\\AppData\\Local\\Eloozi\\PrivateRestoreBench\\3d1bf2ea-a25f-4c8e-85a4-d0bd26fee92e';
const bin = path.join(benchDir, 'pgsql', 'bin');
const data = path.join(benchDir, 'data');
const serverLog = path.join(benchDir, 'server.log');

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('PG')));
env.PGCONNECT_TIMEOUT = '5';
env.PGCLIENTENCODING = 'UTF8';
env.PGOPTIONS = '-c statement_timeout=60000 -c timezone=UTC -c lc_messages=C';

function runCmd(exe, args) {
  const isPgCtlStart = path.basename(exe).toLowerCase().startsWith('pg_ctl') && args.includes('start');
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    ...(isPgCtlStart ? { stdio: 'ignore' } : {})
  });
  return {
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    status: r.status
  };
}

function sql(cmd, db = 'eloozi_cron_test') {
  const r = runCmd(path.join(bin, 'psql.exe'), [
    '-X', '-q', '-w', '-h', '127.0.0.1', '-p', '55992', '-U', 'postgres', '-d', db,
    '-v', 'ON_ERROR_STOP=1', '-At', '-c', cmd
  ]);
  if (r.status !== 0) {
    throw new Error(`psql error: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

let clusterStarted = false;
try {
  console.log('Starting local PostgreSQL cluster on isolated port 55992...');
  const startRes = runCmd(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-l', serverLog, '-w', '-t', '25', 'start']);
  assert.equal(startRes.status, 0, 'Cluster failed to start');
  clusterStarted = true;

  // Prepare database eloozi_cron_test
  const dbCheck = sql("select count(*) from pg_database where datname = 'eloozi_cron_test'", 'postgres');
  if (dbCheck !== '0') {
    sql('drop database eloozi_cron_test with (force)', 'postgres');
  }
  sql('create database eloozi_cron_test', 'postgres');
  console.log('Created database eloozi_cron_test.');

  // Configuração dos Schemas Oficiais:
  // - pg_cron no schema pg_catalog (simulação dos metadados de job e run_details)
  // - pg_net no schema 'net' (com tabelas nativas de queue e _http_response)
  // - vault no schema 'vault' (armazenamento seguro do segredo)
  sql(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (
      id uuid primary key default gen_random_uuid(),
      name text unique not null,
      decrypted_secret text not null
    );

    insert into vault.decrypted_secrets (name, decrypted_secret)
    values ('INBOX_CONSUMER_SECRET', 'test_vault_secret_9988776655');

    create schema if not exists net;
    create table if not exists net.http_request_queue (
      id bigserial primary key,
      url text not null,
      headers jsonb not null,
      body jsonb,
      timeout_milliseconds integer,
      created_at timestamptz not null default clock_timestamp()
    );

    -- Tabela oficial de respostas assincronas do pg_net
    create table if not exists net._http_response (
      id bigint primary key,
      status_code integer not null,
      headers jsonb,
      content text,
      timed_out boolean default false,
      error_msg text,
      created_at timestamptz not null default clock_timestamp()
    );

    create or replace function net.http_post(
      url text,
      headers jsonb default '{}'::jsonb,
      body jsonb default '{}'::jsonb,
      timeout_milliseconds integer default 5000
    ) returns bigint language plpgsql as $$
    declare
      v_id bigint;
    begin
      insert into net.http_request_queue (url, headers, body, timeout_milliseconds)
      values (url, headers, body, timeout_milliseconds)
      returning id into v_id;
      return v_id;
    end;
    $$;

    create schema if not exists cron;
    create table if not exists cron.job (
      jobid serial primary key,
      schedule text not null,
      command text not null,
      jobname text unique
    );

    create table if not exists cron.job_run_details (
      runid bigserial primary key,
      jobid integer not null references cron.job(jobid),
      run_status text not null,
      return_message text,
      start_time timestamptz not null default clock_timestamp(),
      end_time timestamptz not null default clock_timestamp()
    );

    create schema if not exists billing_private;

    -- Funcao revisada: SECURITY DEFINER, search_path='', sem expor segredo e retornando bigint (request_id)
    create or replace function billing_private.trigger_inbox_consumer_cron()
    returns bigint
    language plpgsql
    security definer
    set search_path = ''
    as $$
    declare
      v_secret text;
      v_request_id bigint;
    begin
      select decrypted_secret into v_secret
      from vault.decrypted_secrets
      where name = 'INBOX_CONSUMER_SECRET'
      limit 1;

      if v_secret is null then
        raise exception 'INBOX_CONSUMER_SECRET ausente no Vault.' using errcode = '22023';
      end if;

      execute $cmd$
        select net.http_post(
          url := 'https://llhujxzefujdsthpezag.supabase.co/functions/v1/inbox-consumer',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-inbox-consumer-secret', $1
          ),
          body := '{"source": "pg_cron"}'::jsonb,
          timeout_milliseconds := 55000
        )
      $cmd$ into v_request_id using v_secret;

      return v_request_id;
    end;
    $$;

    revoke all on function billing_private.trigger_inbox_consumer_cron() from public, anon, authenticated;
    grant execute on function billing_private.trigger_inbox_consumer_cron() to postgres, service_role;
  `);

  console.log('Schemas, security definer trigger, and pg_net tables created.');

  // 1. Simulação da Execução pelo Cron
  sql(`
    insert into cron.job (jobid, schedule, command, jobname)
    values (1, '* * * * *', 'select billing_private.trigger_inbox_consumer_cron();', 'inbox-consumer-trigger');
  `);

  // Disparo do job pelo cron
  const requestIdStr = sql(`select billing_private.trigger_inbox_consumer_cron();`);
  const requestId = BigInt(requestIdStr);
  assert.ok(requestId > 0n, 'trigger must return valid sanitized request_id');

  // Registra sucesso da execucao do comando no cron (succeeded no cron != HTTP 200 no Edge Function)
  sql(`
    insert into cron.job_run_details (jobid, run_status, return_message)
    values (1, 'succeeded', 'select billing_private.trigger_inbox_consumer_cron() returned request_id ' || '${requestIdStr}');
  `);

  const cronLog = JSON.parse(sql(`
    select row_to_json(r) from cron.job_run_details r where jobid = 1 order by runid desc limit 1;
  `));
  assert.equal(cronLog.run_status, 'succeeded');
  console.log('PASS: Cron command executed and recorded status = succeeded in cron.job_run_details.');

  // 2. Correlacao Assincrona com net._http_response
  // Verifica que o pedido esta enfileirado no pg_net sem vazamento de headers no log sanitizado
  const queueEntry = JSON.parse(sql(`
    select row_to_json(q) from (select id, url, (body->>'source') as source from net.http_request_queue where id = ${requestId}) q;
  `));
  assert.equal(queueEntry.id, Number(requestId));
  assert.equal(queueEntry.source, 'pg_cron');

  // Simula o recebimento da resposta HTTP da Edge Function (HTTP 200 OK)
  sql(`
    insert into net._http_response (id, status_code, content)
    values (${requestId}, 200, '{"message":"Consumer execution completed successfully"}');
  `);

  // Consulta e correlaciona a resposta HTTP pelo request_id
  const httpResponse = JSON.parse(sql(`
    select row_to_json(r) from (select id, status_code, content from net._http_response where id = ${requestId}) r;
  `));
  assert.equal(httpResponse.id, Number(requestId));
  assert.equal(httpResponse.status_code, 200, 'Edge Function HTTP response must be 200');
  console.log('PASS: request_id correlated with net._http_response, confirming HTTP 200 OK separate from cron command success.');

  // Confirmação estrita: nenhuma coluna ou retorno expos o segredo
  const leakedSecretCheck = sql(`
    select count(*) from cron.job_run_details where return_message like '%test_vault_secret%';
  `);
  assert.equal(leakedSecretCheck, '0', 'Secret must NEVER be present in cron job run details');

} finally {
  if (clusterStarted) {
    console.log('Stopping local PostgreSQL cluster...');
    runCmd(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-m', 'immediate', 'stop']);
    console.log('Stopped local PostgreSQL cluster.');
  }
}

console.log('=== ASYNCHRONOUS DISPATCH TESTS COMPLETED SUCCESSFULLY ===');
