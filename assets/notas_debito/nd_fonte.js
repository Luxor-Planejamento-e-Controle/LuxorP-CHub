/* De onde o painel de Notas de Débito lê, e por onde ele pede o envio.
 *
 * Só leitura do bucket privado `hub-data` — a tela não grava nada no Supabase:
 *
 *   notas_debito.json           o lote do mês, publicado pelo Azure toda vez que uma nota é
 *                               gerada (POOL no dia 25, INV quando chega o PDF da
 *                               SulAmérica) e depois de cada envio. Já vem com a situação
 *                               de cada e-mail e EM ORDEM DE VENCIMENTO: a tela não refaz
 *                               conta que a fonte já traz.
 *   notas_debito.<mes>.<x>.pdf  o PDF de cada nota, o mesmo que vai anexado no e-mail.
 *   notas_debito.envio.json     o resultado do último "Enviar" (quem, o que saiu, o que
 *                               falhou). É o carimbo que diz à tela que o envio terminou.
 *
 * A policy de leitura é hub_can(split_part(name,'.',1)): todos os arquivos começam com
 * `notas_debito.`, então quem abre o painel baixa os PDFs pelo mesmo porteiro — e quem
 * não tem acesso ao painel não baixa nenhum.
 *
 * O ENVIO NÃO SAI DAQUI. O botão pede à Edge Function `reprocessar` (que confere o
 * hub_can de quem clicou) a ação `enviar` do painel, com os nomes marcados; o Azure
 * confere de novo contra o lote (só envia o que está pronto e ainda não foi) e manda os
 * e-mails com o mesmo código do bot do Slack.
 */
window.ND_FONTE = (function () {
  'use strict';

  var ARQUIVO = 'notas_debito.json';
  var ARQ_ENVIO = 'notas_debito.envio.json';
  var BUCKET = 'hub-data';
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
      console.warn('[notas_debito] ' + nome + ' não lido:', e.message);
      return null;
    }
  }

  async function carregar() {
    return tentar(ARQUIVO);
  }

  /* URL local (blob:) do PDF, para o visualizador e para o botão de baixar. Só nomes do
   * próprio painel: o nome vem do JSON publicado, mas conferir aqui impede que um arquivo
   * adulterado faça a tela baixar outra coisa do bucket. */
  async function urlPdf(nome) {
    if (!/^notas_debito\.[\w.-]+\.pdf$/.test(String(nome))) {
      throw new Error('nome de PDF inesperado: ' + nome);
    }
    var dl = await cliente().storage.from(BUCKET).download(nome);
    if (dl.error || !dl.data) {
      throw new Error((dl.error && dl.error.message) || 'PDF não encontrado no Hub');
    }
    return URL.createObjectURL(new Blob([dl.data], { type: 'application/pdf' }));
  }

  /* ligarEnvio(botao, status, nomesFn, mesFn, aoConcluir, aoFalhar)
   *
   *   nomesFn()  -> chaves dos envios marcados, lidas NA HORA do clique
   *   mesFn()    -> mês do lote que a tela mostra; o Azure recusa se o lote já virou o mês
   *   aoConcluir(resultado) -> redesenha e devolve {texto, erro} para a linha de status
   *   aoFalhar() -> pedido recusado ou sem resposta: a tela desfaz o "enviando…"
   */
  function ligarEnvio(botao, status, nomesFn, mesFn, aoConcluir, aoFalhar) {
    if (!window.HUB_REPROCESSAR) return;
    window.HUB_REPROCESSAR.ligar({
      painel: 'notas_debito',
      botao: botao,
      status: status,
      cliente: cliente,
      corpo: function () { return { acao: 'enviar', mes: mesFn(), nomes: nomesFn() }; },
      rotulo: 'enviando…',
      aguardando: 'pedido enviado — o Azure está mandando os e-mails…',
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

  /* Confere a planilha de cada nota no Drive e republica o lote. Disparado ao abrir a
   * tela, sem botão: a nota pode ter sido corrigida à mão no .xlsx depois de gerada, e
   * aí o Azure relê o bloco do mês (valor, vencimento, itens) e refaz o PDF no modelo
   * padrão. O carimbo é o `gerado_em` do lote — o Azure republica mesmo sem mudança,
   * senão a tela esperaria um carimbo novo que nunca vem. */
  function conferirDrive(status, aoConcluir) {
    if (!window.HUB_REPROCESSAR) return Promise.resolve();
    return window.HUB_REPROCESSAR.pedir({
      painel: 'notas_debito',
      status: status,
      cliente: cliente,
      aguardando: 'conferindo as planilhas no Drive…',
      limite: 2 * 60000,
      lerCarimbo: async function () {
        var d = await carregar();
        return d ? d.gerado_em : null;
      },
      aoConcluir: aoConcluir
    });
  }

  return { carregar: carregar, urlPdf: urlPdf, cliente: cliente, ligarEnvio: ligarEnvio,
           conferirDrive: conferirDrive };
})();
