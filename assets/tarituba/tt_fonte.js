/* De onde o painel do Tarituba lê, e os dois botões que só existem no hub.
 *
 *   painel   bucket privado `hub-data`, `tarituba.json` — o mesmo payload que o
 *            extrair_dados.py gera na máquina, publicado pelo Azure toda segunda e pelo
 *            "Atualizar agora".
 *
 *   card     `tarituba.card.json` — o resultado do último "Criar card no Trello": link do
 *            card, ou o motivo de não ter saído. É por ele que a tela sabe que o pedido
 *            terminou (o carimbo muda), mesmo se a aba for fechada no meio.
 *
 * O app.js do painel lê `window.TARITUBA_DATA` no TOPO do arquivo, então ele só é
 * carregado depois que o dado chegou — por isso este arquivo injeta o <script> do app.js
 * em vez de o index.html listá-lo.
 *
 * O CARD É GERADO NO AZURE A PARTIR DESTE MESMO ARQUIVO PUBLICADO: o PDF sai com os
 * números que estão na tela. Se o painel estiver velho, o caminho é "Atualizar agora"
 * antes. Nenhuma chave passa por aqui: o pedido vai para a Edge Function `reprocessar`,
 * que confere hub_can('tarituba') de quem clicou.
 */
window.TARITUBA_HUB = (function () {
  'use strict';

  var BUCKET = 'hub-data';
  var ARQ = 'tarituba.json';
  var ARQ_CARD = 'tarituba.card.json';
  var _sb = null;

  function cliente() {
    if (_sb) return _sb;
    /* Dentro do iframe o hub já tem sessão no mesmo domínio; o client daqui a reaproveita
     * (mesmo storageKey), como nos outros painéis. Um client SÓ, compartilhado com o
     * reprocessar.js — dois GoTrueClient na mesma página disputam o lock do token. */
    if (!window.supabase || !window.SUPABASE_URL) {
      throw new Error('supabase-js não carregou (veja config.js e ../vendor/supabase.min.js)');
    }
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  async function baixar(arquivo) {
    var dl = await cliente().storage.from(BUCKET).download(arquivo);
    if (dl.error || !dl.data) {
      throw new Error((dl.error && dl.error.message) || 'arquivo não encontrado');
    }
    return JSON.parse(await dl.data.text());
  }

  // null quando o arquivo não existe (primeiro uso) — não é erro
  async function tentar(arquivo) {
    try { return await baixar(arquivo); } catch (e) { return null; }
  }

  function mostrarErro(msg) {
    var v = document.getElementById('view');
    if (v) {
      v.innerHTML = '<div class="card"><h2>Painel indisponível</h2><div class="hint"></div></div>';
      v.querySelector('.hint').textContent = msg;
    }
    var s = document.getElementById('sub');
    if (s) s.textContent = 'sem dado';
  }

  function script(src) {
    return new Promise(function (ok, falha) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = function () { falha(new Error(src + ' não carregou')); };
      document.body.appendChild(s);
    });
  }

  /* "Criar card no Trello" — chamado pelo app.js a cada render do Resumo Simplificado.
   * `mesFn` é lido no clique: o card é do mês que está na tela naquele momento. */
  function ligarCard(botao, status, mesFn) {
    if (!window.HUB_REPROCESSAR) return;
    window.HUB_REPROCESSAR.ligar({
      painel: 'tarituba',
      botao: botao,
      status: status,
      cliente: cliente,
      corpo: function () { return { acao: 'card_trello', mes: mesFn() }; },
      rotulo: 'criando card…',
      aguardando: 'pedido enviado — o Azure está gerando o PDF e o card…',
      limite: 3 * 60000,
      lerCarimbo: async function () {
        var c = await tentar(ARQ_CARD);
        return c ? c.gerado_em : null;
      },
      aoConcluir: async function () {
        var c = await tentar(ARQ_CARD);
        if (!c) return { texto: 'o pedido terminou, mas o resultado não pôde ser lido.', erro: true };
        if (!c.ok) return { texto: 'card não criado: ' + c.erro, erro: true };
        return {
          texto: (c.card_novo ? 'Card criado' : 'PDF novo anexado ao card que já existia')
                 + ' em "' + c.lista + '" (painel de ' + c.dados_de + ').',
          link: c.card_url,
          rotuloLink: 'abrir no Trello'
        };
      }
    });
  }

  function ligarAtualizar() {
    if (!window.HUB_REPROCESSAR) return;
    window.HUB_REPROCESSAR.ligar({
      painel: 'tarituba',
      botao: document.getElementById('btn-atualizar'),
      status: document.getElementById('reproc-status'),
      cliente: cliente,
      aguardando: 'pedido enviado — a consulta ao Bimer leva uns 10 minutos. '
                  + 'Pode fechar e voltar depois.',
      limite: 20 * 60000,
      lerCarimbo: async function () {
        var d = await tentar(ARQ);
        return d ? d.meta.gerado_em : null;
      },
      // o app.js lê o dado no topo do arquivo: recarregar é o jeito limpo de redesenhar
      aoConcluir: function () { location.reload(); }
    });
  }

  async function boot() {
    /* file:// (demo local do hub, ver CONTRIBUTING): sem sessão e sem bucket — o dado vem
     * de ../data/tarituba.js (`window.TARITUBA_DATA = {...}`), que é git-ignorado, se
     * alguém o tiver copiado do painel local. */
    if (location.protocol === 'file:') {
      try { await script('../data/tarituba.js'); } catch (e) { /* cai no bucket abaixo */ }
    }
    if (!window.TARITUBA_DATA) {
      try {
        window.TARITUBA_DATA = await baixar(ARQ);
      } catch (e) {
        mostrarErro('O painel ainda não foi publicado no hub, ou você não tem acesso a ele (' +
                    e.message + '). A publicação roda toda segunda às 9h.');
        return;
      }
    }
    ligarAtualizar();
    await script('app.js');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { ligarCard: ligarCard, cliente: cliente };
})();
