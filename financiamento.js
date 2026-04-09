// financiamento.js — Envia ficha cadastral para Aqui Financiamentos automaticamente
// Uso daemon: node financiamento.js   (fica em loop lendo financiamento_fichas do Supabase)
// Uso manual: node financiamento.js <uuid>  (envia uma ficha específica pelo ID)

const { chromium } = require('playwright');
const https  = require('https');
const path   = require('path');
require('dotenv').config();

const log = require('./modules/logger');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AQUI_LOGIN        = process.env.AQUI_LOGIN    || 'loja';
const AQUI_SENHA        = process.env.AQUI_SENHA    || '8283';
const AQUI_LOJA         = process.env.AQUI_LOJA     || 'MotoRide';
const AQUI_CIDADE       = process.env.AQUI_CIDADE   || 'Curitibanos-SC';
const AQUI_DDD_TEL      = process.env.AQUI_DDD_TEL  || '49';
const AQUI_TEL          = process.env.AQUI_TEL      || '999515791';
const AQUI_NOME_CONTATO = process.env.AQUI_NOME_CONTATO || 'MotoRide Curitibanos';
const AQUI_EMAIL        = process.env.AQUI_EMAIL    || 'motoridesc@gmail.com';

const AQUI_URL_LOGIN    = 'https://www.aquifinanciamentos.com.br/loja/loginLoja.php';

// ── Supabase REST helpers ─────────────────────────────────────────────────────

function supabaseGet(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${endpoint}`);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function supabasePatch(endpoint, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${SUPABASE_URL}/rest/v1/${endpoint}`);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PATCH',
      headers:  {
        'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'Prefer': 'return=minimal',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

// ── Fila de fichas ────────────────────────────────────────────────────────────

async function buscarProximaFicha() {
  const rows = await supabaseGet(
    'financiamento_fichas?status=eq.pendente&order=created_at.asc&limit=1'
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function buscarFichaPorId(id) {
  const rows = await supabaseGet(`financiamento_fichas?id=eq.${id}&limit=1`);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function marcarProcessando(id) {
  return supabasePatch(`financiamento_fichas?id=eq.${id}`, { status: 'processando' });
}

async function marcarEnviado(id) {
  return supabasePatch(`financiamento_fichas?id=eq.${id}`, {
    status: 'enviado',
    submitted_at: new Date().toISOString(),
  });
}

async function marcarErro(id, msg) {
  return supabasePatch(`financiamento_fichas?id=eq.${id}`, {
    status: 'erro',
    erro_msg: String(msg).substring(0, 500),
    submitted_at: new Date().toISOString(),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Retorna id do select "Método de Financiamento": leve=5, pesada=4
function idTabelaFinanciamento(tabela_fin) {
  return tabela_fin === 'pesada' ? '4' : '5';
}

// Mapeamento: nº de parcelas (texto) → id interno do select da Aqui Financiamentos
const PARCELAS_ID = { '6':1,'12':2,'15':10,'18':4,'24':3,'30':5,'36':6,'40':7,'42':8,'48':9 };

// Coeficientes: nome → id interno do select
const COEF_ID = { 'A':2,'B':3,'C':4,'D':5,'Unico':6 };

// ── Preenchimento do formulário ───────────────────────────────────────────────

async function preencherCampo(page, seletor, valor) {
  if (!valor && valor !== 0) return;
  try {
    await page.fill(seletor, String(valor));
  } catch {
    // campo inexistente ou oculto — ignora silenciosamente
  }
}

async function selecionarOpcao(page, seletor, valor) {
  if (!valor) return;
  try {
    await page.selectOption(seletor, { value: String(valor) });
  } catch {
    try { await page.selectOption(seletor, { label: String(valor) }); } catch {}
  }
}

async function enviarFicha(ficha) {
  log.info(`[financiamento] Iniciando envio ficha ${ficha.id} — ${ficha.nome}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();

  try {
    // ── 1. Login ─────────────────────────────────────────────────────────────
    await page.goto(AQUI_URL_LOGIN, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="login"], input[type="text"]:first-of-type', AQUI_LOGIN);
    await page.fill('input[name="senha"], input[type="password"]', AQUI_SENHA);
    await page.click('input[type="submit"], button');
    await page.waitForURL('**/novaFichaCadastral.php', { timeout: 15000 });
    log.ok('[financiamento] Login realizado');

    // ── 2. Simulação / Método de Financiamento ────────────────────────────────
    const idTabela = idTabelaFinanciamento(ficha.tabela_fin);
    await selecionarOpcao(page, '#idTabela', idTabela);
    await selecionarOpcao(page, '#anoItem',  String(ficha.veiculo_ano || '2013'));

    // Habilita os campos de simulação (que começam desabilitados)
    await page.evaluate(() => {
      ['valor','coeficiente','parcelas','parcela'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.disabled = false; el.classList.remove('disabled'); }
      });
    });

    if (ficha.valor_financiado) {
      const valorFormatado = Number(ficha.valor_financiado).toFixed(2).replace('.', ',');
      await page.fill('#valor', valorFormatado);
    }
    if (ficha.coeficiente) {
      await selecionarOpcao(page, '#coeficiente', String(COEF_ID[ficha.coeficiente] || 2));
    }
    if (ficha.num_parcelas) {
      await selecionarOpcao(page, '#parcelas', String(PARCELAS_ID[String(ficha.num_parcelas)] || 3));
    }
    if (ficha.valor_parcela) {
      await page.fill('#parcela', Number(ficha.valor_parcela).toFixed(2));
    }

    log.ok('[financiamento] Simulação preenchida');

    // ── 3. Dados Pessoais ─────────────────────────────────────────────────────
    await preencherCampo(page, '#nome',       ficha.nome);
    await preencherCampo(page, '#nascimento', ficha.nascimento);
    await preencherCampo(page, '#mae',        ficha.mae);
    await preencherCampo(page, '#cpf',        ficha.cpf);
    await preencherCampo(page, '#dddcelular', ficha.ddd_celular);
    await preencherCampo(page, '#celular',    ficha.celular);
    await preencherCampo(page, '#cep',        ficha.cep);
    await preencherCampo(page, '#endereco',   ficha.endereco);
    await preencherCampo(page, '#num',        ficha.num_end);
    await preencherCampo(page, 'input[name="bairro"]:not([id*="emp"])', ficha.bairro);
    await preencherCampo(page, '#cidade',     ficha.cidade);
    await preencherCampo(page, '#ufend',      ficha.uf);

    if (ficha.moradia) {
      await selecionarOpcao(page, '#moradia', ficha.moradia === 'Própria' ? 'Própria' : 'Alugada');
    }
    if (ficha.anos_residencia) {
      await preencherCampo(page, '#anores', ficha.anos_residencia);
    }

    // Sexo padrão M
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[name="sexo"]');
      if (radios.length > 0) radios[0].checked = true;
    });

    log.ok('[financiamento] Dados pessoais preenchidos');

    // ── 4. Dados Profissionais ────────────────────────────────────────────────
    await preencherCampo(page, '#empresa',     ficha.empresa);
    await preencherCampo(page, '#tempoemprego', ficha.tempo_emprego);
    await preencherCampo(page, '#cepemp',      ficha.cep_emp);
    await preencherCampo(page, '#enderecoemp', ficha.endereco_emp);
    await preencherCampo(page, '#numemp',      ficha.num_emp);
    await preencherCampo(page, '#bairroemp',   ficha.bairro_emp);
    await preencherCampo(page, '#cidadeemp',   ficha.cidade_emp);
    await preencherCampo(page, '#ufemp',       ficha.uf_emp);
    await preencherCampo(page, '#dddtelemp',   ficha.ddd_tel_emp);
    await preencherCampo(page, '#telemp',      ficha.tel_emp);
    await preencherCampo(page, '#funcao',      ficha.funcao);
    await preencherCampo(page, '#rendab',      ficha.renda_bruta);

    log.ok('[financiamento] Dados profissionais preenchidos');

    // ── 5. Referências ────────────────────────────────────────────────────────
    if (ficha.ref1_nome) {
      await preencherCampo(page, '#ref1',       ficha.ref1_nome);
      await preencherCampo(page, '#dddtelref1', ficha.ref1_ddd);
      await preencherCampo(page, '#telref1',    ficha.ref1_tel);
    }
    if (ficha.ref2_nome) {
      await preencherCampo(page, '#ref2',       ficha.ref2_nome);
      await preencherCampo(page, '#dddtelref2', ficha.ref2_ddd);
      await preencherCampo(page, '#telref2',    ficha.ref2_tel);
    }

    log.ok('[financiamento] Referências preenchidas');

    // ── 6. Dados da Garantia (Moto — preenchidos pelo sistema) ───────────────
    await preencherCampo(page, '#marca',     ficha.veiculo_marca);
    await preencherCampo(page, '#modelo',    ficha.veiculo_modelo);
    await preencherCampo(page, '#fabricacao', ficha.veiculo_ano);
    await preencherCampo(page, '#amodelo',   ficha.veiculo_ano);
    await preencherCampo(page, '#placa',     ficha.veiculo_placa);

    // Tipo: Moto
    await page.evaluate(() => {
      document.querySelectorAll('input[name="tipo"]').forEach(r => {
        if (r.value === 'Moto') r.checked = true;
      });
    });
    // Condição: Usado
    await page.evaluate(() => {
      document.querySelectorAll('input[name="condicao"]').forEach(r => {
        if (r.id !== 'condNovo') r.checked = true;
      });
    });

    log.ok('[financiamento] Dados da garantia preenchidos');

    // ── 7. Informações Finais (dados da loja — sempre fixos) ─────────────────
    await preencherCampo(page, '#dddtelcontato', AQUI_DDD_TEL);
    await preencherCampo(page, '#telcontato',    AQUI_TEL);
    await preencherCampo(page, '#nomecontato',   AQUI_NOME_CONTATO);
    await preencherCampo(page, '#lojacontato',   AQUI_LOJA);
    await preencherCampo(page, '#cidadecontato', AQUI_CIDADE);
    await preencherCampo(page, '#emailcontato',  AQUI_EMAIL);

    log.ok('[financiamento] Informações da loja preenchidas');

    // ── 8. Screenshot antes de enviar ────────────────────────────────────────
    await page.screenshot({
      path: path.join(__dirname, 'logs', `ficha-${ficha.id}-antes.png`),
      fullPage: true,
    });

    // ── 9. Enviar ─────────────────────────────────────────────────────────────
    await page.evaluate(() => {
      // Clica no botão "Validar e Enviar" pelo texto ou pelo tipo
      const btns = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'));
      const enviar = btns.find(b => b.value?.includes('Enviar') || b.textContent?.includes('Enviar'));
      if (enviar) enviar.click();
    });

    await page.waitForTimeout(4000);

    await page.screenshot({
      path: path.join(__dirname, 'logs', `ficha-${ficha.id}-depois.png`),
      fullPage: true,
    });

    const urlAtual  = page.url();
    const conteudo  = (await page.content()).toLowerCase();
    const temErro   = conteudo.includes('erro') || urlAtual.includes('loginLoja');
    const temSucesso = conteudo.includes('sucesso') || conteudo.includes('enviado') || conteudo.includes('obrigado');

    if (temErro && !temSucesso) {
      throw new Error(`Formulário retornou erro. URL: ${urlAtual}`);
    }

    log.ok(`[financiamento] Ficha ${ficha.id} enviada com sucesso!`);
    return true;

  } finally {
    await browser.close();
  }
}

// ── Daemon principal ──────────────────────────────────────────────────────────

async function daemon() {
  log.info('[financiamento] Daemon iniciado. Aguardando fichas pendentes a cada 30s...');

  while (true) {
    try {
      const ficha = await buscarProximaFicha();

      if (ficha) {
        log.info(`[financiamento] Ficha encontrada: ${ficha.id} — ${ficha.nome}`);
        await marcarProcessando(ficha.id);

        try {
          await enviarFicha(ficha);
          await marcarEnviado(ficha.id);
        } catch (err) {
          log.error(`[financiamento] Erro ao enviar ficha ${ficha.id}: ${err.message}`);
          await marcarErro(ficha.id, err.message);
        }
      }
    } catch (err) {
      log.error(`[financiamento] Erro no daemon: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 30000));
  }
}

// ── Entrada ───────────────────────────────────────────────────────────────────

const fichaId = process.argv[2];

if (fichaId) {
  // Modo manual: envia uma ficha específica pelo ID
  (async () => {
    const ficha = await buscarFichaPorId(fichaId);
    if (!ficha) { log.error(`Ficha ${fichaId} não encontrada`); process.exit(1); }
    await marcarProcessando(ficha.id);
    try {
      await enviarFicha(ficha);
      await marcarEnviado(ficha.id);
      log.ok('Ficha enviada com sucesso!');
    } catch (err) {
      await marcarErro(ficha.id, err.message);
      log.error(`Falha: ${err.message}`);
      process.exit(1);
    }
  })();
} else {
  daemon();
}
