// Mapeia conversa (convId) -> veículo (vehicleId)
const { load, save } = require('./state');

function getAll() {
  return load('mappings.json');
}

function get(convId) {
  return getAll()[convId] || null;
}

function set(convId, vehicleId) {
  const m = getAll();
  m[convId] = vehicleId;
  save('mappings.json', m);
}

module.exports = { get, set, getAll };
