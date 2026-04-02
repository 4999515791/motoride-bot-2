// cadastrar.js — Gera rascunhos de veículos a partir das pastas de fotos
// Uso: node cadastrar.js
const fs   = require('fs');
const path = require('path');

const FOTOS_BASE    = 'C:\\Users\\User\\Desktop\\motos para postagem';
const VEHICLES_FILE = path.join(__dirname, 'data', 'vehicles.json');

function loadVehicles() {
  try { return JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf8')); } catch { return {}; }
}

function gerarId(existentes) {
  let n = Object.keys(existentes).length + 1;
  while (existentes[`v${n}`]) n++;
  return `v${n}`;
}

// Tenta extrair ano da pasta (últimos 4 dígitos que parecem ano)
function extrairAno(nomePasta) {
  const m = nomePasta.match(/\b(19|20)\d{2}\b/g);
  return m ? m[m.length - 1] : '';
}

// Tenta detectar tipo pelo nome da pasta
function detectarTipo(nomePasta) {
  const n = nomePasta.toLowerCase();
  const motos = ['cg','titan','fan','biz','bros','cb','fazer','lander','mt','xre','pcx','lead','pop','nc','nxr','ybr','factor','neo','burgman','dafra','shineray','haojue'];
  for (const m of motos) {
    if (n.includes(m)) return 'moto';
  }
  return 'carro';
}

function main() {
  const veiculos = loadVehicles();

  // Pastas já cadastradas
  const pastasCadastradas = new Set(
    Object.values(veiculos).map(v => v.pastaFotos)
  );

  if (!fs.existsSync(FOTOS_BASE)) {
    console.error(`Pasta não encontrada: ${FOTOS_BASE}`);
    process.exit(1);
  }

  const pastas = fs.readdirSync(FOTOS_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let criados = 0;
  let pulados = 0;

  for (const pasta of pastas) {
    if (pastasCadastradas.has(pasta)) {
      console.log(`  [já existe] ${pasta}`);
      pulados++;
      continue;
    }

    const id   = gerarId(veiculos);
    const ano  = extrairAno(pasta);
    const tipo = detectarTipo(pasta);

    veiculos[id] = {
      id,
      tipo,
      loja: 'MotoRide',
      marca: '',
      modelo: '',
      modeloMkt: '',
      versao: '',
      ano,
      cor: '',
      quilometragem: '',
      preco: '',
      documento: '100% em dia, transferência imediata',
      transfere: 'sim',
      estadoMecanico: '',
      estadoEstetico: '',
      diferenciais: '',
      aceitaTroca: true,
      financiamento: 'aprovação facilitada, inclusive negativados',
      observacoes: '',
      carroceria: tipo === 'carro' ? '' : null,
      corExterna: '',
      corInterna: tipo === 'carro' ? '' : null,
      condicao: 'Excelente',
      combustivel: '',
      cambio: '',
      pastaFotos: pasta,
      status: 'rascunho'
    };

    console.log(`  [criado] ${id} — ${pasta}`);
    criados++;
  }

  fs.writeFileSync(VEHICLES_FILE, JSON.stringify(veiculos, null, 2), 'utf8');

  console.log(`\n✓ ${criados} veículo(s) criado(s) como rascunho`);
  console.log(`  ${pulados} já estavam cadastrados`);
  console.log(`\nAbra data/vehicles.json e preencha os campos vazios de cada veículo.`);
  console.log(`Quando um veículo estiver completo, mude status de "rascunho" para "ativo".`);
  console.log(`\nCampos obrigatórios para postar:`);
  console.log(`  marca, modelo, modeloMkt, ano, cor, quilometragem, preco`);
  console.log(`  estadoMecanico, estadoEstetico, diferenciais, combustivel, cambio`);
  console.log(`  corExterna (para carros), pastaFotos (já preenchido)`);
}

main();
