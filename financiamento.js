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
const AQUI_EMAIL        = process.env.AQUI_EMAIL    || 'motoridecs@gmail.com';

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

// ── Envio da ficha ────────────────────────────────────────────────────────────

async function enviarFicha(ficha) {
  log.info(`[financiamento] Iniciando envio ficha ${ficha.id} — ${ficha.nome}`);

  // Chrome estável: sem sandbox (necessário em ambientes Windows/server), sem GPU
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer'],
  });
  const context = await browser.newContext();
  const page    = await context.newPage();

  try {
    // ── 1. Login ─────────────────────────────────────────────────────────────
    await page.goto(AQUI_URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('input[name="login"]', AQUI_LOGIN);
    await page.fill('input[name="senha"]', AQUI_SENHA);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForURL('**/novaFichaCadastral.php', { timeout: 20000 });
    log.ok('[financiamento] Login realizado');

    // Aguarda a página carregar completamente antes de preencher
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // ── 2. Preenche TODOS os campos via evaluate (sem page.fill — evita Target crashed) ──
    // Usar page.fill em campos disabled/dinâmicos causa crash do Chrome.
    // evaluate roda no contexto do browser e define os valores diretamente no DOM
    // sem disparar os event listeners JavaScript do site que causam instabilidade.

    const dados = {
      idTabela:  idTabelaFinanciamento(ficha.tabela_fin),
      anoItem:   String(ficha.veiculo_ano || '2013'),
      valor:     ficha.valor_financiado ? Number(ficha.valor_financiado).toFixed(2).replace('.', ',') : '',
      coef:      ficha.coeficiente      ? String(COEF_ID[ficha.coeficiente] || 2) : '',
      parcelas:  ficha.num_parcelas     ? String(PARCELAS_ID[String(ficha.num_parcelas)] || 3) : '',
      parcela:   ficha.valor_parcela    ? Number(ficha.valor_parcela).toFixed(2) : '',
      // Pessoais
      nome:         ficha.nome         || '',
      nascimento:   ficha.nascimento   || '',
      mae:          ficha.mae          || '',
      cpf:          ficha.cpf          || '',
      dddcelular:   ficha.ddd_celular  || '',
      celular:      ficha.celular      || '',
      cep:          ficha.cep          || '',
      endereco:     ficha.endereco     || '',
      num:          ficha.num_end      || '',
      bairro:       ficha.bairro       || '',
      cidade:       ficha.cidade       || '',
      ufend:        ficha.uf           || '',
      moradia:      ficha.moradia      || '',
      anores:       ficha.anos_residencia || '',
      // Profissionais
      empresa:      ficha.empresa      || '',
      tempoemprego: ficha.tempo_emprego || '',
      cepemp:       ficha.cep_emp      || '',
      enderecoemp:  ficha.endereco_emp || '',
      numemp:       ficha.num_emp      || '',
      bairroemp:    ficha.bairro_emp   || '',
      cidadeemp:    ficha.cidade_emp   || '',
      ufemp:        ficha.uf_emp       || '',
      dddtelemp:    ficha.ddd_tel_emp  || '',
      telemp:       ficha.tel_emp      || '',
      funcao:       ficha.funcao       || '',
      rendab:       ficha.renda_bruta  || '',
      // Referências
      ref1:         ficha.ref1_nome    || '',
      dddtelref1:   ficha.ref1_ddd     || '',
      telref1:      ficha.ref1_tel     || '',
      ref2:         ficha.ref2_nome    || '',
      dddtelref2:   ficha.ref2_ddd     || '',
      telref2:      ficha.ref2_tel     || '',
      // Garantia
      marca:        ficha.veiculo_marca  || '',
      modelo:       ficha.veiculo_modelo || '',
      fabricacao:   String(ficha.veiculo_ano || ''),
      amodelo:      String(ficha.veiculo_ano || ''),
      placa:        ficha.veiculo_placa  || '',
      // Loja (fixo)
      dddtelcontato: AQUI_DDD_TEL,
      telcontato:    AQUI_TEL,
      nomecontato:   AQUI_NOME_CONTATO,
      lojacontato:   AQUI_LOJA,
      cidadecontato: AQUI_CIDADE,
      emailcontato:  AQUI_EMAIL,
    };

    await page.evaluate((d) => {
      // Seta valor de input por ID (habilita o campo se estiver disabled)
      function setVal(id, val) {
        if (val == null || val === '') return;
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = false;
        el.readOnly = false;
        el.value = String(val);
      }

      // Seta select por ID usando value ou label
      function setSelect(id, val) {
        if (val == null || val === '') return;
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = false;
        const opts = Array.from(el.options);
        const byVal   = opts.find(o => o.value === String(val));
        const byLabel = opts.find(o => o.text.trim() === String(val));
        if (byVal)   { el.value = byVal.value;   return; }
        if (byLabel) { el.value = byLabel.value;  return; }
      }

      // ── Simulação ───────────────────────────────────────────────────────────
      setSelect('idTabela',    d.idTabela);
      setSelect('anoItem',     d.anoItem);
      setVal('valor',          d.valor);
      setSelect('coeficiente', d.coef);
      setSelect('parcelas',    d.parcelas);
      setVal('parcela',        d.parcela);

      // ── Dados Pessoais ──────────────────────────────────────────────────────
      setVal('nome',        d.nome);
      setVal('nascimento',  d.nascimento);
      setVal('mae',         d.mae);
      setVal('cpf',         d.cpf);
      setVal('dddcelular',  d.dddcelular);
      setVal('celular',     d.celular);
      setVal('cep',         d.cep);
      setVal('endereco',    d.endereco);
      setVal('num',         d.num);

      // Bairro residencial: input[name="bairro"] que não seja do empregador
      const bairroInputs = document.querySelectorAll('input[name="bairro"]');
      bairroInputs.forEach(el => {
        if (!el.id || !el.id.toLowerCase().includes('emp')) {
          el.disabled = false;
          el.value = d.bairro;
        }
      });

      setVal('cidade',      d.cidade);
      setVal('ufend',       d.ufend);
      setSelect('moradia',  d.moradia);
      setVal('anores',      d.anores);

      // Sexo padrão M
      const radios = document.querySelectorAll('input[name="sexo"]');
      if (radios.length > 0) radios[0].checked = true;

      // ── Dados Profissionais ─────────────────────────────────────────────────
      setVal('empresa',      d.empresa);
      setVal('tempoemprego', d.tempoemprego);
      setVal('cepemp',       d.cepemp);
      setVal('enderecoemp',  d.enderecoemp);
      setVal('numemp',       d.numemp);
      setVal('bairroemp',    d.bairroemp);
      setVal('cidadeemp',    d.cidadeemp);
      setVal('ufemp',        d.ufemp);
      setVal('dddtelemp',    d.dddtelemp);
      setVal('telemp',       d.telemp);
      setVal('funcao',       d.funcao);
      setVal('rendab',       d.rendab);

      // ── Referências ─────────────────────────────────────────────────────────
      setVal('ref1',       d.ref1);
      setVal('dddtelref1', d.dddtelref1);
      setVal('telref1',    d.telref1);
      setVal('ref2',       d.ref2);
      setVal('dddtelref2', d.dddtelref2);
      setVal('telref2',    d.telref2);

      // ── Dados da Garantia ───────────────────────────────────────────────────
      setVal('marca',      d.marca);
      setVal('modelo',     d.modelo);
      setVal('fabricacao', d.fabricacao);
      setVal('amodelo',    d.amodelo);
      setVal('placa',      d.placa);

      // Tipo: Moto
      document.querySelectorAll('input[name="tipo"]').forEach(r => {
        if (r.value === 'Moto') r.checked = true;
      });
      // Condição: Usado
      document.querySelectorAll('input[name="condicao"]').forEach(r => {
        if (r.id !== 'condNovo') r.checked = true;
      });

      // ── Informações da Loja ─────────────────────────────────────────────────
      setVal('dddtelcontato', d.dddtelcontato);
      setVal('telcontato',    d.telcontato);
      setVal('nomecontato',   d.nomecontato);
      setVal('lojacontato',   d.lojacontato);
      setVal('cidadecontato', d.cidadecontato);
      setVal('emailcontato',  d.emailcontato);
    }, dados);

    log.ok('[financiamento] Formulário preenchido');

    // ── 3. Screenshot antes de enviar ────────────────────────────────────────
    await page.screenshot({
      path: path.join(__dirname, 'logs', `ficha-${ficha.id}-antes.png`),
      fullPage: true,
    });

    // ── 4. Enviar ─────────────────────────────────────────────────────────────
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'));
      const enviar = btns.find(b =>
        (b.value && b.value.toLowerCase().includes('enviar')) ||
        (b.textContent && b.textContent.toLowerCase().includes('enviar'))
      );
      if (enviar) enviar.click();
    });

    await page.waitForTimeout(5000);

    await page.screenshot({
      path: path.join(__dirname, 'logs', `ficha-${ficha.id}-depois.png`),
      fullPage: true,
    });

    const urlAtual   = page.url();
    const conteudo   = (await page.content()).toLowerCase();
    const temErro    = conteudo.includes('erro') || urlAtual.includes('loginLoja');
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

// Reseta fichas presas em 'processando' (crash anterior sem marcarErro)
async function resetarFichasTravas() {
  const rows = await supabaseGet('financiamento_fichas?status=eq.processando');
  if (Array.isArray(rows) && rows.length > 0) {
    for (const r of rows) {
      await supabasePatch(`financiamento_fichas?id=eq.${r.id}`, {
        status: 'pendente',
        erro_msg: null,
      });
      log.warn(`[financiamento] Ficha travada ${r.id} (${r.nome}) → resetada para pendente`);
    }
  }
}

async function daemon() {
  log.info('[financiamento] Daemon iniciado. Aguardando fichas pendentes a cada 30s...');

  // Limpa fichas que ficaram em 'processando' por crash anterior
  await resetarFichasTravas();

  while (true) {
    try {
      const ficha = await buscarProximaFicha();

      if (ficha) {
        log.info(`[financiamento] Ficha encontrada: ${ficha.id} — ${ficha.nome}`);
        const marcou = await marcarProcessando(ficha.id);

        if (!marcou) {
          log.warn(`[financiamento] Falha ao marcar processando ${ficha.id} — pulando ciclo`);
        } else {
          try {
            await enviarFicha(ficha);
            await marcarEnviado(ficha.id);
          } catch (err) {
            log.error(`[financiamento] Erro ao enviar ficha ${ficha.id}: ${err.message}`);
            await marcarErro(ficha.id, err.message);
          }
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
