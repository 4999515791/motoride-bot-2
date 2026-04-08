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
    // Fallback: força via JS (funciona em campos disabled)
    try {
      await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (el) { el.disabled = false; el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }, seletor, String(valor));
    } catch {}
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

    // ── 2 a 7. Preenche TODO o formulário via JS (evita problemas com campos disabled) ──
    const vAnо   = extrairAno(ficha.veiculo_label);
    const vMarca  = extrairMarca(ficha.veiculo_label);
    const vModelo = extrairModelo(ficha.veiculo_label);

    function setVal(id, val) {
      const el = document.getElementById(id) || document.querySelector(`[name="${id}"]`);
      if (!el || val === null || val === undefined || val === '') return;
      el.disabled = false;
      el.classList.remove('disabled');
      if (el.tagName === 'SELECT') {
        for (const opt of el.options) {
          if (opt.value === String(val) || opt.text === String(val)) { el.value = opt.value; break; }
        }
      } else {
        el.value = String(val);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }

    await page.evaluate((d) => {
      // Simulação
      setVal('idTabela', d.idTabela);
      setVal('anoItem',  d.vAno);
      setVal('valor',    d.valorFinanciado);
      setVal('coeficiente', d.coefId);
      setVal('parcelas', d.parcelasId);
      setVal('parcela',  d.valorParcela);

      // Dados pessoais
      setVal('nome',       d.nome);
      setVal('nascimento', d.nascimento);
      setVal('mae',        d.mae);
      setVal('cpf',        d.cpf);
      setVal('dddcelular', d.dddCelular);
      setVal('celular',    d.celular);
      setVal('cep',        d.cep);
      setVal('endereco',   d.endereco);
      setVal('num',        d.numEnd);
      setVal('cidade',     d.cidade);
      setVal('ufend',      d.uf);
      setVal('anores',     d.anosResidencia);
      const bairroEl = document.querySelector('input[name="bairro"]:not([id*="emp"])');
      if (bairroEl) { bairroEl.value = d.bairro || ''; }
      if (d.moradia) setVal('moradia', d.moradia);
      const sexoRadios = document.querySelectorAll('input[name="sexo"]');
      if (sexoRadios.length > 0) sexoRadios[0].checked = true;

      // Dados profissionais
      setVal('empresa',     d.empresa);
      setVal('tempoemprego', d.tempoEmprego);
      setVal('cepemp',      d.cepEmp);
      setVal('enderecoemp', d.enderecoEmp);
      setVal('numemp',      d.numEmp);
      setVal('bairroemp',   d.bairroEmp);
      setVal('cidadeemp',   d.cidadeEmp);
      setVal('ufemp',       d.ufEmp);
      setVal('dddtelemp',   d.dddTelEmp);
      setVal('telemp',      d.telEmp);
      setVal('funcao',      d.funcao);
      setVal('rendab',      d.rendaBruta);

      // Referências
      setVal('ref1',       d.ref1Nome);
      setVal('dddtelref1', d.ref1Ddd);
      setVal('telref1',    d.ref1Tel);
      setVal('ref2',       d.ref2Nome);
      setVal('dddtelref2', d.ref2Ddd);
      setVal('telref2',    d.ref2Tel);

      // Garantia
      setVal('marca',      d.marca);
      setVal('modelo',     d.modelo);
      setVal('fabricacao', d.vAno);
      setVal('amodelo',    d.vAno);
      setVal('placa',      d.placa);
      document.querySelectorAll('input[name="tipo"]').forEach(r => { if (r.value === 'Moto') r.checked = true; });
      document.querySelectorAll('input[name="condicao"]').forEach(r => { if (r.id !== 'condNovo') r.checked = true; });

      // Dados da loja
      setVal('dddtelcontato', d.lojaDdd);
      setVal('telcontato',    d.lojaTel);
      setVal('nomecontato',   d.lojaNome);
      setVal('lojacontato',   d.loja);
      setVal('cidadecontato', d.lojaCidade);
      setVal('emailcontato',  d.lojaEmail);
    }, {
      idTabela:       String(idTabelaFinanciamento(ficha.tabela_fin)),
      vAno:           vAnо,
      valorFinanciado: ficha.valor_financiado ? Number(ficha.valor_financiado).toFixed(2).replace('.', ',') : '',
      coefId:         String(COEF_ID[ficha.coeficiente] || 2),
      parcelasId:     String(PARCELAS_ID[String(ficha.num_parcelas)] || 3),
      valorParcela:   ficha.valor_parcela ? Number(ficha.valor_parcela).toFixed(2) : '',
      nome:           (ficha.nome || '').trim(),
      nascimento:     formatarData(ficha.nascimento),
      mae:            (ficha.mae || '').trim(),
      cpf:            formatarCPF(ficha.cpf),
      dddCelular:     apenasDigitos(ficha.ddd_celular),
      celular:        apenasDigitos(ficha.celular),
      cep:            ficha.cep || '',
      endereco:       ficha.endereco || '',
      numEnd:         ficha.num_end || '',
      bairro:         ficha.bairro || '',
      cidade:         ficha.cidade || '',
      uf:             ficha.uf || '',
      moradia:        ficha.moradia || '',
      anosResidencia: String(ficha.anos_residencia || 1),
      empresa:        ficha.empresa || '',
      tempoEmprego:   ficha.tempo_emprego || '',
      cepEmp:         ficha.cep_emp || '',
      enderecoEmp:    ficha.endereco_emp || '',
      numEmp:         ficha.num_emp || '',
      bairroEmp:      ficha.bairro_emp || '',
      cidadeEmp:      ficha.cidade_emp || '',
      ufEmp:          ficha.uf_emp || '',
      dddTelEmp:      apenasDigitos(ficha.ddd_tel_emp),
      telEmp:         apenasDigitos(ficha.tel_emp),
      funcao:         ficha.funcao || '',
      rendaBruta:     ficha.renda_bruta || '',
      ref1Nome:       ficha.ref1_nome || '',
      ref1Ddd:        apenasDigitos(ficha.ref1_ddd),
      ref1Tel:        apenasDigitos(ficha.ref1_tel),
      ref2Nome:       ficha.ref2_nome || '',
      ref2Ddd:        apenasDigitos(ficha.ref2_ddd),
      ref2Tel:        apenasDigitos(ficha.ref2_tel),
      marca:          vMarca,
      modelo:         vModelo,
      placa:          ficha.veiculo_placa || '',
      lojaDdd:        AQUI_DDD_TEL,
      lojaTel:        AQUI_TEL,
      lojaNome:       AQUI_NOME_CONTATO,
      loja:           AQUI_LOJA,
      lojaCidade:     AQUI_CIDADE,
      lojaEmail:      AQUI_EMAIL,
    });

    log.ok('[financiamento] Formulário preenchido via JS');

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
