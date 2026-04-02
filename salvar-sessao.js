const { chromium } = require('playwright');
const path = require('path');

async function salvarSessao() {
  const perfilPath = path.join(__dirname, 'perfil-browser');
  console.log('Abrindo browser...');

  // Usa perfil persistente — salva cookies e sessão automaticamente
  const context = await chromium.launchPersistentContext(perfilPath, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR'
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com');

  console.log('\n👉 Faça o login manualmente no browser.');
  console.log('Depois que entrar no Facebook e ver o feed, volte aqui e pressione Enter.\n');

  await new Promise(resolve => process.stdin.once('data', resolve));

  console.log('✅ Sessão salva! Agora rode: node bot.js');
  await context.close();
  process.exit(0);
}

salvarSessao().catch(console.error);
