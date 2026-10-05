// Para onde cada painel vai no Azure — a tabela que decide o destino do "Atualizar agora".
//
// POR QUE UMA TABELA (05/10/2026). Antes havia UM par de secrets, AZURE_REPROCESSAR_URL/
// KEY, que nasceu como "a rota do Automacoes" e virou a base compartilhada quando a
// inadimplência ganhou rota própria. Apontar esse par para a rota da inadimplência (o que
// aconteceu em 05/10, 09:25) fez todo painel que NÃO é inadimplência receber "painel
// desconhecido" — e a inadimplência seguia funcionando, então nada parecia quebrado.
//
// Agora cada destino tem o PRÓPRIO par de secrets, com dono, e nenhum é base do outro:
// mexer num não derruba o outro. E a rota esperada de cada destino fica aqui no código —
// secret apontando para a rota de outro destino vira erro que diz qual secret está errado,
// em vez de um 400 do Azure que parece problema do painel.
//
// Painel novo com botão: entra aqui. Painel fora da tabela recebe 400 na própria Edge
// Function, antes de chegar ao Azure.
//
// JavaScript puro e sem Deno.env de propósito: `destino` recebe as variáveis de fora, e
// o teste (assets/test_rotas_reprocessar.py) roda este arquivo no Chromium do CI.

const AUTOMACOES = {
  url: 'AZURE_AUTOMACOES_URL', chave: 'AZURE_AUTOMACOES_KEY',
  rota: '/api/reprocessar',            // reprocessar_painel, repo Automacoes (Leonardo)
}
const INADIMPLENCIA = {
  url: 'AZURE_INADIMPLENCIA_URL', chave: 'AZURE_INADIMPLENCIA_KEY',
  rota: '/api/pc/inadimplencia',       // pc_inadimplencia, luxor-planejamento-functions (Arthur)
}

export const ROTAS = {
  saldo_bancario: AUTOMACOES,
  controle_pagamentos: AUTOMACOES,
  tarituba: AUTOMACOES,
  inadimplencia: INADIMPLENCIA,
}

/* {url, chave} do destino do painel, ou {erro, status} dizendo o que falta.
 * `env(nome)` devolve o valor da variável (Deno.env.get na função publicada). */
export function destino(painel, env) {
  const d = Object.prototype.hasOwnProperty.call(ROTAS, painel) ? ROTAS[painel] : null
  if (!d) return { erro: 'este painel não tem "Atualizar agora"', status: 400 }

  const url = (env(d.url) || '').trim()
  const chave = (env(d.chave) || '').trim()
  if (!url || !chave) return { erro: `${d.url}/${d.chave} não configurados`, status: 500 }

  let caminho
  try {
    caminho = new URL(url).pathname.replace(/\/+$/, '')
  } catch {
    return { erro: `${d.url} não é uma URL válida`, status: 500 }
  }
  if (caminho !== d.rota) {
    return { erro: `${d.url} aponta para ${caminho || '/'}, mas este painel vai para ${d.rota}`,
             status: 500 }
  }
  return { url, chave }
}
