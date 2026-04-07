-- Tabela para fichas de financiamento enviadas pelo cliente no CRM
-- Executar no Supabase SQL Editor

CREATE TABLE IF NOT EXISTS financiamento_fichas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Veículo selecionado
  veiculo_id       text,
  veiculo_label    text,

  -- Simulação (escolhida pelo cliente)
  tabela_fin       text,       -- 'leve' ou 'pesada'
  valor_financiado numeric,
  coeficiente      text,       -- 'A','B','C','D','Unico'
  num_parcelas     integer,
  valor_parcela    numeric,

  -- Dados Pessoais (campos com * vermelho)
  nome             text NOT NULL,
  nascimento       text NOT NULL,   -- formato dd/mm/yyyy
  mae              text NOT NULL,
  cpf              text NOT NULL,
  ddd_celular      text NOT NULL,
  celular          text NOT NULL,
  cep              text NOT NULL,
  endereco         text NOT NULL,
  num_end          text NOT NULL,
  complemento      text,
  bairro           text NOT NULL,
  cidade           text NOT NULL,
  uf               text NOT NULL,
  moradia          text NOT NULL,   -- 'Própria' ou 'Alugada'
  anos_residencia  integer,

  -- Dados Profissionais (campos com * vermelho)
  empresa          text,
  tempo_emprego    text,
  cep_emp          text,
  endereco_emp     text,
  num_emp          text,
  bairro_emp       text,
  cidade_emp       text,
  uf_emp           text,
  ddd_tel_emp      text,
  tel_emp          text,
  funcao           text,
  renda_bruta      text,

  -- Referências pessoais (campos com * vermelho)
  ref1_nome        text,
  ref1_ddd         text,
  ref1_tel         text,
  ref2_nome        text,
  ref2_ddd         text,
  ref2_tel         text,

  -- Status do envio pelo bot
  status           text DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'processando', 'enviado', 'erro')),
  erro_msg         text,

  created_at       timestamptz DEFAULT now(),
  submitted_at     timestamptz
);

-- Índice para o bot buscar fichas pendentes rapidamente
CREATE INDEX IF NOT EXISTS idx_financiamento_fichas_status
  ON financiamento_fichas (status, created_at);

-- RLS: permite insert pelo anon (cliente no CRM público) e leitura/update pelo service role
ALTER TABLE financiamento_fichas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon pode inserir fichas"
  ON financiamento_fichas FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "service role acesso total"
  ON financiamento_fichas FOR ALL
  TO service_role
  USING (true);

-- Permite que o CRM leia (autenticado)
CREATE POLICY "autenticado pode ler fichas"
  ON financiamento_fichas FOR SELECT
  TO authenticated
  USING (true);
