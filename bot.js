const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const log  = require('./modules/logger');
const https = require('https');
const { execFile } = require('child_process');

// ── Config ───────────────────────────────────────────────
const DRY_RUN      = process.env.DRY_RUN === 'true';
const TEMP_MIDIA   = path.join(__dirname, 'temp_midia');
const MAX_POR_CICLO = parseInt(process.env.MAX_POR_CICLO  || '5', 10);
const DELAY_MIN    = parseInt(process.env.DELAY_MIN_MS    || '2000', 10);
const DELAY_MAX    = parseInt(process.env.DELAY_MAX_MS    || '7000', 10);
const CDP_PORT     = process.env.CDP_PORT || '9222';
const BOT_ID       = process.env.BOT_ID   || 'facebook1';
const BOT_NAME     = process.env.BOT_NAME || (BOT_ID === 'facebook2' ? 'Facebook 2 — 49998351418' : 'Facebook 1 — barcaroariela@gmail.com');

// ── Claude ───────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── CRM (Lovable Edge Functions) ─────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_SECRET_TOKEN  = process.env.BOT_SECRET_TOKEN;

// ── Telegram ──────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Chama uma Edge Function do Lovable via HTTPS
async function chamarEdgeFunction(nome, body) {
  if (!SUPABASE_URL || !BOT_SECRET_TOKEN) {
    log.warn(`[EdgeFn] ${nome} — SUPABASE_URL ou BOT_SECRET_TOKEN não definidos`);
    return null;
  }
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${SUPABASE_URL}/functions/v1/${nome}`);
    const headers = {
      'Content-Type': 'application/json',
      'x-bot-token': BOT_SECRET_TOKEN,
      'Content-Length': Buffer.byteLength(data),
    };
    // Inclui headers de autenticação Supabase para funcionar mesmo com JWT ativado
    if (SUPABASE_ANON_KEY) {
      headers['apikey']        = SUPABASE_ANON_KEY;
      headers['Authorization'] = `Bearer ${SUPABASE_ANON_KEY}`;
    }
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers,
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          log.warn(`[EdgeFn] ${nome} — HTTP ${res.statusCode} | body: ${raw.slice(0, 300)}`);
        }
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', (e) => {
      log.warn(`[EdgeFn] ${nome} — erro de rede: ${e.message}`);
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

// ── Telegram — notificações ──────────────────────────────
function notificarTelegram(mensagem) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensagem, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => { res.resume(); });
  req.on('error', (e) => log.warn(`[Telegram] Falha ao notificar: ${e.message}`));
  req.write(data);
  req.end();
}

// ── Supabase REST API — POST/UPSERT ─────────────────────
async function supabaseRestPost(tabela, body, upsertColuna) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const qs   = upsertColuna ? `?on_conflict=${upsertColuna}` : '';
    const url  = new URL(`${SUPABASE_URL}/rest/v1/${tabela}${qs}`);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer':        'return=representation,resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          log.warn(`[REST POST] ${tabela} — HTTP ${res.statusCode} | ${raw.slice(0, 200)}`);
        }
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { log.warn(`[REST POST] ${tabela} — erro: ${e.message}`); resolve(null); });
    req.write(data);
    req.end();
  });
}

// ── Supabase REST API — veículos ─────────────────────────
async function supabaseRestGet(caminho) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return new Promise((resolve) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${caminho}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function mapearVeiculoSupabase(row) {
  return {
    id:             row.local_id,
    tipo:           row.tipo || 'moto',
    loja:           row.loja || 'MotoRide',
    marca:          row.marca,
    modelo:         row.modelo,
    modeloMkt:      row.modelo_mkt || row.modelo,
    versao:         row.versao || '',
    ano:            String(row.ano),
    cor:            row.cor,
    quilometragem:  String(row.quilometragem || 0),
    preco:          String(row.preco || 0),
    estadoMecanico: row.estado_mecanico || '',
    estadoEstetico: row.estado_estetico || '',
    diferenciais:   row.diferenciais || '',
    aceitaTroca:    row.aceita_troca !== false,
    financiamento:  row.financiamento || 'aprovação facilitada, inclusive negativados',
    observacoes:    row.observacoes || '',
    carroceria:     row.carroceria || null,
    corExterna:     row.cor_externa || row.cor || '',
    corInterna:     row.cor_interna || null,
    condicao:       row.condicao || 'Excelente',
    combustivel:    row.combustivel || 'Flex',
    cambio:         row.cambio || '',
    pastaFotos:     row.pasta_fotos || '',
    documento:      row.documento || '100% em dia, transferência imediata',
    transfere:      row.transfere || 'sim',
    status:         row.status || 'ativo',
    ultimaPostagem: row.ultima_postagem || null,
    audio_url:      row.audio_url || null,
    video_url:      row.video_url || null,
  };
}

// Carrega veículos do Supabase (fonte principal) com fallback para JSON local
async function carregarVeiculosSupabase() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const rows = await supabaseRestGet('veiculos?status=eq.ativo&order=local_id.asc');
    if (Array.isArray(rows) && rows.length > 0) {
      const result = {};
      for (const row of rows) {
        const v = mapearVeiculoSupabase(row);
        result[v.id] = v;
      }
      return result;
    }
  }
  log.warn('[Veículos] Supabase indisponível — usando data/vehicles.json local');
  return loadJSON(VEHICLES_FILE);
}

// Lê configuração do bot via Edge Function (service_role interno — RLS seguro)
async function lerConfiguracaoCRM() {
  if (!SUPABASE_URL || !BOT_SECRET_TOKEN) return null;
  const result = await chamarEdgeFunction('bot-get-config', { bot_id: BOT_ID, bot_type: 'messaging' });
  if (!result) return null;
  const data = result.config || result;
  if (!data || !data.bot_id) return null;
  return { ...data, is_active: data.is_active ?? data.ativo };
}

// Envia heartbeat ao CRM — CRM sabe que o bot está vivo
async function enviarHeartbeat(configId) {
  if (!SUPABASE_URL || !BOT_SECRET_TOKEN || !configId) return;
  await chamarEdgeFunction('bot-heartbeat', {
    bot_id:    BOT_ID,
    config_id: configId,
    bot_type:  'messaging',
    timestamp: new Date().toISOString(),
  });
}

// ── Extrai número de WhatsApp de uma mensagem ────────────
function extrairWhatsApp(texto) {
  if (!texto) return null;
  // Tenta múltiplos padrões em ordem de especificidade
  const padroes = [
    /\+?55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/,   // +55 (49) 99951-5791
    /\(?\d{2}\)?\s?9\d{4}[-\s]?\d{4}/,              // (49) 99951-5791
    /\(?\d{2}\)?\s?\d{4}[-\s]?\d{4}/,               // (49) 9951-5791
    /\b\d{10,11}\b/,                                  // 49999515791
  ];
  for (const p of padroes) {
    const match = texto.match(p);
    if (!match) continue;
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) continue;
    // Ignora os números da própria loja para não salvar como WhatsApp do cliente
    if (digits.includes('998351418') || digits.includes('999515791')) continue;
    return digits;
  }
  return null;
}

// ── Classifica o lead com base no histórico da conversa ──────────────────────
function classificarLead(historico, telefone) {
  const clienteTextos = (historico || []).filter(m => m.de === 'cliente').map(m => m.texto).join(' ');
  if (telefone) return 'WhatsApp captado';
  const temFinanc = /\bfinanc\b/i.test(clienteTextos);
  const temTroca  = /\b(troca|trocar)\b/i.test(clienteTextos);
  const temVista  = /\b(à vista|avista|dinheiro|pix)\b/i.test(clienteTextos);
  const temSimul  = /\b(simul|calcul|parcela|prestação)\b/i.test(clienteTextos);
  if (temFinanc && temTroca) return 'Quer financiamento + Tem troca';
  if (temFinanc) return 'Quer financiamento';
  if (temVista)  return 'À vista';
  if (temTroca)  return 'Tem troca';
  if (temSimul)  return 'Quer simulação';
  return 'Interesse inicial';
}

// ── Cria/atualiza lead no CRM via REST direto na tabela leads ────────────────
async function sincronizarLeadCRM(convId, compradorNome, veiculo, historico, telefone) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;

  const nomeReal      = compradorNome.replace(/_/g, ' ').replace(/\d+/g, '').trim() || 'Lead Marketplace';
  const interesse     = veiculo ? `Comprar ${veiculo.marca} ${veiculo.modelo} ${veiculo.ano}` : 'comprar moto';
  const classificacao = classificarLead(historico, telefone);
  const sellerNome    = { facebook1: 'Jhow', facebook2: 'João', facebook3: 'Lucas', facebook4: 'Bruna' }[BOT_ID] || BOT_ID;
  const notas         = historico
    ? `[Marketplace ${sellerNome}] Classificação: ${classificacao}\n` + historico.slice(-10).map(m => `${m.de === 'eu' ? 'Vendedor' : 'Cliente'}: ${m.texto}`).join('\n')
    : null;

  const payload = {
    nome:                nomeReal,
    telefone:            telefone || null,
    interesse,
    source:              'marketplace-facebook',
    notas,
    conv_id:             convId,
    bot_id:              BOT_ID,
    local_vehicle_id:    veiculo?.id || null,
    veiculo_desejado_desc: veiculo ? `${veiculo.marca} ${veiculo.modelo} ${veiculo.ano}` : null,
    classificacao,
    status:              'novo',
    ultimo_contato:      new Date().toISOString(),
  };

  // Upsert direto na tabela leads — resolve conflito por conv_id
  const result = await supabaseRestPost('leads', payload, 'conv_id');
  if (!result || (result.code && result.message)) {
    log.warn(`[CRM] Falha ao salvar lead: ${result?.message || 'sem resposta'} | ${JSON.stringify(result||{}).slice(0,300)}`);
    return null;
  }

  // result=[] significa que o Supabase salvou mas RLS bloqueia o SELECT de retorno
  // Nesse caso considera sucesso e usa convId como referência
  const row = Array.isArray(result) ? result[0] : result;
  const clientId = row?.id || convId;
  log.ok(`[CRM] Lead salvo: ${nomeReal} → ${clientId}`);
  return clientId;
}

// ── Arquivos de dados ────────────────────────────────────
const VEHICLES_FILE = path.join(__dirname, 'data', 'vehicles.json');
const LEADS_FILE    = path.join(__dirname, 'data', `leads-${BOT_ID}.json`);

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Utilitários ──────────────────────────────────────────

// Delay aleatório entre DELAY_MIN e DELAY_MAX ms
function delayAleatorio() {
  const ms = Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
  return new Promise(r => setTimeout(r, ms));
}

// Fingerprint normalizado: ignora maiúsculas, espaços extras, pontuação irrelevante
function fingerprint(msg) {
  return (msg || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


async function responderFallback(veiculo, historico, mensagem) {
  const v = veiculo;
  const hist = historico || [];
  const nMsgsCliente = hist.filter(m => m.de === 'cliente').length;
  const nomeVeiculo = `${v.marca} ${v.modeloMkt || v.modelo} ${v.ano}`;

  // Mensagem de voz — pede para mandar em texto
  if (mensagem === '[áudio]') {
    return `Vi que você mandou um áudio, mas aqui no chat não consigo ouvir. Pode me contar em texto o que quer saber sobre o ${nomeVeiculo}?`;
  }

  // Foto enviada pelo cliente — direciona para WhatsApp do cliente (sem enviar nosso número)
  if (mensagem === '[foto]') {
    return `Vi que você mandou uma foto. Me passa seu WhatsApp que o especialista te chama por lá e consegue analisar certinho.`;
  }

  // ── Analisa TODO o contexto disponível, incluindo a mensagem atual ──────────
  const clienteTextos = hist.filter(m => m.de === 'cliente').map(m => m.texto).join(' ') + ' ' + mensagem;

  const temForma      = /\b(financ|à vista|avista|troca|trocar|entrada|dinheiro|pix|boleto|parcel)\b/i.test(clienteTextos);
  const telCliente    = extrairWhatsApp(clienteTextos);
  const temWppCliente = telCliente !== null;

  // Detecta sinais de desistência/desinteresse do cliente
  const clienteDesistiu = /\b(n[aã]o (tenho|quero|vou|consigo)|desisti|mudei de ideia|j[aá] comprei|n[aã]o preciso|obrigad[oa] n[aã]o|t[aá] caro|muito caro|acima do (meu )?pre[çc]o|n[aã]o tenho grana|sem dinheiro|n[aã]o vou poder)\b/i.test(mensagem);

  if (clienteDesistiu) {
    return `Tudo bem, sem problema! Se mudar de ideia ou quiser ver outro veículo, é só chamar.`;
  }

  // Detecta se pedimos WhatsApp e o cliente ainda não deu
  const ultimaNossa = [...hist].reverse().find(m => m.de === 'eu');
  const pedimosWpp = ultimaNossa && /whatsapp|wpp|zap|número|numero/i.test(ultimaNossa.texto);
  const clienteNaoDeuNumero = pedimosWpp && !temWppCliente;

  const temTroca  = /\b(troca|trocar)\b/i.test(clienteTextos);
  const temFinanc = /\bfinanc/i.test(clienteTextos);
  const querOutros = /\b(outros?|tem (mais|outros?)|ver (mais|outros?)|outro (carro|moto|veículo)|mais (carro|moto|opç))\b/i.test(mensagem);
  const querParcelas = /\b(simul|calcul|quanto fica|parcela|prestação|quanto por mês|quanto sai)\b/i.test(mensagem);

  // ── Monta instrução adaptada ao estágio real da conversa ────────────────────
  let instrucao;
  if (nMsgsCliente === 0) {
    // ETAPA 1: Primeiro contato — confirmar disponibilidade, engajar brevemente. SEM pedir WhatsApp.
    instrucao = `PRIMEIRO CONTATO. Confirme que o veículo está disponível${temTroca ? ' e que aceita troca' : ''}. Apresente o veículo de forma breve e convidativa. Máximo 2 frases curtas. NÃO peça WhatsApp ainda. NÃO peça a cidade.`;
  } else if (temWppCliente) {
    // WhatsApp capturado — confirmar e encerrar
    instrucao = `O cliente já passou o WhatsApp (${telCliente}). Confirme que o especialista vai chamar por lá e encerre de forma simpática. 1 frase apenas. NÃO peça mais nada.`;
  } else if (querParcelas) {
    // Quer saber de parcelas — confirmar financiamento e conduzir para WhatsApp
    instrucao = `Cliente quer saber de parcelas/simulação. Diga que a aprovação é facilitada inclusive para negativados. Conduza para o WhatsApp do cliente: "Me passa seu WhatsApp que o especialista te chama e passa certinho as condições." Máximo 2 frases. NÃO mencione links ou nosso telefone.`;
  } else if (querOutros) {
    // Quer ver outros veículos — conduzir para WhatsApp
    instrucao = `Cliente quer ver outros veículos. Diga que temos outras opções. Conduza para o WhatsApp do cliente: "Me passa seu WhatsApp que o pessoal te chama e mostra o que temos disponível." Máximo 2 frases. NÃO mencione links ou nosso telefone.`;
  } else if (clienteNaoDeuNumero) {
    // Já pedimos WhatsApp, não deu — insistir levemente, sem pressão
    instrucao = `Já pedimos o WhatsApp e o cliente não passou. Reforce de forma natural e leve, sem pressão. 1 frase. NÃO mencione links ou nosso telefone.`;
  } else if (nMsgsCliente === 1 && !temForma) {
    // ETAPA 2: Segunda interação — responder a dúvida e mencionar pontos comerciais. Ainda sem pedir WPP.
    instrucao = `Responda a dúvida do cliente sobre o veículo.${v.aceitaTroca ? ' Mencione que aceita troca mediante avaliação.' : ''} Mencione que fazemos financiamento facilitado inclusive para negativados. Máximo 2 frases. NÃO peça WhatsApp ainda. NÃO mencione links ou nosso telefone.`;
  } else {
    // ETAPA 3: 2+ interações ou cliente já demonstrou intenção — conduzir para WhatsApp
    const contextoPagamento = temFinanc
      ? 'Confirme que fazemos financiamento facilitado, inclusive para negativados. '
      : temTroca ? 'Confirme que aceita troca mediante avaliação. ' : '';
    instrucao = `${contextoPagamento}Conduza a conversa para captar o WhatsApp do cliente: "Me passa seu WhatsApp que o especialista te chama e passa certinho as condições." Máximo 2 frases. NÃO mencione links ou nosso telefone.`;
  }

  const BOT_VENDEDOR = { facebook1: 'Jhow', facebook2: 'João', facebook3: 'Lucas', facebook4: 'Bruna' }[BOT_ID] || 'João';

  const system = `Você é ${BOT_VENDEDOR}, vendedor da MotoRide em Curitibanos-SC. Tom natural, humano, direto — sem parecer robô, sem emojis, sem asteriscos, sem textos longos.

VEÍCULO EM NEGOCIAÇÃO:
- ${v.marca} ${v.modeloMkt || v.modelo} ${v.versao || ''} ${v.ano}
- Preço: R$ ${Number(v.preco).toLocaleString('pt-BR')}
- KM: ${v.quilometragem}
- Cor: ${v.cor}
- Mecânica: ${v.estadoMecanico}
- Estética: ${v.estadoEstetico}
- Diferenciais: ${v.diferenciais}
- Aceita troca: ${v.aceitaTroca ? 'sim, mediante avaliação' : 'não'}
- Financiamento: aprovação facilitada, inclusive negativados
${v.observacoes ? '- Obs: ' + v.observacoes : ''}

OBJETIVO: Engajar o cliente → Apresentar o produto → Captar o WhatsApp para o especialista dar continuidade.
PRIORIDADE MÁXIMA: conseguir o número do cliente. Tudo mais é secundário.

REGRAS ABSOLUTAS:
- Máximo 2 frases por resposta
- Nunca fazer mais de 1 pergunta por vez
- NÃO repita perguntas que o cliente já respondeu — leia o histórico
- NÃO peça WhatsApp se o cliente já passou o número
- NUNCA mencione ou sugira outro veículo que não seja o listado acima — fale APENAS do veículo desta conversa
- NUNCA use o nome do cliente na resposta se ele não se apresentou no histórico — não invente nomes
- Não inventar informações do veículo que não estejam no briefing acima
- Nunca usar emojis, asteriscos ou markdown
- PROIBIDO mencionar qualquer link, URL ou endereço de site
- PROIBIDO mencionar nosso número de telefone — APENAS peça o número DO CLIENTE
- PROIBIDO mencionar valor de parcela, prestação ou simulação numérica
- PROIBIDO escrever mensagens de status como "Aguardando...", "Verificando...", "Processando..." — escreva APENAS a mensagem direta ao cliente

INSTRUÇÃO PARA ESTA MENSAGEM: ${instrucao}`;

  const msgs = hist.slice(-12).map(m => ({ role: m.de === 'eu' ? 'assistant' : 'user', content: m.texto }));
  msgs.push({ role: 'user', content: mensagem });

  const res = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system,
    messages: msgs
  });
  let resposta = res.content[0].text.trim()
    .replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/[🏍🚗🚙🏎🤝👍👋🔥💪✅📱🙌]/gu, '')
    .trim();

  // Filtro de segurança: remove qualquer URL que tenha escapado
  resposta = resposta.replace(/https?:\/\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
  // Filtro de segurança: remove número de telefone da loja que possa ter escapado
  resposta = resposta.replace(/\(49\)\s*9\d[\d\s.\-]{6,}/g, '').replace(/\b49\s*9\d{8,9}\b/g, '').replace(/\s{2,}/g, ' ').trim();

  // Filtro de segurança: descarta mensagens de status geradas por engano pelo Claude
  if (/^aguardando\s+(o\s+)?whatsapp|^aguardando\s+resposta|^verificando|^processando/i.test(resposta)) {
    log.warn(`[bot] Resposta de status detectada e descartada: "${resposta.substring(0, 80)}"`);
    return null;
  }

  return resposta;
}

async function responder(veiculo, historico, mensagem) {
  return responderFallback(veiculo, historico, mensagem);
}

function responderForaDeEstoque(vehicleHint) {
  const mencionado = vehicleHint ? vehicleHint.trim() : 'esse veículo';
  return `Infelizmente o ${mencionado} não está mais disponível no momento. Me passa seu WhatsApp que verificamos o que temos disponível e pode te atender.`;
}

// ── Verifica se deve enviar follow-up (cliente sumiu após nossa resposta) ──────
function deveFollowUp(lead) {
  if (!lead.ultimaAtividade) return false;
  if (!lead.historico || lead.historico.length === 0) return false;
  if (lead.followUpEnviado) return false; // já mandamos follow-up nesse silêncio

  // Última mensagem do histórico deve ser nossa (esperando resposta do cliente)
  const ultimaNoHistorico = lead.historico[lead.historico.length - 1];
  if (ultimaNoHistorico.de !== 'eu') return false;

  const horasPassadas = (Date.now() - new Date(lead.ultimaAtividade).getTime()) / 3600000;
  if (horasPassadas < 4)  return false; // aguarda pelo menos 4h
  if (horasPassadas > 48) return false; // depois de 48h não faz mais sentido

  return true;
}

// ── Gera mensagem de follow-up baseada no histórico da negociação ─────────────
async function gerarFollowUp(veiculo, historico) {
  const v = veiculo;
  const ultimas = (historico || []).slice(-10);
  const conversa = ultimas
    .map(m => `${m.de === 'eu' ? 'João' : 'Cliente'}: ${m.texto}`)
    .join('\n');

  const vendedor = { facebook1: 'Jhow', facebook2: 'João', facebook3: 'Lucas', facebook4: 'Bruna' }[BOT_ID] || 'João';
  const res = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `Você é ${vendedor}, vendedor da MotoRide. Veículo: ${v.marca} ${v.modeloMkt || v.modelo} ${v.ano}, R$${Number(v.preco).toLocaleString('pt-BR')}.

O cliente sumiu. Escreva 1 frase curta e natural de follow-up, sem emoji, sem pressão. Se mencionar contato, APENAS peça o WhatsApp do cliente — NUNCA mencione nosso número de telefone nem links. Português informal.

Conversa:
${conversa}

Follow-up (1 frase apenas):`
    }]
  });
  let followUpText = res.content[0].text.trim()
    .replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/[🏍🚗🚙🏎🤝👍👋🔥💪✅📱]/gu, '')
    .trim();
  // Filtro de segurança: remove links e telefone da loja que possam ter escapado
  followUpText = followUpText
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\(49\)\s*9\d[\d\s.\-]{6,}/g, '')
    .replace(/\b49\s*9\d{8,9}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return followUpText;
}

// ── Lê mensagens recebidas do painel ────────────────────
async function lerMensagens(page) {
  return page.evaluate(() => {
    const painel = document.querySelector('[role="main"]');
    if (!painel) return [];

    const LIXO = ['Pesquisar','Marketplace','Tudo','Não lidas','Grupos','Conversas',
      'Enter','Curtir','Responder','Hoje','Ontem','Segunda','Terça','Quarta',
      'Quinta','Sexta','Sábado','Domingo','Novo Messenger',
      'Silenciar','Arquivar','Excluir','Denunciar','Bloquear','Ver perfil',
      'Marcar como não lida','Ativo agora','Ativo recentemente'];

    const msgs = [];
    for (const el of painel.querySelectorAll('[dir="auto"]')) {
      const txt = el.textContent?.trim() || '';
      if (txt.length < 3 || txt.length > 500) continue;
      if (LIXO.includes(txt)) continue;
      if (/^\d{1,2}:\d{2}/.test(txt)) continue;
      if (/\d{1,2} de \w+ de \d{4}/.test(txt)) continue;
      if (txt.includes('Mensagem enviada') || txt.includes('Você abriu')) continue;
      if (txt.includes('avaliar um ao outro') || txt.includes('anúncio')) continue;
      if (txt.includes('Meta Business') || txt.includes('Restaurar')) continue;
      if (el.closest('[contenteditable]') || el.closest('[role="button"]')) continue;

      let minha = false;
      let n = el;
      for (let i = 0; i < 10; i++) {
        n = n?.parentElement;
        if (!n || n.tagName === 'BODY') break;
        const lbl = (n.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.includes('enviada') || lbl.includes('você')) { minha = true; break; }
        if (window.getComputedStyle(n).marginLeft === 'auto') { minha = true; break; }
      }
      if (!minha) msgs.push(txt);
    }
    return [...new Set(msgs)];
  });
}

// ── Lê mensagens da conversa (funciona no messenger.com página inteira e popup) ─
async function lerMensagensPopup(page) {
  return page.evaluate(() => {
    const UI = new Set([
      'Marketplace','Ver comprador','Mais opções','Marcar como pendente',
      'Mensagem enviada','comprador','Ativo agora','Ativo recentemente',
      'Você enviou','Bloqueou','Denunciar','Silenciar','Venda',
      'Ver perfil do comprador','Personalizar conversa','Membros da conversa',
      'Mídia, arquivos e links','Privacidade e suporte','Pesquisar'
    ]);

    const clienteMsgs = [];
    const todasMsgs = [];
    const seen = new Set();

    // Pega o input para saber onde está a área de digitação (filtro de altura)
    const input = document.querySelector('[contenteditable="true"][role="textbox"]');
    const inputTop = input ? input.getBoundingClientRect().top : window.innerHeight;

    // Escopa APENAS ao painel principal — exclui o sidebar do inbox que contém
    // linhas de outras conversas ("Susan · Fazer 150") que seriam lidas como msgs do cliente
    const painelPrincipal = document.querySelector('[role="main"]') || document.body;

    for (const el of painelPrincipal.querySelectorAll('[dir="auto"]')) {
      const rect = el.getBoundingClientRect();
      // Ignora elementos abaixo da área de digitação ou fora da tela
      if (rect.top >= inputTop) continue;
      if (rect.width < 10 || rect.height < 10) continue;

      const txt = el.textContent?.trim() || '';
      if (txt.length < 2 || txt.length > 600) continue;
      if (seen.has(txt)) continue;
      seen.add(txt);
      if (UI.has(txt)) continue;
      if (/R\$[\d.,]+\s*[—–]/.test(txt)) continue;        // linha de preço do anúncio
      if (/^\d{1,2}:\d{2}/.test(txt)) continue;           // hora
      if (/^\d{1,2} de \w+/.test(txt)) continue;          // data
      if (/^(segunda|terça|quarta|quinta|sexta|sábado|domingo|hoje|ontem)$/i.test(txt)) continue;
      if (el.closest('[role="button"]') || el.closest('[contenteditable]')) continue;
      // Filtra notificações do sistema ("X e outras N pessoas enviaram a você mensagens")
      if (/enviaram a você|pessoas enviaram|não lida/i.test(txt)) continue;
      if (/^\s*não lida/i.test(txt)) continue;
      if (/nova notifica[cç][aã]o/i.test(txt)) continue;

      // ── Detecta se é mensagem NOSSA ──────────────────────────────────────────
      let minha = false;
      let n = el;
      for (let i = 0; i < 15; i++) {
        n = n?.parentElement;
        if (!n || n.tagName === 'BODY') break;
        const lbl = (n.getAttribute('aria-label') || '').toLowerCase();
        // aria-label "Você: texto" ou "enviada" → nossa
        if (lbl.startsWith('você:') || lbl.includes('enviada') || lbl.includes('você enviou')) {
          minha = true; break;
        }
        const st = window.getComputedStyle(n);
        if (st.marginLeft === 'auto') { minha = true; break; }
        if (st.alignSelf === 'flex-end') { minha = true; break; }
        if (st.justifyContent === 'flex-end') { minha = true; break; }
      }
      // Fallback posicional: nossa mensagem fica bem à direita (>70% da tela)
      // Threshold alto para evitar marcar mensagens template do cliente como nossas
      if (!minha && rect.left > window.innerWidth * 0.7) minha = true;

      todasMsgs.push({ de: minha ? 'eu' : 'cliente', texto: txt });
      if (!minha) clienteMsgs.push(txt);
    }

    // ── Detecta mensagens de voz/áudio DO CLIENTE ───────────────────────────────
    // Usa a mesma lógica de detecção de "nossa mensagem" que o bloco de texto acima:
    // percorre os elementos pai procurando aria-label ou CSS que indiquem mensagem enviada.
    const temAudio = Array.from(document.querySelectorAll(
      'audio, [aria-label*="mensagem de voz"], [aria-label*="voice message"], [aria-label*="Reproduzir"], [aria-label*="Play"]'
    )).some(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top >= inputTop || rect.top <= 0) return false;

      // Percorre pais para detectar se é mensagem nossa (mesmo padrão das msgs de texto)
      let n = el;
      for (let i = 0; i < 15; i++) {
        n = n?.parentElement;
        if (!n || n.tagName === 'BODY') break;
        const lbl = (n.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.startsWith('você:') || lbl.includes('enviada') || lbl.includes('você enviou')) {
          return false; // é nossa mensagem — ignorar
        }
        const st = window.getComputedStyle(n);
        if (st.marginLeft === 'auto' || st.alignSelf === 'flex-end' || st.justifyContent === 'flex-end') {
          return false; // é nossa mensagem — ignorar
        }
      }
      // Fallback posicional: se o play button está muito à direita, provavelmente é nosso
      if (rect.left > window.innerWidth * 0.65) return false;

      return true; // é áudio do cliente
    });
    // Adiciona [áudio] se: sem msgs de texto OU última msg do cliente foi há muito tempo (áudio mais recente)
    const ultimaClienteTxt = clienteMsgs[clienteMsgs.length - 1];
    if (temAudio && (!ultimaClienteTxt || ultimaClienteTxt === '[áudio]')) {
      if (!ultimaClienteTxt) {
        clienteMsgs.push('[áudio]');
        todasMsgs.push({ de: 'cliente', texto: '[áudio]' });
      }
    } else if (temAudio && clienteMsgs.length > 0) {
      // Áudio presente junto com texto: pode ser o mais recente — mantém como última msg
      const ultimaGlobal = todasMsgs[todasMsgs.length - 1];
      if (!ultimaGlobal || ultimaGlobal.de === 'eu') {
        clienteMsgs.push('[áudio]');
        todasMsgs.push({ de: 'cliente', texto: '[áudio]' });
      }
    }

    return { clienteMsgs, todasMsgs };
  });
}

// ── Envia mensagem (ou simula em DRY_RUN) ────────────────
async function enviar(page, texto) {
  if (DRY_RUN) {
    log.dry(`[simulado] "${texto}"`);
    return true;
  }

  const input = await page.$('[contenteditable="true"][role="textbox"]');
  if (!input) {
    log.warn('Campo de texto não encontrado');
    return false;
  }

  await input.click();
  await page.waitForTimeout(400);
  await input.type(texto, { delay: 30 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  return true;
}

// ── Download de mídia do Supabase Storage (timeout 60s) ──────────────────────
async function baixarMidia(url, destino) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.dirname(destino))) {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
    }

    let resolvido = false;
    const fim = (ok) => { if (!resolvido) { resolvido = true; resolve(ok); } };

    const timer = setTimeout(() => {
      log.warn(`[baixarMidia] Timeout 60s — abortando: ${path.basename(destino)}`);
      fim(false);
    }, 60_000);

    const supabaseHost = SUPABASE_URL ? new URL(SUPABASE_URL).hostname : null;

    const fazDownload = (urlStr, tentativa) => {
      const parsedUrl = new URL(urlStr);
      // Inclui auth do Supabase apenas para o host do projeto (não para redirects externos)
      const ehSupabase = supabaseHost && parsedUrl.hostname === supabaseHost;
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      if (ehSupabase && SUPABASE_ANON_KEY) {
        headers['apikey']        = SUPABASE_ANON_KEY;
        headers['Authorization'] = `Bearer ${SUPABASE_ANON_KEY}`;
      }
      const opts = {
        hostname: parsedUrl.hostname,
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'GET',
        headers,
      };
      const req = https.request(opts, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && tentativa < 3) {
          return fazDownload(res.headers.location, tentativa + 1);
        }
        if (res.statusCode !== 200) { res.resume(); clearTimeout(timer); return fim(false); }
        const out = fs.createWriteStream(destino);
        res.pipe(out);
        out.on('finish', () => { out.close(); clearTimeout(timer); fim(true); });
        out.on('error',  () => { clearTimeout(timer); fim(false); });
      });
      req.on('error', () => { clearTimeout(timer); fim(false); });
      req.end();
    };

    fazDownload(url, 0);
  });
}

// ── Envia arquivo via Playwright no Messenger ─────────────────────────────────
async function enviarArquivo(page, caminhoLocal) {
  if (DRY_RUN) {
    log.dry(`[simulado] enviar arquivo: ${path.basename(caminhoLocal)}`);
    return true;
  }
  try {
    const nomeArq = path.basename(caminhoLocal);
    log.info(`[enviarArquivo] Tentando anexar: ${nomeArq}`);

    // Procura input[type="file"] — no Messenger geralmente já está no DOM oculto
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Clica no botão de clipe para expor o input
      const btnAnexo = await page.$('[aria-label="Attach a file"], [aria-label="Annexer un fichier"], [aria-label*="Anexar"], [aria-label*="nexo"]');
      if (btnAnexo) {
        log.info('[enviarArquivo] Clicando no botão de anexo...');
        await btnAnexo.click();
        await page.waitForTimeout(1000);
        fileInput = await page.$('input[type="file"]');
      }
    }

    if (!fileInput) {
      log.warn('[enviarArquivo] input[type="file"] não encontrado no DOM — Messenger pode ter mudado o layout');
      return false;
    }

    log.info('[enviarArquivo] input[type="file"] encontrado — chamando setInputFiles...');
    await fileInput.setInputFiles(caminhoLocal);

    // Aguarda o preview do arquivo aparecer (confirma que o attach funcionou)
    const previewSeletores = [
      '[data-testid="media-attachment-preview"]',
      'img[class*="preview"]',
      'div[class*="attachment"]',
      'video[src]',
      'audio[src]',
    ];
    let previewOk = false;
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(800);
      for (const sel of previewSeletores) {
        if (await page.$(sel)) { previewOk = true; break; }
      }
      if (previewOk) break;
    }
    if (!previewOk) {
      log.warn('[enviarArquivo] Preview não apareceu em 5s — tentando enviar mesmo assim');
    } else {
      log.info('[enviarArquivo] Preview detectado — enviando...');
    }

    // Tenta clicar no botão Enviar; fallback para Enter
    const btnEnviar = await page.$('[aria-label="Send"], [aria-label="Envoyer"], [aria-label="Enviar"], [data-testid="send-button"]');
    if (btnEnviar) {
      await btnEnviar.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2500);

    // Verifica se a página ainda está responsiva (campo de texto existe)
    const campoTexto = await page.$('[contenteditable="true"][role="textbox"]');
    if (!campoTexto) {
      log.warn('[enviarArquivo] Campo de texto sumiu após envio — página pode estar em estado inesperado');
    }

    log.info(`[enviarArquivo] Arquivo ${nomeArq} enviado`);
    return true;
  } catch (e) {
    log.warn(`[enviarArquivo] Exceção: ${e.message}`);
    return false;
  }
}

// ── Comprime vídeo com ffmpeg para caber no limite do Messenger ───────────────
const LIMITE_VIDEO_BYTES = 20 * 1024 * 1024; // 20 MB — margem de segurança (limite FB = 25 MB)

async function comprimirVideo(inputPath, outputPath, targetMB = 20) {
  // Passo 1: pega duração via ffprobe
  const duration = await new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      inputPath,
    ], (err, stdout) => {
      if (err) return reject(new Error(`ffprobe falhou: ${err.message}`));
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams.find(s => s.codec_type === 'video') || data.streams[0];
        const dur = parseFloat(stream.duration);
        if (!dur || isNaN(dur)) return reject(new Error('ffprobe: duração não encontrada'));
        resolve(dur);
      } catch (e) {
        reject(new Error(`ffprobe parse: ${e.message}`));
      }
    });
  });

  // Passo 2: calcula bitrate de vídeo para atingir targetMB
  const targetBits    = targetMB * 1024 * 1024 * 8;
  const audioBits     = 96 * 1000 * duration;            // 96 kbps áudio
  const videoBitrate  = Math.max(100, Math.floor((targetBits - audioBits) / duration / 1000)); // kbps

  log.info(`[ffmpeg] duração: ${duration.toFixed(1)}s | bitrate alvo: ${videoBitrate}k | saída: ${path.basename(outputPath)}`);

  // Passo 3: comprime — single-pass, H.264 + AAC
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-b:v', `${videoBitrate}k`,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // garante dimensões pares (exigência H.264)
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',                   // streaming-friendly
      '-y',                                        // sobrescreve sem perguntar
      outputPath,
    ], { timeout: 5 * 60 * 1000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg falhou: ${err.message}\n${stderr?.slice(-300)}`));
      resolve();
    });
  });
}

// ── Envia mídia do veículo no primeiro contato (fallback silencioso) ──────────

async function enviarMidiaVeiculo(page, veiculo, convId) {
  if (!veiculo || (!veiculo.audio_url && !veiculo.video_url)) {
    log.info(`[Mídia] Sem audio_url/video_url para ${veiculo?.id || convId} — pulando`);
    return { audioEnviado: false, videoEnviado: false };
  }
  log.info(`[Mídia] Iniciando envio | audio: ${!!veiculo.audio_url} | video: ${!!veiculo.video_url}`);
  if (!fs.existsSync(TEMP_MIDIA)) fs.mkdirSync(TEMP_MIDIA, { recursive: true });

  let audioEnviado = false;
  let videoEnviado = false;

  // Áudio
  if (veiculo.audio_url) {
    try {
      const ext  = (veiculo.audio_url.split('.').pop().split('?')[0] || 'ogg').slice(0, 4);
      const dest = path.join(TEMP_MIDIA, `${convId}_audio.${ext}`);
      log.info(`[Mídia] Baixando áudio: ${veiculo.audio_url}`);
      const baixou = await baixarMidia(veiculo.audio_url, dest);
      log.info(`[Mídia] baixarMidia() retornou: ${baixou} | arquivo existe: ${fs.existsSync(dest)}`);
      const tamanhoAudio = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      log.info(`[Mídia] Áudio baixado: ${tamanhoAudio} bytes | ext: ${ext} | dest: ${dest}`);
      if (!baixou) {
        log.warn(`[Mídia] Falha no download do áudio (baixou=false)`);
        try { fs.unlinkSync(dest); } catch {}
      } else if (tamanhoAudio <= 1000) {
        log.warn(`[Mídia] Áudio muito pequeno ou vazio: ${tamanhoAudio} bytes — possivelmente URL inválida ou bucket bloqueado`);
        try { fs.unlinkSync(dest); } catch {}
      } else {
        log.info(`[Mídia] Chamando enviarArquivo() para áudio...`);
        const enviou = await enviarArquivo(page, dest);
        if (enviou) {
          audioEnviado = true;
          log.ok(`[Mídia] Áudio enviado para ${convId}`);
          // Aguarda DOM estabilizar antes de tentar o vídeo
          await page.waitForTimeout(2000);
        } else {
          log.warn(`[Mídia] enviarArquivo() retornou false para áudio — input[type=file] não encontrado ou setInputFiles falhou`);
        }
        try { fs.unlinkSync(dest); } catch {}
      }
    } catch (e) {
      log.warn(`[Mídia] Exceção no áudio: ${e.message}\n${e.stack}`);
    }
  }

  // Vídeo — baixa, comprime se necessário com ffmpeg, envia
  if (veiculo.video_url) {
    let destOriginal = null;
    let destFinal    = null;
    try {
      const ext      = (veiculo.video_url.split('.').pop().split('?')[0] || 'mp4').slice(0, 4).toLowerCase();
      destOriginal   = path.join(TEMP_MIDIA, `${convId}_video_orig.${ext}`);
      destFinal      = path.join(TEMP_MIDIA, `${convId}_video.mp4`);

      log.info(`[Mídia] Baixando vídeo: ${veiculo.video_url}`);
      const baixou = await baixarMidia(veiculo.video_url, destOriginal);
      log.info(`[Mídia] baixarMidia() retornou: ${baixou} | arquivo existe: ${fs.existsSync(destOriginal)}`);

      if (!baixou || !fs.existsSync(destOriginal)) {
        log.warn(`[Mídia] Falha no download do vídeo`);
      } else {
        const tamanho = fs.statSync(destOriginal).size;
        log.info(`[Mídia] Vídeo baixado: ${(tamanho / 1024 / 1024).toFixed(1)} MB`);

        if (tamanho <= 10000) {
          log.warn(`[Mídia] Vídeo vazio ou corrompido: ${tamanho} bytes`);
        } else {
          let paraEnviar = destOriginal;

          if (tamanho > LIMITE_VIDEO_BYTES) {
            log.info(`[Mídia] Vídeo grande (${(tamanho / 1024 / 1024).toFixed(1)} MB) — comprimindo com ffmpeg...`);
            try {
              await comprimirVideo(destOriginal, destFinal, 19);
              const tamanhoComprimido = fs.existsSync(destFinal) ? fs.statSync(destFinal).size : 0;
              log.info(`[Mídia] Comprimido: ${(tamanhoComprimido / 1024 / 1024).toFixed(1)} MB`);
              paraEnviar = destFinal;
            } catch (ffErr) {
              log.warn(`[Mídia] ffmpeg indisponível (${ffErr.message.slice(0, 60)}) — enviando original direto`);
              paraEnviar = destOriginal; // tenta enviar mesmo sem comprimir (limite FB = 25 MB)
            }
          } else if (ext !== 'mp4') {
            // Abaixo do limite mas formato não-mp4 (.mov, .avi etc)
            // Tenta converter com ffmpeg; se não estiver instalado, envia o original direto
            log.info(`[Mídia] Convertendo .${ext} → .mp4...`);
            try {
              await comprimirVideo(destOriginal, destFinal, 20);
              paraEnviar = destFinal;
            } catch (ffErr) {
              log.warn(`[Mídia] ffmpeg indisponível (${ffErr.message.slice(0, 60)}) — enviando .${ext} direto`);
              paraEnviar = destOriginal; // tenta enviar o .mov/.avi original
            }
          }

          log.info(`[Mídia] Chamando enviarArquivo() para vídeo...`);
          const enviou = await enviarArquivo(page, paraEnviar);
          if (enviou) {
            videoEnviado = true;
            log.ok(`[Mídia] Vídeo enviado para ${convId}`);
          } else {
            log.warn(`[Mídia] enviarArquivo() retornou false para vídeo`);
          }
        }
      }
    } catch (e) {
      log.warn(`[Mídia] Exceção no vídeo: ${e.message}\n${e.stack}`);
    } finally {
      try { if (destOriginal) fs.unlinkSync(destOriginal); } catch {}
      try { if (destFinal)    fs.unlinkSync(destFinal);    } catch {}
    }
  }

  log.info(`[Mídia] Resultado — audioEnviado: ${audioEnviado} | videoEnviado: ${videoEnviado}`);
  return { audioEnviado, videoEnviado };
}

// ── Detecta rows de conversa no inbox ───────────────────
async function detectarRows(page) {
  return page.evaluate(() => {
    const vehicleKws = /honda|chevrolet|fiat|volkswagen|vw|bmw|audi|yamaha|suzuki|kawasaki|titan|biz|\bcg\b|bros|xre|nxr|pop 110|factor|fazer|tenere|onix|celta|uno|saveiro|strada|s1000|jetta|sandero|corsa|gol|palio|siena|fiesta|ka\b|civic|fit|hr-v|city/i;
    const coords = [];
    const seenY = new Set();
    for (const el of document.querySelectorAll('div, span, a, li')) {
      if (el.children.length > 8) continue;
      const text = (el.textContent || '').trim();
      if (!text.includes(' · ') || text.length > 250 || text.length < 8) continue;
      if (/localiza[cç]|no raio|categorias|filtrar|criar novo|pesquisar|explorar|notifica|^escrever para|^Aa$/i.test(text)) continue;
      if (el.closest('[contenteditable], textarea, input')) continue;
      const afterDot = text.split(' · ').slice(1).join(' · ');
      if (!vehicleKws.test(afterDot) && !/\b(19|20)\d{2}\b/.test(afterDot)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 20 || rect.top < 80) continue;
      // Garante que o elemento está no sidebar esquerdo — exclui o painel da conversa aberta
      if (rect.left > 450) continue;
      const yKey = Math.round(rect.top / 20) * 20;
      if (seenY.has(yKey)) continue;
      seenY.add(yKey);
      const vehicleHint = afterDot
        .replace(/\n[\s\S]*/, '')                             // preview separado por \n
        .replace(/\s*Você:[\s\S]*/i, '')                      // "Você: mensagem enviada"
        .replace(/\s*[A-ZÁÉÍÓÚ][a-záéíóú]+:[\s\S]*/,'')      // "Nome: mensagem recebida"
        .replace(/Mensagem\s+n.o\s+lida[\s\S]*/i, '')            // "Mensagem não lida" (qualquer encoding do ã, sem exigir espaço antes)
        .replace(/\s*Agora\s+voc[êe]s[\s\S]*/i, '')          // "Agora vocês podem avaliar..."
        .replace(/\s*está\s+aguardando[\s\S]*/i, '')          // "está aguardando a sua resposta"
        .replace(/\s*·\s*\d+\s*$/, '')                        // " · 0" badge de notificação
        .trim()
        .slice(0, 60);
      const isUnread = /mensagem não lida|está aguardando a sua resposta/i.test(text);
      coords.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: text.slice(0, 120), vehicleHint, isUnread });
    }
    return coords.slice(0, 15);
  });
}

// ── Identifica veículo pelo hint da row ou conteúdo da página ───────────────
async function identificarVeiculo(page, ativos, vehicleHint) {
  // Verifica se o texto contém o modelo ou modeloMkt do veículo
  const matchModelo = (v, txt) => {
    const m  = (v.modelo   || '').toLowerCase();
    const mk = (v.modeloMkt|| '').toLowerCase();
    return (m.length  > 2 && txt.includes(m))  ||
           (mk.length > 2 && mk !== m && txt.includes(mk));
  };

  // 1) Row hint: "2007 Honda Titan 150" ou "2004 Honda Bros" — diferencia modelos pelo ano
  if (vehicleHint) {
    const hint = vehicleHint.toLowerCase();
    const v =
      ativos.find(v => matchModelo(v, hint) && hint.includes(String(v.ano))) ||
      ativos.find(v => matchModelo(v, hint) && hint.includes((v.marca||'').toLowerCase())) ||
      ativos.find(v => matchModelo(v, hint));
    if (v) { log.info(`  Veículo (row hint): ${v.marca} ${v.modelo} ${v.ano}`); return v; }

    // 1b) pastaFotos como alias — ex: "CG 150 EX 2012" (só quando carregado do JSON local)
    const vAlias = ativos.find(v => {
      const palavras = (v.pastaFotos || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
      return palavras.length >= 2 && palavras.filter(w => hint.includes(w)).length >= 2;
    });
    if (vAlias) { log.info(`  Veículo (pastaFotos alias): ${vAlias.marca} ${vAlias.modelo} ${vAlias.ano}`); return vAlias; }
  }

  // 2) Link do anúncio no DOM
  const tituloAnuncio = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/marketplace/item/"]');
    return a ? (a.getAttribute('aria-label') || a.textContent || '').trim() : '';
  });
  if (tituloAnuncio) {
    const t = tituloAnuncio.toLowerCase();
    const v = ativos.find(v => matchModelo(v, t) && t.includes(String(v.ano)))
           || ativos.find(v => matchModelo(v, t));
    if (v) { log.info(`  Veículo (link anúncio): ${v.marca} ${v.modelo} ${v.ano}`); return v; }
  }

  // 3) Header do anúncio Marketplace: linha "R$X.XXX — Veículo Ano" — NÃO usa document.body
  // (document.body inclui sidebar do inbox com outras conversas e contamina a detecção)
  if (vehicleHint && vehicleHint.trim().length > 3) {
    log.warn(`  Hint "${vehicleHint}" não bateu no estoque — tentando header do anúncio`);
  }
  const snippet = await page.evaluate(() => {
    // Busca a linha de preço/título do anúncio (ex: "R$6.500 — 2004 Honda Bros")
    const allDirs = Array.from(document.querySelectorAll('[dir="auto"]'));
    const headerEl = allDirs.find(el => /R\$[\d.,]+\s*[—–]/.test(el.textContent || ''));
    if (!headerEl) return '';
    // Sobe até 5 níveis para pegar o bloco completo do header (inclui nome do veículo)
    let parent = headerEl;
    for (let i = 0; i < 5; i++) {
      const pp = parent.parentElement;
      if (!pp || pp.tagName === 'BODY') break;
      const r = pp.getBoundingClientRect();
      if (r.height > 150) break; // Para quando o container ficar muito grande
      parent = pp;
    }
    return (parent.textContent || '').toLowerCase();
  });
  const v = snippet ? (
    ativos.find(v => matchModelo(v, snippet) && snippet.includes(String(v.ano)))
    || ativos.find(v => matchModelo(v, snippet))
  ) : null;
  if (v) { log.info(`  Veículo (header anúncio): ${v.marca} ${v.modelo} ${v.ano}`); return v; }

  // Esgotou todas as fontes — veículo fora do estoque
  if (vehicleHint && vehicleHint.trim().length > 3) {
    log.warn(`  Veículo "${vehicleHint}" não está no estoque — respondendo como fora de estoque`);
  }
  return null;
}

// ── Fecha qualquer popup do marketplace aberto ───────────
async function fecharPopups(page) {
  await page.evaluate(() => {
    // Clica no X de todos os popups visíveis no lado direito da tela
    const candidatos = Array.from(document.querySelectorAll('[aria-label]'));
    for (const el of candidatos) {
      const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
      if (!lbl.includes('fechar') && !lbl.includes('close') && !lbl.includes('dismiss')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.left > window.innerWidth * 0.35) {
        el.click();
      }
    }
    // Fallback: pressiona Escape para fechar qualquer popup/dialog
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}

// ── Processa uma conversa aberta (popup ou página inteira) ───────────────────
async function processarConversa(page, ativos, convId, vehicleHint, modoClique, respostasNoCiclo, isUnread, rowText) {
  // Verifica se é Marketplace (skip quando modoClique — detectarRows() já garantiu que é marketplace)
  if (!modoClique) {
    const ehMkt = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const url = window.location.href;
      return (
        url.includes('messenger.com/marketplace') ||
        url.includes('/marketplace/t/') ||
        txt.includes('Ver comprador') ||
        txt.includes('Marcar como pendente') ||
        !!document.querySelector('a[href*="/marketplace/item/"]') ||
        /R\$[\d.,]+\s*[—–]/.test(txt)
      );
    });
    if (!ehMkt) {
      log.info(`[${convId}] Não é Marketplace — ignorando`);
      return respostasNoCiclo;
    }
  }

  // Identifica veículo
  const veiculo = ativos.length === 1
    ? ativos[0]
    : await identificarVeiculo(page, ativos, vehicleHint);

  const foraDeEstoque = !veiculo;
  if (foraDeEstoque) {
    log.warn(`[${convId}] Veículo não identificado — respondendo como fora de estoque`);
  }

  // Lê mensagens
  let clienteMsgs, todasMsgs;
  if (modoClique) {
    const resultado = await lerMensagensPopup(page);
    clienteMsgs = resultado.clienteMsgs;
    todasMsgs   = resultado.todasMsgs;
  } else {
    clienteMsgs = await lerMensagens(page);
    todasMsgs   = clienteMsgs.map(t => ({ de: 'cliente', texto: t }));
  }
  const ultima = clienteMsgs[clienteMsgs.length - 1] || null;
  log.info(`  [msgs] ${todasMsgs.length} total | cliente: ${clienteMsgs.length} | "${(ultima||'').slice(0,50)}"`);

  if (!ultima) {
    log.info(`[${convId}] Nenhuma mensagem do cliente visível`);
    return respostasNoCiclo;
  }

  // Se a última mensagem da conversa (toda) é nossa → cliente ainda não respondeu
  // Exceção: se o sidebar marcou como "mensagem não lida" o cliente respondeu mas não foi detectado
  const ultimaGeral = todasMsgs[todasMsgs.length - 1];

  const fpAtual = fingerprint(ultima);
  const leads   = loadJSON(LEADS_FILE);
  const lead    = leads[convId] || { historico: [], fpRespondido: '' };

  if (ultimaGeral && ultimaGeral.de === 'eu' && !isUnread) {
    // Só faz early return se temos evidência real de que já respondemos
    const temHistorico = !!(lead.fpRespondido || lead.midiaEnviada || lead.crmRegistrado || lead.ultimaEnvio);
    if (temHistorico) {
      log.info(`[${convId}] Última mensagem é nossa — aguardando cliente`);
      return respostasNoCiclo;
    }
    log.info(`[${convId}] "Última msg nossa" mas sem histórico local — possível card do anúncio, continuando`);
  }

  // Guarda de segurança extra: fpEnviado bate com última msg do cliente → não responder
  if (fpAtual === (lead.fpEnviado || '__NUNCA__')) {
    log.info(`[${convId}] Última msg do cliente é nossa resposta anterior — aguardando`);
    return respostasNoCiclo;
  }

  // Trava de tempo: se enviamos mensagem há menos de 10min e a última msg do cliente
  // é a mesma que já respondemos, não envia de novo (cobre falha de detecção visual)
  if (lead.ultimaEnvio && fpAtual === lead.fpRespondido) {
    const minutos = (Date.now() - new Date(lead.ultimaEnvio).getTime()) / 60000;
    if (minutos < 10) {
      log.info(`[${convId}] Enviado há ${minutos.toFixed(1)}min — aguardando cliente responder`);
      return respostasNoCiclo;
    }
  }

  if (fpAtual === lead.fpRespondido) {
    if (!foraDeEstoque && deveFollowUp(lead) && respostasNoCiclo < MAX_POR_CICLO) {
      log.info(`[${convId}] Cliente sumiu — gerando follow-up...`);
      const followUp = await gerarFollowUp(veiculo, lead.historico);
      log.info(`  Follow-up: "${followUp}"`);
      await delayAleatorio();
      if (await enviar(page, followUp)) {
        lead.historico = [...(lead.historico||[]), { de: 'eu', texto: followUp }].slice(-20);
        lead.followUpEnviado = true;
        lead.ultimaAtividade = new Date().toISOString();
        leads[convId] = lead;
        saveJSON(LEADS_FILE, leads);
        respostasNoCiclo++;
        log.ok(`[${convId}] Follow-up enviado (${respostasNoCiclo}/${MAX_POR_CICLO})`);
      }
    } else {
      log.info(`[${convId}] Já respondido — nenhuma ação`);
    }
  } else {
    if (respostasNoCiclo >= MAX_POR_CICLO) {
      log.info(`[${convId}] Limite de envio atingido — verificado, não enviado`);
      return respostasNoCiclo;
    }
    log.info(`[${foraDeEstoque ? 'fora de estoque' : veiculo.marca + ' ' + veiculo.modelo}] Conversa ${convId} | "${ultima.slice(0,60)}"`);

    // ── Envia áudio/vídeo no primeiro contato ──────────────────────────────────
    const ehPrimeiroContato = !lead.historico || lead.historico.length === 0;
    let audioEnviado = false;
    let videoEnviado = false;
    if (ehPrimeiroContato && !lead.midiaEnviada && !foraDeEstoque && veiculo) {
      try {
        const resultadoMidia = await enviarMidiaVeiculo(page, veiculo, convId);
        audioEnviado = resultadoMidia?.audioEnviado || false;
        videoEnviado = resultadoMidia?.videoEnviado || false;
      } catch (e) {
        log.warn(`[Mídia] Erro inesperado — texto será enviado normalmente: ${e.message}`);
      }
      lead.midiaEnviada = true;
      leads[convId] = lead;
      saveJSON(LEADS_FILE, leads);
    }

    // ── Decide se envia texto com base no que foi enviado de mídia ─────────────
    // • Áudio (com ou sem vídeo) → não envia texto (áudio já abre o atendimento)
    // • Só vídeo → envia texto junto (vídeo sozinho não substitui a saudação)
    // • Nada  → envia texto para o cliente não ficar sem resposta
    const enviarTexto = !audioEnviado;
    if (!enviarTexto) {
      log.info(`[${convId}] Áudio enviado — texto suprimido no primeiro contato`);
      // Registra a interação no histórico mesmo sem texto
      lead.historico = [...(lead.historico || []), { de: 'cliente', texto: ultima }].slice(-20);
      lead.fpRespondido    = fpAtual;
      lead.followUpEnviado = false;
      lead.ultimaAtividade = new Date().toISOString();
      lead.ultimaEnvio     = new Date().toISOString();
      leads[convId] = lead;
      saveJSON(LEADS_FILE, leads);
      respostasNoCiclo++;
    }

    if (!enviarTexto) return respostasNoCiclo;

    const contexto = todasMsgs.slice(0, -1).slice(-10);
    let resp;
    if (foraDeEstoque) {
      const telNaMsg = extrairWhatsApp(ultima);
      resp = telNaMsg
        ? `Obrigado pelo contato! O especialista vai te chamar no ${telNaMsg} para ver o que temos disponível que pode te atender.`
        : responderForaDeEstoque(vehicleHint);
    } else {
      resp = await responder(veiculo, contexto, ultima);
      if (!resp) return respostasNoCiclo; // resposta descartada pelo filtro de segurança
    }
    log.info(`  Resposta: "${resp}"`);
    await delayAleatorio();
    if (await enviar(page, resp)) {
      lead.historico = [...(lead.historico||[]),
        { de: 'cliente', texto: ultima },
        { de: 'eu',      texto: resp }
      ].slice(-20);
      lead.fpRespondido    = fpAtual;
      lead.fpEnviado       = fingerprint(resp);
      lead.followUpEnviado = false;
      lead.ultimaAtividade = new Date().toISOString();
      lead.ultimaEnvio     = new Date().toISOString();
      leads[convId] = lead;
      saveJSON(LEADS_FILE, leads);
      respostasNoCiclo++;
      log.ok(`[${convId}] Enviado (${respostasNoCiclo}/${MAX_POR_CICLO} neste ciclo)`);

      // ── Sincroniza lead no CRM ─────────────────────────────────────────────
      // Registra desde o primeiro contato; atualiza quando o cliente manda o WhatsApp
      if (SUPABASE_URL && BOT_SECRET_TOKEN) {
        const clienteTextosCRM = lead.historico.filter(m => m.de === 'cliente').map(m => m.texto).join(' ');
        const tel = extrairWhatsApp(clienteTextosCRM); // apenas do cliente, não da loja

        const deveRegistrar = !lead.crmRegistrado;          // primeiro contato
        const deveAtualizar = tel && !lead.crmTemTelefone;  // cliente mandou o número

        log.info(`[CRM] deveRegistrar=${deveRegistrar} deveAtualizar=${!!deveAtualizar} crmRegistrado=${!!lead.crmRegistrado} tel=${tel||'—'}`);

        if (deveRegistrar || deveAtualizar) {
          // Lê o nome do comprador: extrai da row (formato "Nome · Veículo") ou tenta DOM
          const nomeDoRow = rowText
            ? rowText.split(' · ')[0]
                .replace(/^\(\d+\)\s*/, '')
                .replace(/^(online\s+agora|active\s+now|ativo\s+agora|disponível)\s*/i, '')
                .trim()
            : '';
          const compradorNome = (nomeDoRow.length > 1 && nomeDoRow.length < 60 && !/messenger|facebook|marketplace|conversas|notifica/i.test(nomeDoRow))
            ? nomeDoRow
            : await page.evaluate(() => {
                const header = document.querySelector('[role="main"] h1, [data-testid="conversation-title"]');
                if (header) {
                  const txt = (header.textContent || '').trim();
                  if (txt.length > 1 && txt.length < 60 && !/messenger|facebook|marketplace|conversas/i.test(txt)) return txt;
                }
                const t = document.title || '';
                const parte = t.split('|')[0].split('·')[0].replace(/^\(\d+\)\s*/, '').trim();
                if (parte.length > 1 && !/messenger|facebook|conversas/i.test(parte)) return parte;
                return 'Lead Marketplace';
              }).catch(() => 'Lead Marketplace');

          log.info(`[CRM] ${deveAtualizar ? 'Atualizando' : 'Registrando'} lead: ${compradorNome}${tel ? ' tel:' + tel : ' (sem tel ainda)'}`);

          // Notifica Telegram: novo lead OU lead acabou de mandar WhatsApp
          const isNovoLead     = !deveAtualizar;
          const chegouTelefone = deveAtualizar && tel && !lead.crmTemTelefone;
          if (isNovoLead || chegouTelefone) {
            const botNomes = { facebook1: 'Jhow', facebook2: 'João Moto Ride', facebook3: 'Lucas Moto Ride', facebook4: 'Bruna Moto Ride' };
            const botNome  = botNomes[BOT_ID] || BOT_ID;
            const veiculoLabel = veiculo ? `${veiculo.marca} ${veiculo.modelo} ${veiculo.ano}` : 'veículo desconhecido';
            const linhasTel = tel ? `📞 <b>WhatsApp:</b> ${tel}` : `📭 Ainda sem telefone`;
            const titulo = isNovoLead ? '🆕 Novo lead no Marketplace!' : '📱 Lead mandou WhatsApp!';
            notificarTelegram(
              `${titulo}\n👤 <b>${compradorNome}</b>\n🚗 ${veiculoLabel}\n${linhasTel}\n🤖 Bot: ${botNome}`
            );
          }

          sincronizarLeadCRM(convId, compradorNome, veiculo, lead.historico, tel)
            .then(id => {
              if (id) {
                // Relê leads do disco para evitar sobrescrever dados de outras conversas
                const leadsAtual = loadJSON(LEADS_FILE);
                const leadAtual  = leadsAtual[convId] || lead;
                leadAtual.crmRegistrado  = true;
                leadAtual.nome           = compradorNome;
                leadAtual.vehicleLabel   = veiculo ? `${veiculo.marca} ${veiculo.modelo} ${veiculo.ano}` : null;
                leadAtual.vehicleId      = veiculo?.id || null;
                if (tel) leadAtual.crmTemTelefone = true;
                leadAtual.crmLeadId = id;
                leadsAtual[convId] = leadAtual;
                saveJSON(LEADS_FILE, leadsAtual);
              }
            })
            .catch(e => log.error(`[CRM] ${e.message}`));
        }
      }

      await delayAleatorio();
    }
  }

  return respostasNoCiclo;
}

// ── Ciclo principal ──────────────────────────────────────
async function monitorar(page, context) {
  const vehicles = await carregarVeiculosSupabase();
  const ativos   = Object.values(vehicles).filter(v => v.status !== 'vendido');
  if (ativos.length === 0) { log.warn('Nenhum veículo ativo no estoque'); return page; }

  // Abre o inbox do Facebook Messenger (uma navegação por ciclo)
  await page.goto('https://www.facebook.com/messages/', {
    waitUntil: 'domcontentloaded', timeout: 20000
  });
  await page.waitForTimeout(4000);

  // Detecta bloqueio temporário do Facebook
  const temBloqueio = await page.evaluate(() =>
    (document.body?.innerText || '').includes('bloqueado temporariamente')
  );
  if (temBloqueio) {
    log.warn('[FB] Conta bloqueada temporariamente — aguardando 15 minutos...');
    await new Promise(r => setTimeout(r, 900000));
    return page;
  }

  // Detecta página de erro e tenta recarregar em aba nova
  const temErroFB = await page.evaluate(() =>
    (document.body?.innerText || '').includes('Ocorreu um erro')
  );
  if (temErroFB) {
    log.warn('[FB] Página de erro — abrindo aba nova...');
    try { await page.close(); } catch {}
    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('https://www.facebook.com/messages/', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await page.waitForTimeout(5000);
    const aindaComErro = await page.evaluate(() =>
      (document.body?.innerText || '').includes('Ocorreu um erro')
    );
    if (aindaComErro) {
      log.warn('[FB] Erro persistente — abortando ciclo');
      return page;
    }
  }

  // Clica na seção Marketplace do sidebar (simula navegação humana)
  try {
    const clicou = await page.evaluate(() => {
      // 1) Tenta pelo href — o mais confiável
      const byHref = document.querySelector('a[href*="/messages/marketplace"], a[href*="/marketplace/messages"]');
      if (byHref) { byHref.click(); return 'href'; }

      // 2) Tenta pelo texto — "Marketplace", "Marketplace · 40 min", "Marketplace1 nova mensagem..."
      //    O textContent inclui os elementos filhos (tempo, notificação), por isso só checa o início
      for (const el of document.querySelectorAll('a, [role="link"], [role="button"]')) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const lbl = (el.getAttribute('aria-label') || '').trim();
        const ehMarketplace = /^Marketplace/i.test(txt) || lbl === 'Marketplace';
        if (!ehMarketplace) continue;
        const rect = el.getBoundingClientRect();
        // Deve estar no sidebar esquerdo (não no conteúdo principal)
        if (rect.width > 30 && rect.width < 400 && rect.height > 20 && rect.top > 50 && rect.left < 350) {
          el.click(); return 'text';
        }
      }
      return false;
    });
    if (clicou) {
      log.info(`[FB] Clicou no Marketplace do sidebar (via ${clicou})`);
      await page.waitForTimeout(3000);
    } else {
      log.warn('[FB] Ícone Marketplace não encontrado — continuando com conversas visíveis');
    }
  } catch (e) {
    log.warn(`[FB] Erro ao clicar Marketplace: ${e.message}`);
  }

  await page.screenshot({ path: 'debug.png' });

  const rowsInicial = await detectarRows(page);
  log.info(`[debug] ${rowsInicial.length} conversa(s) Marketplace detectada(s)`);

  if (rowsInicial.length === 0) {
    log.warn('Nenhuma conversa encontrada (veja debug.png)');
    return page;
  }

  // ── Método clique: sidebar permanece visível, sem navegações extras ──
  let respostasNoCiclo = 0;
  const processados = new Set();

  const chaveRow = (r) => {
    const comprador = r.text.split(' · ')[0].trim().slice(0, 20);
    const hint = (r.vehicleHint || '').toLowerCase();
    const veiculo = ativos.find(v =>
      hint.includes((v.modelo || '').toLowerCase()) && hint.includes(String(v.ano))
    ) || ativos.find(v =>
      hint.includes((v.modelo || '').toLowerCase()) && hint.includes((v.marca || '').toLowerCase())
    ) || ativos.find(v =>
      (v.modelo || '').length > 2 && hint.includes((v.modelo || '').toLowerCase())
    );
    const vStable = veiculo
      ? `${veiculo.modelo}_${veiculo.ano}`.replace(/\s+/g, '_')
      : hint.slice(0, 20).replace(/[^a-z0-9]/gi, '_');
    return (comprador + '_' + vStable).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '_');
  };

  let ultimaUrlProcessada = '';

  while (true) {
    const rows = await detectarRows(page);
    const proximo = rows.find(r => !processados.has(chaveRow(r)));
    if (!proximo) { log.info('Todas as conversas do ciclo processadas'); break; }

    processados.add(chaveRow(proximo));

    try {
      await fecharPopups(page);
      log.info(`  Clicando: "${proximo.text.slice(0, 60)}"`);
      await page.mouse.click(proximo.x, proximo.y);
      await page.waitForTimeout(3500);

      const urlAtual = page.url();
      // Captura IDs numéricos (padrão) e alfanuméricos (ex: m_XXXX, e2ee)
      const mId = urlAtual.match(/\/messages\/t\/([a-zA-Z0-9_-]{5,})/)
               || urlAtual.match(/\/(?:t|e2ee\/t)\/([a-zA-Z0-9_-]{5,})/)
               || urlAtual.match(/\/marketplace\/(?:inbox|t)\/([a-zA-Z0-9_-]{5,})/);
      const convId = mId?.[1] || urlAtual.match(/\d{10,}/)?.[0] || chaveRow(proximo);

      log.info(`  URL: ${urlAtual.slice(-70)}`);

      // Proteção contra clique fantasma: URL não mudou após o clique → sidebar não navegou
      if (urlAtual === ultimaUrlProcessada) {
        log.warn(`  [skip] URL igual à anterior — clique não navegou para nova conversa (row falsa do painel principal?)`);
        continue;
      }
      ultimaUrlProcessada = urlAtual;

      respostasNoCiclo = await processarConversa(page, ativos, convId, proximo.vehicleHint, true, respostasNoCiclo, proximo.isUnread, proximo.text);

      // Delay humano entre conversas (sidebar permanece aberto)
      await page.waitForTimeout(3000 + Math.floor(Math.random() * 3000));
    } catch (e) {
      log.error(`[clique] ${e.message}`);
    }
  }

  log.info(`Ciclo encerrado — ${respostasNoCiclo} resposta(s) enviada(s)`);
  return page;
}

// ── Start ────────────────────────────────────────────────
async function main() {
  log.info(`=== MotoRide Bot | ${BOT_NAME} ===`);
  if (DRY_RUN) log.dry('MODO SIMULAÇÃO ATIVO — nada será enviado');

  const vehicles = await carregarVeiculosSupabase();
  const ativos   = Object.values(vehicles).filter(v => v.status !== 'vendido');
  if (ativos.length === 0) {
    log.error('Nenhum veículo ativo no estoque. Cadastre veículos no CRM.');
    process.exit(1);
  }
  log.info('Veículos: ' + ativos.map(v => `${v.marca} ${v.modeloMkt || v.modelo} ${v.ano}`).join(', '));
  log.info(`Config local: MAX_POR_CICLO=${MAX_POR_CICLO} | DELAY=${DELAY_MIN}-${DELAY_MAX}ms | DRY_RUN=${DRY_RUN}`);

  const userHome = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\User';
  const CHROME_ARGS = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userHome}\\chrome-bot-perfil-${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const CHROME_CMD = `chrome.exe --remote-debugging-port=${CDP_PORT} --user-data-dir="${userHome}\\chrome-bot-perfil-${CDP_PORT}"`;

  function launchChrome() {
    const { spawn } = require('child_process');
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const chromePath = chromePaths.find(p => require('fs').existsSync(p));
    if (!chromePath) { log.error('Chrome não encontrado. Instale o Google Chrome.'); return; }
    log.info(`Abrindo Chrome na porta ${CDP_PORT}...`);
    const proc = spawn(chromePath, CHROME_ARGS, { detached: true, stdio: 'ignore' });
    proc.unref();
  }

  // Loop externo de reconexão — nunca deixa o bot morrer
  while (true) {
    let browser, page;
    try {
      launchChrome();
      await new Promise(r => setTimeout(r, 4000)); // aguarda Chrome abrir
      log.info('Conectando ao Chrome...');
      browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      const context = browser.contexts()[0];
      page = await context.newPage();
      log.info('Chrome conectado. Monitorando a cada 60s...');

      // Loop interno de monitoramento
      while (true) {
        // ── Lê configuração do CRM antes de cada ciclo ──────
        const config = await lerConfiguracaoCRM();
        if (config) {
          if (!config.is_active) {
            log.info('[CRM] Bot pausado pelo CRM — aguardando reativação...');
            await enviarHeartbeat(config.id);
            await new Promise(r => setTimeout(r, 60000));
            continue;
          }
          log.info(`[CRM] Config ativa (id: ${config.id}) | dry_mode: ${config.dry_mode}`);
          await enviarHeartbeat(config.id);
        } else {
          log.info('[CRM] Config não encontrada — usando config local');
        }

        log.info('--- Verificando inbox ---');
        try { page = await monitorar(page, context); }
        catch (e) {
          log.error(e.message);
          if (/Target closed|Session closed|Connection closed|browser.*disconnect/i.test(e.message)) {
            throw e;
          }
        }
        log.info('Aguardando 60s...');
        await new Promise(r => setTimeout(r, 60000));
      }

    } catch (e) {
      log.error(`Conexão perdida: ${e.message}`);
      try { await browser?.close(); } catch {}
      log.info('Aguardando 30s para reconectar...');
      log.info(`Certifique-se que o Chrome está rodando: ${CHROME_CMD}`);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

main().catch(e => { log.error(e.message); process.exit(1); });
