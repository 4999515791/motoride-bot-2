// postar.js — Posta veículo no Facebook Marketplace automaticamente
// Uso manual:  node postar.js v2
// Uso daemon:  node postar.js  (puxa fila automática do CRM)
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const log           = require('./modules/logger');
const VEHICLES_FILE = path.join(__dirname, 'data', 'vehicles.json');
const FOTOS_BASE    = process.env.FOTOS_DIR || require('path').join(process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\User', 'Desktop', 'motos para postagem');
const TEMP_DIR      = path.join(__dirname, 'temp_fotos');

// ── CRM (Lovable Edge Functions) ─────────────────────────
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_SECRET_TOKEN = process.env.BOT_SECRET_TOKEN;
const BOT_ID           = process.env.BOT_ID;

async function chamarEdgeFunction(nome, body) {
  if (!SUPABASE_URL || !BOT_SECRET_TOKEN) return null;
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${SUPABASE_URL}/functions/v1/${nome}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-bot-token':    BOT_SECRET_TOKEN,
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

// ── Supabase REST API (leitura/escrita direta em bot_commands) ────────────────
async function supabaseQuery(path) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return new Promise((resolve) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
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

async function supabasePatch(path, body) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PATCH',
      headers: {
        'apikey':          SUPABASE_ANON_KEY,
        'Authorization':   `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(data),
        'Prefer':          'return=minimal',
      },
    };
    const req = https.request(options, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

// ── sessoes_fotos + fotos_offsets ─────────────────────────────────────────────
async function buscarSessoesVeiculo(vehicleUuid) {
  if (!vehicleUuid) return [];
  const rows = await supabaseQuery(
    `sessoes_fotos?veiculo_id=eq.${vehicleUuid}&order=ordem.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

async function buscarOffsetBot(vehicleUuid) {
  if (!vehicleUuid || !BOT_ID) return null;
  const rows = await supabaseQuery(
    `fotos_offsets?veiculo_id=eq.${vehicleUuid}&bot_id=eq.${BOT_ID}&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function supabasePost(tabela, body, onConflict) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  return new Promise((resolve) => {
    const qs   = onConflict ? `?on_conflict=${onConflict}` : '';
    const data = JSON.stringify(body);
    const url  = new URL(`${SUPABASE_URL}/rest/v1/${tabela}${qs}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'apikey':          SUPABASE_ANON_KEY,
        'Authorization':   `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(data),
        'Prefer':          'resolution=merge-duplicates,return=minimal',
      },
    };
    const req = https.request(options, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

async function getFotosPorSessao(sessao) {
  const nomes = Array.isArray(sessao.fotos) ? sessao.fotos : [];
  if (nomes.length === 0) return [];

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const prefixo = `sess_${sessao.id}_`;
  for (const f of fs.readdirSync(TEMP_DIR)) {
    if (f.startsWith(prefixo)) try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
  }

  const caminhos = [];
  for (const nome of nomes) {
    const destino = path.join(TEMP_DIR, `${prefixo}${nome}`);
    const ok = await baixarFoto(sessao.id, nome, destino);
    if (ok) caminhos.push({ nome, caminho: destino });
  }

  if (caminhos.length === 0) return [];

  // Capa definida no CRM vai primeiro
  if (sessao.capa) {
    const idx = caminhos.findIndex(f => f.nome === sessao.capa);
    if (idx > 0) {
      const [capa] = caminhos.splice(idx, 1);
      caminhos.unshift(capa);
    }
  }

  return caminhos.map(f => f.caminho).slice(0, 20);
}

function limparTempSessao(sessaoId) {
  if (!fs.existsSync(TEMP_DIR)) return;
  const prefixo = `sess_${sessaoId}_`;
  for (const f of fs.readdirSync(TEMP_DIR)) {
    if (f.startsWith(prefixo)) try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
  }
}

async function buscarProximoComando() {
  const filtro = BOT_ID
    ? `bot_commands?bot_id=eq.${BOT_ID}&status=eq.pendente&order=created_at.asc&limit=1`
    : `bot_commands?status=eq.pendente&order=created_at.asc&limit=1`;
  const result = await supabaseQuery(filtro);
  if (!Array.isArray(result) || result.length === 0) return null;
  return result[0];
}

async function marcarComandoExecutando(id) {
  await supabasePatch(`bot_commands?id=eq.${id}`, { status: 'executando' });
}

async function marcarComandoConcluido(id) {
  await supabasePatch(`bot_commands?id=eq.${id}`, {
    status: 'executado', executed_at: new Date().toISOString(),
  });
}

async function marcarComandoErro(id, erro) {
  await supabasePatch(`bot_commands?id=eq.${id}`, {
    status: 'erro', erro_msg: String(erro), executed_at: new Date().toISOString(),
  });
}

async function lerConfiguracaoCRM() {
  const result = await chamarEdgeFunction('bot-get-config', { bot_id: BOT_ID, bot_type: 'posting' });
  if (!result) return null;
  const data = result.config || result;
  if (!data || !data.bot_id) return null;
  return { ...data, is_active: data.is_active ?? data.ativo };
}

async function enviarHeartbeat(configId) {
  if (!configId) return;
  await chamarEdgeFunction('bot-heartbeat', {
    bot_id:    BOT_ID,
    config_id: configId,
    bot_type:  'posting',
    timestamp: new Date().toISOString(),
  });
}

// ── Helpers ───────────────────────────────────────────────
async function carregarVeiculosSupabase() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const rows = await supabaseQuery('veiculos?order=local_id.asc');
    if (Array.isArray(rows) && rows.length > 0) {
      const result = {};
      for (const row of rows) {
        const v = {
          id:             row.local_id,
          uuid:           row.id,          // UUID do Supabase (usado no Storage pelo CRM)
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
          fotoCapaIndex:  row.foto_capa_index || 0,
          fotosCapas:     row.fotos_capas || [],
        };
        result[v.id] = v;
      }
      return result;
    }
  }
  log.warn('[Veículos] Supabase indisponível — usando data/vehicles.json local');
  return JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf8'));
}

// ── Baixa fotos do Supabase Storage para pasta temp ──────────────────────────
async function listarFotosStorage(vehicleId) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];
  return new Promise((resolve) => {
    const data = JSON.stringify({ prefix: `${vehicleId}/`, limit: 100, offset: 0 });
    const url  = new URL(`${SUPABASE_URL}/storage/v1/object/list/fotos-veiculos`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'apikey':          SUPABASE_ANON_KEY,
        'Authorization':   `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const items = JSON.parse(raw);
          if (!Array.isArray(items)) { resolve([]); return; }
          const nomes = items
            .map(i => i.name)
            .filter(n => n && /\.(jpg|jpeg|png|webp)$/i.test(n))
            .sort();
          resolve(nomes);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(data);
    req.end();
  });
}

async function baixarFoto(vehicleId, nome, destino) {
  return new Promise((resolve) => {
    const url = new URL(`${SUPABASE_URL}/storage/v1/object/public/fotos-veiculos/${vehicleId}/${encodeURIComponent(nome)}`);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'GET' };
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // redireciona
        const loc = res.headers.location;
        https.get(loc, (res2) => {
          const out = fs.createWriteStream(destino);
          res2.pipe(out);
          out.on('finish', () => { out.close(); resolve(true); });
          out.on('error', () => resolve(false));
        }).on('error', () => resolve(false));
        return;
      }
      const out = fs.createWriteStream(destino);
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(true); });
      out.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Seleciona fotos respeitando fotosCapas (se definido) ou rotação normal
function selecionarFotos(todas, indiceAtual, fotosCapas = []) {
  if (fotosCapas.length > 0) {
    const capas = todas.filter(c => fotosCapas.some(fc => path.basename(c).toLowerCase() === fc.toLowerCase()));
    if (capas.length > 0) {
      const indice = indiceAtual % capas.length;
      const capa = capas[indice];
      const resto = todas.filter(c => c !== capa);
      return { fotos: [capa, ...resto].slice(0, 20), proximoIndice: (indice + 1) % capas.length };
    }
    log.warn(`[Capa] fotosCapas definidas mas não encontradas nas fotos — usando rotação normal`);
  }
  const indice = indiceAtual % todas.length;
  const rotacionadas = [...todas.slice(indice), ...todas.slice(0, indice)];
  return { fotos: rotacionadas.slice(0, 20), proximoIndice: (indice + 1) % todas.length };
}

async function getFotosVeiculo(vehicleId, pastaFotosLocal, indiceAtual = 0, vehicleUuid = null, fotosCapas = []) {
  // 1) Tenta Supabase Storage — primeiro pelo local_id, depois pelo UUID (fotos enviadas pelo CRM)
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    let nomes = await listarFotosStorage(vehicleId);
    let storagePrefix = vehicleId;
    // CRM salva fotos pelo UUID — tenta se local_id não retornou nada
    if (nomes.length === 0 && vehicleUuid) {
      nomes = await listarFotosStorage(vehicleUuid);
      storagePrefix = vehicleUuid;
      if (nomes.length > 0) log.info(`[Storage] Fotos encontradas pelo UUID ${vehicleUuid}`);
    }
    if (nomes.length > 0) {
      log.info(`[Storage] ${nomes.length} foto(s) encontrada(s) para ${vehicleId} — baixando...`);
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      // limpa temp anterior deste veículo
      const prefixo = `${vehicleId}_`;
      for (const f of fs.readdirSync(TEMP_DIR)) {
        if (f.startsWith(prefixo)) fs.unlinkSync(path.join(TEMP_DIR, f));
      }
      const caminhos = [];
      for (const nome of nomes) {
        const destino = path.join(TEMP_DIR, `${vehicleId}_${nome}`);
        const ok = await baixarFoto(storagePrefix, nome, destino);
        if (ok) caminhos.push(destino);
      }
      if (caminhos.length > 0) {
        log.ok(`[Storage] ${caminhos.length} foto(s) baixada(s) para temp`);
        const { fotos, proximoIndice } = selecionarFotos(caminhos, indiceAtual, fotosCapas);
        return { fotos, proximoIndice, fonte: 'storage' };
      }
    }
  }
  // 2) Fallback: pasta local
  log.warn(`[Storage] Sem fotos no Supabase para ${vehicleId} — tentando pasta local`);
  const dir = path.join(FOTOS_BASE, pastaFotosLocal || '');
  if (!fs.existsSync(dir)) return { fotos: [], proximoIndice: 0, fonte: 'local' };
  const todas = fs.readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort()
    .map(f => path.join(dir, f));
  if (todas.length === 0) return { fotos: [], proximoIndice: 0, fonte: 'local' };
  const { fotos, proximoIndice } = selecionarFotos(todas, indiceAtual, fotosCapas);
  return { fotos, proximoIndice, fonte: 'local' };
}

function limparTempVeiculo(vehicleId) {
  if (!fs.existsSync(TEMP_DIR)) return;
  const prefixo = `${vehicleId}_`;
  for (const f of fs.readdirSync(TEMP_DIR)) {
    if (f.startsWith(prefixo)) {
      try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
    }
  }
}

const ANGULOS_DESCRICAO = [
  'Destaque o excelente custo-benefício e quanto o comprador vai economizar comparado à concorrência.',
  'Enfatize o estado impecável de conservação e a tranquilidade de comprar um veículo sem dor de cabeça.',
  'Use tom animado e urgente, transmitindo que é uma oportunidade imperdível que vai sair rápido.',
  'Foque na facilidade do financiamento e que qualquer pessoa pode sair com o veículo hoje.',
  'Destaque os diferenciais únicos deste veículo e o que o faz se destacar de outros anúncios.',
  'Escreva como se estivesse conversando diretamente com o comprador, de forma próxima e descontraída.',
  'Ressalte o histórico de manutenção e confiabilidade para quem quer segurança na compra.',
];

async function gerarDescricao(v) {
  const angulo = ANGULOS_DESCRICAO[Math.floor(Math.random() * ANGULOS_DESCRICAO.length)];
  const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Crie uma descrição de anúncio para Facebook Marketplace para este veículo.
REGRAS OBRIGATÓRIAS: texto corrido, SEM asteriscos, SEM markdown, SEM bullet points, máximo 5 linhas, linguagem informal brasileira, estilo vendedor de loja.
ÂNGULO DESTA DESCRIÇÃO (siga obrigatoriamente): ${angulo}
Termine SEMPRE com: "Financiamento facilitado, inclusive negativados. Chame no privado!"

Dados do veículo:
Tipo: ${v.tipo} | ${v.marca} ${v.modelo} ${v.versao || ''} ${v.ano} | Cor: ${v.cor} | KM: ${v.quilometragem}
Mecânica: ${v.estadoMecanico} | Estética: ${v.estadoEstetico}
Diferenciais: ${v.diferenciais}
Troca: ${v.aceitaTroca ? 'aceita' : 'não aceita'} | Financiamento: ${v.financiamento}
${v.observacoes ? 'Obs: ' + v.observacoes : ''}`
    }]
  });
  log.info(`  [ângulo] ${angulo}`);
  return res.content[0].text.trim().replace(/\*\*/g, '').replace(/\*/g, '');
}

// ── Seleciona dropdown ────────────────────────────────────────────────────────
async function dropdown(page, labelParcial, opcao) {
  log.info(`  [dropdown] "${labelParcial}" → "${opcao}"`);

  let clicou = await page.evaluate((label) => {
    const combos = document.querySelectorAll('[role="combobox"], select, [aria-haspopup="listbox"]');
    for (const el of combos) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes(label.toLowerCase())) { el.click(); return true; }
    }
    return false;
  }, labelParcial);

  if (!clicou) {
    clicou = await page.evaluate((label) => {
      for (const el of document.querySelectorAll('div, span')) {
        if (el.children.length > 0) continue;
        if (el.textContent?.trim() !== label) continue;
        let n = el.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!n) break;
          const combo = n.querySelector('[role="combobox"], select');
          if (combo) { combo.click(); return true; }
          n = n.parentElement;
        }
      }
      return false;
    }, labelParcial);
  }

  if (!clicou) { log.warn(`  [!] Dropdown "${labelParcial}" não encontrado`); return false; }

  await page.waitForTimeout(1000);

  const opcoes = await page.$$('[role="option"], li[role="option"]');
  for (const op of opcoes) {
    const txt = (await op.textContent())?.trim();
    if (txt === opcao || txt?.startsWith(opcao)) {
      await op.evaluate(el => el.click());
      await page.waitForTimeout(600);
      return true;
    }
  }

  const fallback = await page.$(`[role="option"]:has-text("${opcao}")`);
  if (fallback) { await fallback.evaluate(el => el.click()); await page.waitForTimeout(600); return true; }

  log.warn(`  [!] Opção "${opcao}" não encontrada em "${labelParcial}"`);
  await page.keyboard.press('Escape');
  return false;
}

// ── Preenche input/textarea por label ou placeholder ──────────────────────────
async function preencherCampo(page, labelParcial, valor) {
  log.info(`  [campo] "${labelParcial}" → "${String(valor).slice(0, 60)}${String(valor).length > 60 ? '...' : ''}"`);

  const focado = await page.evaluate((label) => {
    const lbl = label.toLowerCase();
    for (const el of document.querySelectorAll('input, textarea')) {
      const ph = (el.placeholder || '').toLowerCase();
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      if (ph.includes(lbl) || al.includes(lbl)) { el.focus(); return true; }
    }
    for (const span of document.querySelectorAll('span, label, div')) {
      if (span.children.length > 0) continue;
      if (!span.textContent?.trim().toLowerCase().includes(lbl)) continue;
      let n = span.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!n) break;
        const inp = n.querySelector('input, textarea');
        if (inp) { inp.focus(); return true; }
        n = n.parentElement;
      }
    }
    return false;
  }, labelParcial);

  if (!focado) { log.warn(`  [!] Campo "${labelParcial}" não encontrado`); return false; }

  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(100);
  await page.keyboard.type(String(valor), { delay: 30 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  return true;
}

// ── Marca checkbox por texto próximo ─────────────────────────────────────────
async function marcarCheckbox(page, textoParcial) {
  log.info(`  [checkbox] "${textoParcial}"`);

  try {
    const cb = page.locator('[role="checkbox"]').filter({ hasText: textoParcial.split(' ')[0] }).first();
    await cb.waitFor({ timeout: 3000 });
    const checked = await cb.getAttribute('aria-checked');
    if (checked !== 'true') await cb.evaluate(el => el.click());
    log.ok(`  [ok] Checkbox marcado`);
    return true;
  } catch { /* tenta fallback */ }

  const marcou = await page.evaluate((texto) => {
    const lbl = texto.toLowerCase();
    for (const el of document.querySelectorAll('input[type="checkbox"]')) {
      const parent = el.closest('label') || el.parentElement;
      if (parent?.textContent?.toLowerCase().includes(lbl)) {
        if (!el.checked) el.click();
        return true;
      }
    }
    for (const el of document.querySelectorAll('[role="checkbox"]')) {
      const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
      if (t.includes(lbl)) { el.click(); return true; }
    }
    for (const el of document.querySelectorAll('div, span, label')) {
      if (!el.textContent?.toLowerCase().includes(lbl)) continue;
      const cb = el.querySelector('input[type="checkbox"], [role="checkbox"]');
      if (cb) { cb.click(); return true; }
    }
    return false;
  }, textoParcial);

  if (!marcou) log.warn(`  [!] Checkbox "${textoParcial}" não encontrado`);
  return marcou;
}

// ── Clica botão ───────────────────────────────────────────────────────────────
async function clicarBotao(page, texto) {
  log.info(`  [botão] "${texto}"`);
  const seletores = [
    `[role="button"]:has-text("${texto}")`,
    `button:has-text("${texto}")`,
    `div[tabindex="0"]:has-text("${texto}")`,
    `[aria-label="${texto}"]`
  ];
  for (const sel of seletores) {
    const btn = await page.$(sel);
    if (btn) {
      try {
        // Tenta click normal primeiro
        await btn.click({ timeout: 5000 });
      } catch {
        // Overlay interceptando — usa click direto no DOM
        await btn.evaluate(el => el.click());
      }
      await page.waitForTimeout(2500);
      return true;
    }
  }
  log.warn(`  [!] Botão "${texto}" não encontrado`);
  return false;
}

// ── Seleciona os grupos com mais membros ──────────────────────────────────────
async function selecionarGrupos(page, max = 20) {
  log.info(`Selecionando até ${max} grupos com mais membros...`);

  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      const scrollables = document.querySelectorAll(
        '[style*="overflow-y: scroll"], [style*="overflow-y:scroll"], ' +
        '[style*="overflow: scroll"], [style*="overflow-y: auto"], ' +
        '[style*="overflow:auto"]'
      );
      let rolou = false;
      for (const el of scrollables) {
        if (el.scrollHeight > el.clientHeight + 10) {
          el.scrollTop += 350;
          rolou = true;
          break;
        }
      }
      if (!rolou) window.scrollBy(0, 350);
    });
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1000);

  const indices = await page.evaluate((maxGrupos) => {
    function parseMembros(txt) {
      const m1 = txt.match(/([\d]+[,.][\d]+)\s*mil/i);
      if (m1) return Math.round(parseFloat(m1[1].replace(',', '.')) * 1000);
      const m2 = txt.match(/(\d+)\s*mil/i);
      if (m2) return parseInt(m2[1]) * 1000;
      const m3 = txt.match(/([\d][\d.]*)\s*membros/i);
      if (m3) return parseInt(m3[1].replace(/\./g, ''));
      return 0;
    }

    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
    const data = [];

    for (let i = 0; i < checkboxes.length; i++) {
      const cb = checkboxes[i];
      let el = cb.parentElement;
      for (let j = 0; j < 10; j++) {
        if (!el || el.tagName === 'BODY') break;
        if (el.textContent?.includes('membros')) break;
        el = el.parentElement;
      }
      if (!el?.textContent?.includes('membros')) continue;

      const members = parseMembros(el.textContent);
      if (members === 0) continue;

      const isChecked = cb.getAttribute('aria-checked') === 'true' || cb.checked;
      const nome = el.textContent.split('\n')[0].trim().slice(0, 50);
      data.push({ i, members, nome, isChecked });
    }

    data.sort((a, b) => b.members - a.members);
    return data.slice(0, maxGrupos);
  }, max);

  if (indices.length === 0) {
    log.warn('Nenhum grupo encontrado — verifique se a página carregou');
    return;
  }

  log.info(`${indices.length} grupos encontrados para selecionar`);

  const allCheckboxes = await page.$$('input[type="checkbox"], [role="checkbox"]');
  for (const g of indices) {
    const cb = allCheckboxes[g.i];
    if (!cb) continue;
    try {
      if (!g.isChecked) {
        await cb.evaluate(el => el.click());
        await page.waitForTimeout(350);
      }
      log.info(`  ✓ ${g.nome} (${(g.members / 1000).toFixed(1)}k membros)`);
    } catch (e) {
      log.warn(`  [!] Erro ao selecionar grupo ${g.nome}: ${e.message}`);
    }
  }

  log.ok(`${indices.length} grupo(s) selecionado(s)`);
}

// ── LÓGICA DE POSTAGEM (extraída para reutilizar no daemon) ───────────────────
async function postarVeiculo(page, v) {
  let fotos         = [];
  let usouSessao    = false;
  let proximoIndice = 0;   // usado só no fallback antigo
  let offsetRow     = null;
  let sessaoUsada   = null;

  // ── Tenta sessões de rotação (novo sistema) ──────────────────────────────
  if (v.uuid && SUPABASE_URL && SUPABASE_ANON_KEY) {
    const sessoes = await buscarSessoesVeiculo(v.uuid);
    if (sessoes.length > 0) {
      offsetRow           = await buscarOffsetBot(v.uuid);
      const offsetInicial = offsetRow ? offsetRow.offset_inicial  : 0;
      const postagens     = offsetRow ? offsetRow.postagens_count : 0;
      const sessaoIndex   = (offsetInicial + postagens) % sessoes.length;
      sessaoUsada         = sessoes[sessaoIndex];

      log.info(`[Sessão] ${sessoes.length} sessão(ões) | offset: ${offsetInicial} | postagens: ${postagens} → sessão ${sessaoIndex} ("${sessaoUsada.nome}")`);

      fotos = await getFotosPorSessao(sessaoUsada);
      if (fotos.length > 0) {
        usouSessao = true;
        log.ok(`[Sessão] ${fotos.length} foto(s) — capa: ${path.basename(fotos[0])}`);
      } else {
        log.warn(`[Sessão] Sessão "${sessaoUsada.nome}" sem fotos no Storage — usando fallback`);
      }
    }
  }

  // ── Fallback: lógica anterior (pasta local / Storage flat) ───────────────
  if (!usouSessao) {
    const resultado = await getFotosVeiculo(v.id, v.pastaFotos || '', v.fotoCapaIndex || 0, v.uuid || null, v.fotosCapas || []);
    fotos           = resultado.fotos;
    proximoIndice   = resultado.proximoIndice;
    if (fotos.length > 0) log.info(`Fotos: ${fotos.length} encontrada(s) [${resultado.fonte}] — capa: ${path.basename(fotos[0])}`);
  }

  if (fotos.length === 0) {
    log.error(`[Fotos] Nenhuma foto encontrada — id: ${v.id}, pastaFotos: "${v.pastaFotos}", uuid: ${v.uuid || '—'}`);
    throw new Error(`Nenhuma foto encontrada para ${v.id} — configure sessões no CRM ou adicione fotos na pasta local`);
  }

  log.info('Gerando descrição...');
  const descricao = await gerarDescricao(v);
  log.info(`Descrição:\n${descricao}\n`);

  log.info('Abrindo formulário...');
  await page.goto('https://www.facebook.com/marketplace/create/vehicle', {
    waitUntil: 'domcontentloaded', timeout: 20000
  });
  await page.waitForTimeout(4000);

  const tipoTexto = v.tipo === 'moto' ? 'Moto' : 'Carro/picape';
  await dropdown(page, 'Tipo de veículo', tipoTexto);
  await page.waitForTimeout(1500);

  log.info('Fazendo upload das fotos...');
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    // Tenta até 2 vezes com timeout de 3 minutos cada
    let uploadOk = false;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        log.info(`  [upload] Tentativa ${tentativa}/2 — ${fotos.length} foto(s)...`);
        await fileInput.setInputFiles(fotos, { timeout: 180000 });
        uploadOk = true;
        break;
      } catch (e) {
        log.warn(`  [upload] Tentativa ${tentativa} falhou: ${e.message.slice(0, 80)}`);
        if (tentativa < 2) await page.waitForTimeout(3000);
      }
    }
    if (!uploadOk) throw new Error('Upload de fotos falhou após 2 tentativas — abortando postagem');
    log.info(`Aguardando upload de ${fotos.length} foto(s)...`);
    // Espera proporcional ao número de fotos (mínimo 7s, +1s por foto acima de 5)
    const esperaUpload = 7000 + Math.max(0, fotos.length - 5) * 1000;
    await page.waitForTimeout(esperaUpload);
    log.ok('Fotos enviadas');
  } else {
    log.warn('Input de arquivo não encontrado');
  }

  await dropdown(page, 'Ano', String(v.ano));
  await page.waitForTimeout(2000);

  const fabricanteOk = await dropdown(page, 'Fabricante', v.marca);
  if (!fabricanteOk) throw new Error(`Dropdown "Fabricante" não encontrou "${v.marca}" — verifique se a marca está correta no Marketplace`);
  await page.waitForTimeout(4000);

  const modeloDigitar = v.modeloMkt || v.pastaFotos;
  await preencherCampo(page, 'Modelo', modeloDigitar);
  await page.waitForTimeout(1000);

  await preencherCampo(page, 'quilometragem', v.quilometragem);
  await page.waitForTimeout(500);

  await preencherCampo(page, 'preço', v.preco);
  await page.waitForTimeout(500);

  if (v.carroceria) {
    await dropdown(page, 'Estilo da carroceria', v.carroceria);
    await page.waitForTimeout(800);
  }

  if (v.corExterna) {
    await dropdown(page, 'Cor externa', v.corExterna);
    await page.waitForTimeout(800);
  }

  if (v.corInterna) {
    await dropdown(page, 'Cor interna', v.corInterna);
    await page.waitForTimeout(800);
  }

  await marcarCheckbox(page, 'não tem pendências');
  await page.waitForTimeout(500);

  if (v.condicao) {
    await dropdown(page, 'Condição do veículo', v.condicao);
    await page.waitForTimeout(800);
  }

  if (v.combustivel) {
    await dropdown(page, 'Tipo de combustível', v.combustivel);
    await page.waitForTimeout(800);
  }

  if (v.cambio) {
    await dropdown(page, 'Câmbio', v.cambio);
    await page.waitForTimeout(800);
  }

  await preencherCampo(page, 'descrição', descricao);
  await page.waitForTimeout(800);

  await page.screenshot({ path: 'pre-publicar.png', fullPage: false });
  log.ok('Screenshot salvo em pre-publicar.png');

  const avancou = await clicarBotao(page, 'Avançar');
  if (avancou) {
    await page.waitForTimeout(3000);
    await selecionarGrupos(page, 20);
    await page.screenshot({ path: 'pre-publicar2.png' });
    log.ok('Grupos selecionados — screenshot em pre-publicar2.png');

    const publicou = await clicarBotao(page, 'Publicar');
    if (publicou) {
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'publicado.png' });
      log.ok('=== ANÚNCIO PUBLICADO! Screenshot em publicado.png ===');

      await supabasePatch(`veiculos?local_id=eq.${v.id}`, {
        ultima_postagem: new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      });

      if (usouSessao && v.uuid) {
        const novoCount = (offsetRow ? offsetRow.postagens_count : 0) + 1;
        if (offsetRow) {
          await supabasePatch(`fotos_offsets?id=eq.${offsetRow.id}`, {
            postagens_count: novoCount,
            updated_at:      new Date().toISOString(),
          });
        } else {
          await supabasePost('fotos_offsets', {
            veiculo_id:      v.uuid,
            bot_id:          BOT_ID,
            offset_inicial:  0,
            postagens_count: 1,
          }, 'veiculo_id,bot_id');
        }
        const totalSessoes = (await buscarSessoesVeiculo(v.uuid)).length;
        const offsetInicial = offsetRow ? offsetRow.offset_inicial : 0;
        const proximaSessao = (offsetInicial + novoCount) % totalSessoes;
        log.ok(`[Sessão] postagens_count → ${novoCount} | próxima: sessão ${proximaSessao}`);
        if (sessaoUsada) limparTempSessao(sessaoUsada.id);
      } else {
        await supabasePatch(`veiculos?local_id=eq.${v.id}`, {
          foto_capa_index: proximoIndice,
          updated_at:      new Date().toISOString(),
        });
        log.ok(`Supabase atualizado — ultimaPostagem registrada, próxima capa: índice ${proximoIndice}`);
        limparTempVeiculo(v.id);
      }
    } else {
      log.warn('Botão "Publicar" não encontrado. Clique manualmente no Chrome.');
      limparTempVeiculo(v.id);
    }
  } else {
    log.warn('Botão "Avançar" não encontrado. Verifique pre-publicar.png e clique manualmente.');
  }
}

// ── MODO DAEMON — puxa fila do CRM automaticamente ───────────────────────────
async function modoDaemon() {
  log.info('=== MotoRide Bot Posting — Modo Daemon ===');

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${process.env.CDP_PORT || 9222}`);
  } catch {
    log.error(`Chrome não encontrado na porta ${process.env.CDP_PORT || 9222}.`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  log.info('Chrome conectado. Monitorando fila do CRM...');

  while (true) {
    const config = await lerConfiguracaoCRM();
    if (config) {
      if (!config.is_active) {
        log.info('[CRM] Bot pausado pelo CRM — aguardando reativação...');
        await enviarHeartbeat(config.id);
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      await enviarHeartbeat(config.id);
    }

    const item = await buscarProximoComando();
    if (!item) {
      log.info('[FILA] Nenhum item pendente — verificando em 60s...');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const vehicleId = item.veiculo_id;
    log.info(`[FILA] Próximo: veiculo_id="${vehicleId}" (item: ${item.id})`);
    await marcarComandoExecutando(item.id);

    const vehicles = await carregarVeiculosSupabase();
    log.info(`[FILA] ${Object.keys(vehicles).length} veículo(s) no estoque: ${Object.keys(vehicles).slice(0, 15).join(', ')}`);
    let v = vehicles[vehicleId];
    if (!v) {
      log.warn(`[FILA] "${vehicleId}" não encontrado por chave direta — tentando alternativas...`);
      const porUuid    = Object.values(vehicles).find(x => x.uuid === vehicleId);
      log.info(`[FILA]   por uuid:       ${porUuid    ? `${porUuid.id} (${porUuid.marca} ${porUuid.modelo})`         : 'não encontrado'}`);
      const porLocalId = Object.values(vehicles).find(x => x.id === vehicleId);
      log.info(`[FILA]   por local_id:   ${porLocalId ? `${porLocalId.id} (${porLocalId.marca} ${porLocalId.modelo})` : 'não encontrado'}`);
      const porPasta   = Object.values(vehicles).find(x => x.pastaFotos && x.pastaFotos.toLowerCase() === vehicleId.toLowerCase());
      log.info(`[FILA]   por pastaFotos: ${porPasta   ? `${porPasta.id} (${porPasta.marca} ${porPasta.modelo})`       : 'não encontrado'}`);
      v = porUuid || porLocalId || porPasta || null;
      if (!v) {
        log.error(`[FILA] Veículo "${vehicleId}" não encontrado — nenhuma das buscas retornou resultado`);
        await marcarComandoErro(item.id, `Veículo ${vehicleId} não encontrado`);
        continue;
      }
      log.ok(`[FILA] Encontrado via busca alternativa: ${v.id} (${v.marca} ${v.modelo})`);
    }

    log.info(`=== Postando: ${v.marca} ${v.modelo} ${v.ano} (id=${v.id}, uuid=${v.uuid || '—'}) ===`);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    try {
      await postarVeiculo(page, v);
      await marcarComandoConcluido(item.id);
      log.ok(`[FILA] ${v.marca} ${v.modelo} ${v.ano} — postado e marcado no CRM`);
    } catch (e) {
      await marcarComandoErro(item.id, e.message);
      log.error(`[FILA] Erro ao postar ${vehicleId}: ${e.message}`);
    } finally {
      await page.close();
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

// ── MODO MANUAL — node postar.js v2 ──────────────────────────────────────────
async function main() {
  const vehicleId = process.argv[2];

  const vehicles = await carregarVeiculosSupabase();
  if (!vehicles[vehicleId]) {
    log.error(`Veículo "${vehicleId}" não encontrado.`);
    console.log('\nVeículos disponíveis:');
    Object.values(vehicles).forEach(v =>
      console.log(`  ${v.id} — ${v.marca} ${v.modelo} ${v.ano}`)
    );
    process.exit(1);
  }

  const v = vehicles[vehicleId];
  log.info(`=== Postando: ${v.marca} ${v.modelo} ${v.ano} ===`);

  const config = await lerConfiguracaoCRM();
  if (config) {
    if (!config.is_active) {
      log.info('[CRM] Bot de postagem pausado pelo CRM — ative no painel antes de postar.');
      process.exit(0);
    }
    log.info(`[CRM] Config ativa (id: ${config.id})`);
    await enviarHeartbeat(config.id);
  } else {
    log.info('[CRM] Config não encontrada — usando config local');
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222');
  } catch {
    log.error('Chrome não encontrado na porta 9222.');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page    = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  await postarVeiculo(page, v);
}

// ── ENTRY POINT ───────────────────────────────────────────
if (process.argv[2]) {
  main().catch(e => { log.error(e.message); process.exit(1); });
} else {
  modoDaemon().catch(e => { log.error(e.message); process.exit(1); });
}
