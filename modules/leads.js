const { load, save } = require('./state');

function getAll() {
  return load('leads.json');
}

function get(convId) {
  return getAll()[convId] || null;
}

function upsert(convId, dados) {
  const leads = getAll();
  leads[convId] = {
    ...leads[convId],
    ...dados,
    convId,
    atualizadoEm: new Date().toISOString()
  };
  save('leads.json', leads);
  return leads[convId];
}

function setHistorico(convId, historico) {
  const leads = getAll();
  if (!leads[convId]) leads[convId] = { convId };
  // Mantém só as últimas 20 mensagens
  leads[convId].historico = historico.slice(-20);
  leads[convId].atualizadoEm = new Date().toISOString();
  save('leads.json', leads);
}

module.exports = { get, upsert, setHistorico, getAll };
