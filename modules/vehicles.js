const { load, save } = require('./state');

function getAll() {
  return load('vehicles.json');
}

function getById(id) {
  return getAll()[id] || null;
}

function save_vehicle(vehicle) {
  const vehicles = getAll();
  if (!vehicle.id) vehicle.id = 'v' + Date.now();
  vehicle.status = vehicle.status || 'rascunho';
  vehicle.criadoEm = vehicle.criadoEm || new Date().toISOString();
  vehicles[vehicle.id] = vehicle;
  save('vehicles.json', vehicles);
  return vehicle;
}

function list() {
  return Object.values(getAll());
}

function listAtivos() {
  return Object.values(getAll()).filter(v => v.status !== 'vendido');
}

// Tenta encontrar veículo por texto (modelo, marca, título do anúncio)
function buscarPorTexto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  const todos = listAtivos();
  return todos.find(v => {
    const campos = [v.marca, v.modelo, v.versao, v.ano].filter(Boolean).join(' ').toLowerCase();
    return t.includes(v.modelo?.toLowerCase()) || campos.includes(t) || t.includes(campos);
  }) || null;
}

module.exports = { getAll, getById, save_vehicle, list, listAtivos, buscarPorTexto };
