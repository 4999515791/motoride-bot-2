// Módulo 7 — Camada de Segurança
// Impede o sistema de agir fora do escopo do Marketplace

const TEXTOS_PROPRIOS = ['(49)', 'MotoRide', 'motoRide', 'WhatsApp', 'whatsapp'];

function verificar({ isMarketplace, convId, vehicleId, ultimaMensagem }) {
  if (!isMarketplace) {
    return { permitido: false, motivo: 'não é conversa do Marketplace' };
  }
  if (!convId) {
    return { permitido: false, motivo: 'ID da conversa não identificado' };
  }
  if (!vehicleId) {
    return { permitido: false, motivo: 'veículo não mapeado — adicione em data/mappings.json' };
  }
  if (!ultimaMensagem || ultimaMensagem.trim().length < 2) {
    return { permitido: false, motivo: 'mensagem vazia ou inválida' };
  }
  // Evita responder a própria mensagem enviada
  for (const t of TEXTOS_PROPRIOS) {
    if (ultimaMensagem.includes(t)) {
      return { permitido: false, motivo: 'mensagem parece ser própria resposta anterior' };
    }
  }
  return { permitido: true };
}

module.exports = { verificar };
