-- ============================================================
-- MotoRide — CRM como Centro de Comando (versão corrigida)
-- USAR VIA FERRAMENTA DE MIGRAÇÃO DO LOVABLE (não rodar direto)
-- ============================================================

-- 1. bot_configs: adiciona tipo, agendamento e heartbeat
ALTER TABLE bot_configs
  ADD COLUMN IF NOT EXISTS bot_type          text DEFAULT 'messaging',
  ADD COLUMN IF NOT EXISTS schedule_time     time,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_at       timestamptz;

-- 2. stock_vehicles: campo para mapear o ID local do bot (v1, v2, ...)
ALTER TABLE stock_vehicles
  ADD COLUMN IF NOT EXISTS local_bot_id text;

-- 3. clients: vínculo com veículo + flag de intervenção manual
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS vehicle_id    uuid REFERENCES stock_vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_label text,
  ADD COLUMN IF NOT EXISTS requires_human boolean DEFAULT false;

-- 4. bot_posting_queue: fila de veículos para postagem
CREATE TABLE IF NOT EXISTS bot_posting_queue (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    uuid        REFERENCES stock_vehicles(id) ON DELETE CASCADE,
  local_bot_id  text,
  status        text        DEFAULT 'pending',
  scheduled_for timestamptz,
  posted_at     timestamptz,
  error_msg     text,
  created_at    timestamptz DEFAULT now()
);

-- 5. RLS restrito — bot acessa APENAS via Edge Function (service_role)
--    Anon nunca lê direto; authenticated (CRM logado) pode ler

ALTER TABLE bot_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bot_read_config" ON bot_configs;
CREATE POLICY "authenticated_read_config" ON bot_configs
  FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_posting_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bot_read_queue" ON bot_posting_queue;
CREATE POLICY "authenticated_manage_queue" ON bot_posting_queue
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
