// Módulo de Log — grava no console e em arquivo diário
const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function ts() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

function write(nivel, msg) {
  const linha = `[${ts()}] [${nivel.padEnd(4)}] ${msg}`;
  console.log(linha);
  try {
    fs.appendFileSync(
      path.join(LOGS_DIR, `bot-${hoje()}.log`),
      linha + '\n',
      'utf8'
    );
  } catch { /* sem crash por falha de log */ }
}

module.exports = {
  info:  msg => write('INFO', msg),
  ok:    msg => write('OK',   msg),
  warn:  msg => write('WARN', msg),
  error: msg => write('ERRO', msg),
  dry:   msg => write('DRY',  msg),
};
