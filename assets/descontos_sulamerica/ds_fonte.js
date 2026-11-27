/* De onde o painel de Descontos SulAmérica lê, e por onde ele pede o envio.
 *
 * Só leitura do bucket privado `hub-data` — a tela não grava nada no Supabase:
 *
 *   descontos_sulamerica.json            a aba do mês da Tabela de Descontos, publicada pelo
 *                                        Azure quando a aba é gravada, a cada abertura do
 *                                        painel e depois de cada envio. Os números são os da
 *                                        PRÓPRIA planilha: a tela não refaz conta.
 *   descontos_sulamerica.planilha.json   as abas desenhadas como no Excel ("ver planilha").
 *   descontos_sulamerica.<mes>.pdf       o PDF da SulAmérica do mês (o anexo).
 *   descontos_sulamerica.<mes>.xlsx      a planilha (o outro anexo), para baixar.
 *   descontos_sulamerica.envio.json      o resultado do último "Enviar e-mail". É o carimbo
 *                                        que diz à tela que o envio terminou.
 *
 * A policy de leitura é hub_can(split_part(name,'.',1)): todos começam com
 * `descontos_sulamerica.`, então quem abre o painel baixa os anexos pelo mesmo porteiro.
 *
 * O ENVIO NÃO SAI DAQUI. O botão pede à Edge Function `reprocessar` (que confere o
 * hub_can de quem clicou) a ação `enviar` — ou `reenviar`, para o mês que já foi —; o
 * Azure confere de novo (mês, trava de um envio por mês, aba mais recente da planilha) e
 * manda o e-mail com o mesmo código de sempre.
 */
window.DS_FONTE = (function () {
  'use strict';

  /* O id do painel vai escrito por extenso em `painel: '…'` (e não numa variável): é assim
   * que o test_rotas_reprocessar acha todo botão do hub e confere que ele tem destino. */
  var ARQUIVO = 'descontos_sulamerica.json';
  var ARQ_PLANILHA = 'descontos_sulamerica.planilha.json';
  var ARQ_ENVIO = 'descontos_sulamerica.envio.json';
  var BUCKET = 'hub-data';
  var TIPOS = { pdf: 'application/pdf',
                xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  var _sb = null;

  function cliente() {
    if (_sb) return _sb;
    /* Dentro do iframe o hub já tem sessão no mesmo domínio; este client a reaproveita.
     * Um client por página — ver o comentário de `cliente` em reprocessar.js. */
    if (!window.supabase || !window.SUPABASE_URL) {
      throw new Error('supabase-js não carregou (veja config.js e ../vendor/supabase.min.js)');
    }
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  /* null quando o arquivo não existe — primeira vez, ou envio ainda nunca pedido. */
  async function tentar(nome) {
    try {
      var dl = await cliente().storage.from(BUCKET).download(nome);
      if (dl.error || !dl.data) return null;
      return JSON.parse(await dl.data.text());
    } catch (e) {
      console.warn('[descontos_sulamerica] ' + nome + ' não lido:', e.message);
      return null;
    }
  }

  function carregar() { return tentar(ARQUIVO); }

  /* O desenho das abas é grande (~400 KB): baixado só quando alguém abre "ver planilha". */
  function carregarPlanilha() { return tentar(ARQ_PLANILHA); }

  /* URL local (blob:) de um anexo. Só nomes do próprio painel: o nome vem do JSON
   * publicado, mas conferir aqui impede que um arquivo adulterado faça a tela baixar
   * outra coisa do bucket. */
  async function urlArquivo(nome) {
    var m = /^descontos_sulamerica\.\d{4}-\d{2}\.(pdf|xlsx)$/.exec(String(nome));
    if (!m) throw new Error('nome de arquivo inesperado: ' + nome);
    var dl = await cliente().storage.from(BUCKET).download(nome);
    if (dl.error || !dl.data) {
      throw new Error((dl.error && dl.error.message) || 'arquivo não encontrado no Hub');
    }
    return URL.createObjectURL(new Blob([dl.data], { type: TIPOS[m[1]] }));
  }

  /* ligarEnvio(botao, status, acaoFn, mesFn, aoConcluir, aoFalhar)
   *
   *   acaoFn()   -> 'enviar' ou 'reenviar', lido NA HORA do clique
   *   mesFn()    -> mês da aba que a tela mostra; o Azure recusa se o painel já virou o mês
   *   aoConcluir(resultado) -> redesenha e devolve {texto, erro} para a linha de status
   *   aoFalhar() -> pedido recusado ou sem resposta: a tela desfaz o "enviando…"
   */
  function ligarEnvio(botao, status, acaoFn, mesFn, aoConcluir, aoFalhar) {
    if (!window.HUB_REPROCESSAR) return;
    window.HUB_REPROCESSAR.ligar({
      painel: 'descontos_sulamerica',
      botao: botao,
      status: status,
      cliente: cliente,
      corpo: function () { return { acao: acaoFn(), mes: mesFn() }; },
      rotulo: 'enviando…',
      aguardando: 'pedido enviado — o Azure está mandando o e-mail…',
      limite: 4 * 60000,
      lerCarimbo: async function () {
        var c = await tentar(ARQ_ENVIO);
        return c ? c.gerado_em : null;
      },
      aoConcluir: async function () {
        return aoConcluir(await tentar(ARQ_ENVIO));
      },
      aoFalhar: aoFalhar
    });
  }

  /* Relê a planilha no Drive e republica. Disparado ao abrir a tela, sem botão: alguém
   * pode ter corrigido um % ou uma nota à mão depois de a aba ser gravada. O carimbo é o
   * `gerado_em` do painel — o Azure republica mesmo sem mudança, senão a tela esperaria um
   * carimbo novo que nunca vem. */
  function conferirDrive(status, aoConcluir) {
    if (!window.HUB_REPROCESSAR) return Promise.resolve();
    return window.HUB_REPROCESSAR.pedir({
      painel: 'descontos_sulamerica',
      status: status,
      cliente: cliente,
      aguardando: 'conferindo a planilha no Drive…',
      limite: 2 * 60000,
      lerCarimbo: async function () {
        var d = await carregar();
        return d ? d.gerado_em : null;
      },
      aoConcluir: aoConcluir
    });
  }

  return { carregar: carregar, carregarPlanilha: carregarPlanilha, urlArquivo: urlArquivo,
           cliente: cliente, ligarEnvio: ligarEnvio, conferirDrive: conferirDrive };
})();
