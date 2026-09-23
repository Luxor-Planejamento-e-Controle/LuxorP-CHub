// Porteiro do botão "Atualizar agora" dos painéis.
//
// O painel roda no navegador, num site público: não pode carregar chave nenhuma do
// Azure. Esta função é o intermediário — ela está do lado de dentro, confere quem pediu
// e só então chama o Azure com a chave que guarda.
//
//     painel --JWT do usuário--> [esta função] --chave da função--> Azure --fila--> ETL
//
// DOIS CONTROLES, EM CAMADAS DIFERENTES:
//
//   aqui       quem é a pessoa e se ela pode ver ESTE painel (hub_can), a mesma regra
//              que decide o que ela enxerga no hub — não uma segunda lista para manter
//   no Azure   se este painel pode ser reprocessado (lista fechada em shared_reprocessar)
//
// A chave guardada em AZURE_REPROCESSAR_KEY é a da função `reprocessar_painel`, NÃO a
// master key do Function App. Se este projeto for comprometido, o que se perde é "alguém
// reprocessa um painel", não o controle das 15 automações.
//
// Deploy:
//   supabase functions deploy reprocessar --project-ref hjducsxcolbspbkpflom
//   supabase secrets set AZURE_REPROCESSAR_URL=... AZURE_REPROCESSAR_KEY=...

import { createClient } from 'jsr:@supabase/supabase-js@2'

// O JWT viaja no header Authorization, não em cookie, então o navegador nunca o manda
// sozinho — não há o risco de CSRF que faria '*' ser imprudente aqui. Ainda assim dá
// para fechar por origem definindo HUB_ORIGENS, se um dia o hub tiver domínio fixo.
const ORIGENS = (Deno.env.get('HUB_ORIGENS') ?? '*')
  .split(',').map((o) => o.trim()).filter(Boolean)

/* O supabase-js manda mais cabeçalhos do que os óbvios — `x-client-info` em toda
 * requisição, e `x-supabase-api-version` nas versões novas. Se o preflight não autorizar
 * TODOS, o navegador bloqueia a chamada antes de sair, e o supabase-js reporta isso como
 * "Failed to send a request to the Edge Function" — erro de envio para um problema de
 * permissão de cabeçalho.
 *
 * Foi assim que o botão quebrou em produção passando em todos os testes: curl não faz
 * preflight sozinho, e o teste de navegador interceptava a rota antes da rede. O preflight
 * de verdade só acontece contra a função publicada.
 *
 * Por isso aqui se ECOA o que o navegador pediu, em vez de manter uma lista à mão que
 * envelhece a cada versão do supabase-js. Ecoar não afrouxa nada: quem decide o acesso é
 * o JWT conferido abaixo, e CORS nunca foi controle de autorização — só impede que OUTRA
 * página use a sessão de quem está no navegador. */
const CABECALHOS_PADRAO = 'authorization, content-type, apikey, x-client-info, ' +
  'x-supabase-api-version'

function cors(req: Request): Record<string, string> {
  const origem = req.headers.get('Origin') ?? ''
  const permitida = ORIGENS.includes('*') ? '*'
    : (ORIGENS.includes(origem) ? origem : '')
  const pedidos = req.headers.get('Access-Control-Request-Headers')
  return {
    'Access-Control-Allow-Origin': permitida,
    'Access-Control-Allow-Headers': pedidos || CABECALHOS_PADRAO,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin, Access-Control-Request-Headers',
  }
}

function json(req: Request, corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { erro: 'use POST' }, 405)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    return json(req, { erro: 'não autenticado' }, 401)
  }

  let painel = ''
  try {
    painel = String(((await req.json()) ?? {}).painel ?? '').trim()
  } catch {
    return json(req, { erro: 'corpo inválido' }, 400)
  }
  if (!painel) return json(req, { erro: 'informe o painel' }, 400)

  // Client COM o crachá de quem clicou: é o que faz hub_can() enxergar o e-mail certo.
  // Com a service_role aqui, hub_can() avaliaria o robô e liberaria tudo para todos.
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  )

  const { data: usuario, error: erroUsuario } = await sb.auth.getUser()
  if (erroUsuario || !usuario?.user) {
    return json(req, { erro: 'não autenticado' }, 401)
  }

  const { data: pode, error: erroPode } = await sb.rpc('hub_can', { dash: painel })
  if (erroPode) {
    return json(req, { erro: `falha ao verificar acesso: ${erroPode.message}` }, 500)
  }
  if (pode !== true) {
    // Mesma resposta para "não tem acesso" e "painel não existe": distinguir contaria a
    // quem não pode entrar quais painéis existem.
    return json(req, { erro: 'sem acesso a este painel' }, 403)
  }

  const url = Deno.env.get('AZURE_REPROCESSAR_URL')
  const chave = Deno.env.get('AZURE_REPROCESSAR_KEY')
  if (!url || !chave) {
    return json(req, { erro: 'AZURE_REPROCESSAR_URL/KEY não configurados' }, 500)
  }

  let resposta: Response
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-functions-key': chave },
      body: JSON.stringify({ painel, pedido_por: usuario.user.email }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    // O Azure só ENFILEIRA nesta chamada, então ela é rápida; se nem isso respondeu,
    // o pedido não entrou e quem clicou precisa saber — não pode ficar esperando um
    // resultado que nunca vem.
    return json(req, { erro: `Azure não respondeu: ${e}` }, 502)
  }

  const texto = await resposta.text()
  if (!resposta.ok) {
    return json(req, { erro: `Azure recusou (${resposta.status}): ${texto}` }, 502)
  }

  let detalhe: unknown = texto
  try { detalhe = JSON.parse(texto) } catch { /* texto puro serve */ }

  return json(req, {
    aceito: true,
    painel,
    pedido_por: usuario.user.email,
    azure: detalhe,
  }, 202)
})
