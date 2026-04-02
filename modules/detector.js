// Módulo 1 — Detecção de Contexto
// Responsável por determinar se a conversa atual é do Marketplace e qual veículo está vinculado

async function detectarContexto(page) {
  const url = page.url();

  // Extrai ID da conversa da URL do Messenger
  const convMatch = url.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
  const convId = convMatch ? convMatch[1] : null;

  if (!convId) {
    return { isMarketplace: false, convId: null, listingTitle: null, listingId: null };
  }

  const resultado = await page.evaluate(() => {
    // Indicador 1: existe link direto para item do Marketplace na conversa
    const linkMkt = document.querySelector('a[href*="/marketplace/item/"]');
    const temLinkMkt = !!linkMkt;

    // Indicador 2: textos típicos de conversa originada de anúncio
    const body = document.body.innerText || '';
    const temTextoMkt =
      body.includes('Você abriu esta conversa por meio de um anúncio') ||
      body.includes('sobre o seu classificado') ||
      body.includes('Agora vocês podem avaliar um ao outro');

    // Tenta extrair título do anúncio do card de produto
    let listingTitle = null;
    let listingId = null;

    if (linkMkt) {
      // Tenta pegar o aria-label ou texto do link
      listingTitle = (linkMkt.getAttribute('aria-label') || linkMkt.textContent || '').trim() || null;
      // Extrai ID do item da URL
      const idMatch = linkMkt.href.match(/\/marketplace\/item\/(\d+)/);
      if (idMatch) listingId = idMatch[1];
    }

    // Fallback: tenta pegar o título do produto do card visual
    if (!listingTitle) {
      const card = document.querySelector('[data-testid="marketplace_pdp_component"]');
      if (card) listingTitle = card.textContent?.trim() || null;
    }

    return { temLinkMkt, temTextoMkt, listingTitle, listingId };
  });

  const isMarketplace = resultado.temLinkMkt || resultado.temTextoMkt;

  return {
    isMarketplace,
    convId,
    listingTitle: resultado.listingTitle,
    listingId: resultado.listingId
  };
}

module.exports = { detectarContexto };
