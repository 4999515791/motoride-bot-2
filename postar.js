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
const FOTOS_BASE    = 'C:\\Users\\User\\Desktop\\motos para postagem';

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
  const result = await chamarEdgeFunction('bot-get-config', { bot_type: 'posting' });
  return (result && result.config) ? result.config : null;
}

async function enviarHeartbeat(configId) {
  if (!configId) return;
  await chamarEdgeFunction('bot-heartbeat', {
    config_id: configId,
    bot_type:  'posting',
    timestamp: new Date().toISOString(),
  });
}

// ── Helpers ───────────────────────────────────────────────
function loadVehicles() {
  return JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf8'));
}

function getFotos(pastaVeiculo) {
  const dir = path.join(FOTOS_BASE, pastaVeiculo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .map(f => path.join(dir, f))
    .slice(0, 20);
}

async function gerarDescricao(v) {
  const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Crie uma descrição de anúncio para Facebook Marketplace para este veículo.
REGRAS OBRIGATÓRIAS: texto corrido, SEM asteriscos, SEM markdown, SEM bullet points, máximo 5 linhas, linguagem informal brasileira, estilo vendedor de loja.
Termine SEMPRE com: "Financiamento facilitado, inclusive negativados. Chame no privado!"

Dados do veículo:
Tipo: ${v.tipo} | ${v.marca} ${v.modelo} ${v.versao || ''} ${v.ano} | Cor: ${v.cor} | KM: ${v.quilometragem}
Mecânica: ${v.estadoMecanico} | Estética: ${v.estadoEstetico}
Diferenciais: ${v.diferenciais}
Troca: ${v.aceitaTroca ? 'aceita' : 'não aceita'} | Financiamento: ${v.financiamento}
${v.observacoes ? 'Obs: ' + v.observacoes : ''}`
    }]
  });
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
      await btn.click();
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
  const fotos = getFotos(v.pastaFotos || '');
  if (fotos.length === 0) {
    throw new Error(`Nenhuma foto em "${path.join(FOTOS_BASE, v.pastaFotos || '')}"`);
  }
  log.info(`Fotos: ${fotos.length} encontrada(s)`);

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
    await fileInput.setInputFiles(fotos);
    log.info(`Aguardando upload de ${fotos.length} foto(s)...`);
    await page.waitForTimeout(7000);
    log.ok('Fotos enviadas');
  } else {
    log.warn('Input de arquivo não encontrado');
  }

  await dropdown(page, 'Ano', String(v.ano));
  await page.waitForTimeout(2000);

  await dropdown(page, 'Fabricante', v.marca);
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

      const veiculos = loadVehicles();
      if (veiculos[v.id]) {
        veiculos[v.id].ultimaPostagem = new Date().toISOString();
        fs.writeFileSync(VEHICLES_FILE, JSON.stringify(veiculos, null, 2), 'utf8');
        log.ok('vehicles.json atualizado — ultimaPostagem registrada');
      }
    } else {
      log.warn('Botão "Publicar" não encontrado. Clique manualmente no Chrome.');
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
    browser = await chromium.connectOverCDP('http://localhost:9222');
  } catch {
    log.error('Chrome não encontrado na porta 9222.');
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
    log.info(`[FILA] Próximo: ${vehicleId} (item: ${item.id})`);
    await marcarComandoExecutando(item.id);

    const vehicles = loadVehicles();
    const v = vehicles[vehicleId];
    if (!v) {
      log.error(`[FILA] Veículo "${vehicleId}" não encontrado em vehicles.json`);
      await marcarComandoErro(item.id, `Veículo ${vehicleId} não encontrado`);
      continue;
    }

    log.info(`=== Postando: ${v.marca} ${v.modelo} ${v.ano} ===`);
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

  const vehicles = loadVehicles();
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
