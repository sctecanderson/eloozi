-- 01_stage3_setup.sql
-- Prepara ambiente para Cenário 3: Drop para receber a migração legada permissiva
drop table if exists public.reservations cascade;
