// Módulo 6 — Motor de Resposta Comercial
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPrompt(vehicle) {
  const v = vehicle;
  const preco = v.preco ? `R$ ${v.preco}` : 'a combinar';
  const km = v.quilometragem ? `${v.quilometragem} km` : 'não informado';
  const troca = v.aceitaTroca ? 'aceita troca' : 'não aceita troca';
  const financ = v.financiamento || 'consultar condições';

  return `Você é João, vendedor da MotoRide, loja de ${v.tipo === 'moto' ? 'motos' : 'carros'} seminovos em SC.
Você está atendendo um lead no Facebook Marketplace sobre este veículo:

VEÍCULO:
- ${v.tipo?.toUpperCase() || 'VEÍCULO'}: ${[v.marca, v.modelo, v.versao, v.ano].filter(Boolean).join(' ')}
- Cor: ${v.cor || 'não informado'}
- Km: ${km}
- Preço: ${preco}
- Documento: ${v.documento || 'em dia'}
- Mecânica: ${v.estadoMecanico || 'boa, revisada'}
- Estética: ${v.estadoEstetico || 'conservada'}
- Troca: ${troca}
- Financiamento: ${financ}
- Diferenciais: ${v.diferenciais || 'não informado'}
${v.observacoes ? `- Obs: ${v.observacoes}` : ''}

REGRAS:
- Responda como vendedor humano, direto e natural
- Máximo 3 linhas por resposta
- NUNCA invente dados que não estão na ficha acima
- Se não souber algo, diga "deixa eu verificar pra você"
- Sempre tente avançar: visita, WhatsApp, proposta
- WhatsApp para fechar: (49) 99951-5791
- Sem bullet points, texto corrido
- Linguagem brasileira informal
- Financiamento: aprovação facilitada, inclusive negativados`;
}

async function gerar(vehicle, historico, mensagem) {
  const messages = (historico || []).map(m => ({
    role: m.de === 'eu' ? 'assistant' : 'user',
    content: m.texto
  }));
  messages.push({ role: 'user', content: mensagem });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: buildPrompt(vehicle),
    messages
  });

  return response.content[0].text;
}

module.exports = { gerar };
