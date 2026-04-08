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

const AQUI_URL_LOGIN    = 'https://www.aquifinanciamentos.com.br/loja/index.php';
const AQUI_URL_FICHA   = 'https://www.aquifinanciamentos.com.br/loja/novaFichaCadastral.php';

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
  if (!Array.isArray(rows)) {
    log.warn(`[financiamento] Resposta inesperada do Supabase: ${JSON.stringify(rows)}`);
    return null;
  }
  log.info(`[financiamento] Fichas pendentes encontradas: ${rows.length}`);
  return rows.length > 0 ? rows[0] : null;
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

// Converte data ISO (YYYY-MM-DD) ou já em dd/mm/yyyy para dd/mm/yyyy
function formatarData(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
    const [y, m, d] = val.split('T')[0].split('-');
    return `${d}/${m}/${y}`;
  }
  return val; // já está no formato correto
}

// Formata CPF: 12345678900 → 123.456.789-00
function formatarCPF(val) {
  if (!val) return '';
  const digits = String(val).replace(/\D/g, '');
  if (digits.length !== 11) return val;
  return `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`;
}

// Remove tudo que não for dígito de um número de telefone
function apenasDigitos(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

// Extrai ano do veiculo_label: "Honda Biz 100 ES 2013" → "2013"
function extrairAno(label) {
  const m = (label || '').match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : String(new Date().getFullYear());
}

// Extrai marca: "Honda Biz 100 ES 2013" → "Honda"
function extrairMarca(label) {
  return (label || '').trim().split(' ')[0] || '';
}

// Extrai modelo: "Honda Biz 100 ES 2013" → "Biz 100"
function extrairModelo(label) {
  const partes = (label || '').trim().split(' ');
  if (partes.length <= 1) return label || '';
  const semMarca = partes.slice(1);
  // Remove versão (1 token) e ano (último token se 4 dígitos)
  if (/^(19|20)\d{2}$/.test(semMarca[semMarca.length - 1])) semMarca.pop();
  if (semMarca.length > 2) semMarca.pop(); // remove versão (ES, EX, LT, etc.)
  return semMarca.join(' ');
}

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

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    // ── 1. Login ─────────────────────────────────────────────────────────────
    await page.goto(AQUI_URL_LOGIN, { waitUntil: 'domcontentloaded' });
    // Preenche login e senha (tenta os seletores mais comuns de forms PHP)
    const loginInput = await page.$('input[name="login"]') || await page.$('input[name="usuario"]') || await page.$('input[type="text"]');
    const senhaInput = await page.$('input[name="senha"]') || await page.$('input[type="password"]');
    if (!loginInput || !senhaInput) throw new Error('Campos de login não encontrados na página');
    await loginInput.fill(AQUI_LOGIN);
    await senhaInput.fill(AQUI_SENHA);
    await page.click('input[type="submit"], button[type="submit"], button');
    await page.waitForTimeout(5000);
    log.info(`[financiamento] URL pós-login: ${page.url()}`);
    // Verifica se o login funcionou (redireciona para fora do login)
    if (page.url().includes('index.php') || page.url().includes('login')) {
      throw new Error('Falha no login — verifique AQUI_LOGIN e AQUI_SENHA no .env');
    }
    log.ok('[financiamento] Login realizado');

    // ── Navega explicitamente para o formulário de nova ficha ─────────────────
    log.info(`[financiamento] Abrindo formulário: ${AQUI_URL_FICHA}`);
    await page.goto(AQUI_URL_FICHA, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    log.info(`[financiamento] URL formulário: ${page.url()}`);

    // ── 2. Simulação / Método de Financiamento ────────────────────────────────
    const vAnо   = extrairAno(ficha.veiculo_label);
    const vMarca  = extrairMarca(ficha.veiculo_label);
    const vModelo = extrairModelo(ficha.veiculo_label);

    const idTabela = idTabelaFinanciamento(ficha.tabela_fin);
    await selecionarOpcao(page, '#idTabela', idTabela);
    await selecionarOpcao(page, '#anoItem',  vAnо);

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
    await preencherCampo(page, '#nascimento', formatarData(ficha.nascimento));
    await preencherCampo(page, '#mae',        ficha.mae);
    await preencherCampo(page, '#cpf',        formatarCPF(ficha.cpf));
    await preencherCampo(page, '#dddcelular', apenasDigitos(ficha.ddd_celular));
    await preencherCampo(page, '#celular',    apenasDigitos(ficha.celular));
    await preencherCampo(page, '#cep',        ficha.cep);
    await preencherCampo(page, '#endereco',   ficha.endereco);
    await preencherCampo(page, '#num',        ficha.num_end);
    await preencherCampo(page, 'input[name="bairro"]:not([id*="emp"])', ficha.bairro);
    await preencherCampo(page, '#cidade',     ficha.cidade);
    await preencherCampo(page, '#ufend',      ficha.uf);

    if (ficha.moradia) {
      await selecionarOpcao(page, '#moradia', ficha.moradia === 'Própria' ? 'Própria' : 'Alugada');
    }
    await preencherCampo(page, '#anores', ficha.anos_residencia || '1');

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
    await preencherCampo(page, '#dddtelemp',   apenasDigitos(ficha.ddd_tel_emp));
    await preencherCampo(page, '#telemp',      apenasDigitos(ficha.tel_emp));
    await preencherCampo(page, '#funcao',      ficha.funcao);
    await preencherCampo(page, '#rendab',      ficha.renda_bruta);

    log.ok('[financiamento] Dados profissionais preenchidos');

    // ── 5. Referências ────────────────────────────────────────────────────────
    if (ficha.ref1_nome) {
      await preencherCampo(page, '#ref1',       ficha.ref1_nome);
      await preencherCampo(page, '#dddtelref1', apenasDigitos(ficha.ref1_ddd));
      await preencherCampo(page, '#telref1',    apenasDigitos(ficha.ref1_tel));
    }
    if (ficha.ref2_nome) {
      await preencherCampo(page, '#ref2',       ficha.ref2_nome);
      await preencherCampo(page, '#dddtelref2', apenasDigitos(ficha.ref2_ddd));
      await preencherCampo(page, '#telref2',    apenasDigitos(ficha.ref2_tel));
    }

    log.ok('[financiamento] Referências preenchidas');

    // ── 6. Dados da Garantia (Moto — preenchidos pelo sistema) ───────────────
    await preencherCampo(page, '#marca',      vMarca);
    await preencherCampo(page, '#modelo',     vModelo);
    await preencherCampo(page, '#fabricacao', vAnо);
    await preencherCampo(page, '#amodelo',    vAnо);
    await preencherCampo(page, '#placa',      ficha.veiculo_placa || '');

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
    const temSucesso = conteudo.includes('sucesso') || conteudo.includes('enviado') || conteudo.includes('obrigado');

    // Extrai mensagens de erro do div de erros do formulário
    const errosForm = await page.evaluate(() => {
      const divErros = document.getElementById('divErros') || document.querySelector('.erros, .erro, [class*="erro"]');
      if (!divErros) return null;
      return divErros.innerText.trim();
    });

    if (errosForm) {
      log.warn(`[financiamento] Erros do formulário:\n${errosForm}`);
    }

    // Campos em vermelho/laranja
    const camposInvalidos = await page.evaluate(() => {
      const campos = document.querySelectorAll('input.erro, input[style*="background: red"], input[style*="background:red"], input[style*="background: orange"], select.erro');
      return Array.from(campos).map(el => el.id || el.name || el.className).filter(Boolean);
    });
    if (camposInvalidos.length > 0) {
      log.warn(`[financiamento] Campos inválidos: ${camposInvalidos.join(', ')}`);
    }

    const temErro = (errosForm && errosForm.length > 0) || urlAtual.includes('loginLoja') ||
                    (!temSucesso && conteudo.includes('divErros'));

    if (temErro && !temSucesso) {
      throw new Error(`Formulário retornou erro. URL: ${urlAtual}${errosForm ? ' | Erros: ' + errosForm.substring(0, 200) : ''}`);
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
