/* De onde o painel do Tarituba lê, e o que só existe no hub: os botões "Atualizar agora"
 * e "Criar card no Trello" e o cadastro de naturezas (app_state, id 'tarituba').
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

  /* ------------------------------------------------ cadastro de naturezas
   *
   * `app_state`, id 'tarituba' — a mesma tabela do cadastro do Controle de Pagamentos, com
   * policy por hub_can('tarituba'): quem vê a aba edita (decisão do Leonardo, 16/10/2026).
   * O job do Azure lê este documento com a service_role e monta o painel a partir dele.
   *
   * `_versao` é o updated_at no instante em que a TELA abriu: o UPDATE só casa se a linha
   * ainda estiver nessa versão, então duas pessoas com o cadastro aberto não apagam o
   * trabalho uma da outra em silêncio (mesma guarda do cp_fonte.js). */
  var DOC = 'tarituba';
  var _versao = null;

  async function lerCadastro() {
    var r = await cliente().from('app_state').select('data, updated_at').eq('id', DOC).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    if (!r.data) throw new Error('o documento do cadastro não existe no hub (falta o SQL de implantação)');
    _versao = r.data.updated_at;
    return window.TT_DADOS.normalizar(r.data.data);
  }

  async function quemSou() {
    try {
      var s = await cliente().auth.getSession();
      return (s.data && s.data.session && s.data.session.user && s.data.session.user.email) || null;
    } catch (e) { return null; }
  }

  /* Grava o cadastro inteiro, carimbando só o que MUDOU — carimbar tudo a cada gravação
   * tornaria `atualizado_em` inútil para responder "quem mexeu nesta natureza". */
  async function salvarCadastro(naturezas) {
    var sb = cliente();
    var lido = await sb.from('app_state').select('data').eq('id', DOC).maybeSingle();
    if (lido.error) throw new Error('app_state: ' + lido.error.message);
    var estado = (lido.data && lido.data.data) || {};
    var antes = {};
    (estado.naturezas || []).forEach(function (n) { antes[n.cod] = n; });
    var email = await quemSou();
    var agora = new Date().toISOString();
    var chave = function (n) {
      return JSON.stringify([n.ordem, n.aba, n.cod, n.nome, n.bimer, n.path]);
    };
    var novas = naturezas.map(function (n) {
      var v = antes[n.cod];
      if (v && chave(v) === chave(n)) return v;
      return Object.assign({}, n, { atualizado_em: agora, atualizado_por: email });
    });
    var novo = Object.assign({}, estado, { versao: 1, naturezas: novas });
    var r = await sb.from('app_state').update({ data: novo, updated_at: agora })
      .eq('id', DOC).eq('updated_at', _versao).select('id, updated_at');
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    if (!r.data || !r.data.length) {
      throw new Error('outra pessoa gravou o cadastro enquanto esta tela estava aberta. ' +
                      'Nada foi sobrescrito — volte ao painel, abra o cadastro de novo e refaça.');
    }
    _versao = r.data[0].updated_at || agora;
    return window.TT_DADOS.normalizar(novo);
  }

  /* Troca o painel pela tela do cadastro, no mesmo lugar (como o "Editar cadastro" do
   * Controle de Pagamentos) e volta com "← Voltar ao painel". */
  var ESCONDER = ['nav-slot', 'btn-export-pdf', 'btn-atualizar', 'btn-cadastro', 'banner-slot',
                  'reproc-status'];

  function mostrarPainel(sim) {
    ESCONDER.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = !sim;
    });
  }

  async function abrirCadastro() {
    var view = document.getElementById('view');
    if (typeof clearCharts === 'function') clearCharts();
    mostrarPainel(false);
    view.innerHTML = '<div class="card"><div class="hint">carregando o cadastro…</div></div>';
    window.scrollTo(0, 0);
    var doc;
    try {
      doc = await lerCadastro();
    } catch (e) {
      view.innerHTML = '<div class="card"><h2>Cadastro indisponível</h2><div class="hint"></div>' +
        '<button type="button" class="btn-ghost" id="tt-voltar-erro" style="margin-top:12px">' +
        '← Voltar ao painel</button></div>';
      view.querySelector('.hint').textContent = e.message;
      document.getElementById('tt-voltar-erro').onclick = voltarAoPainel;
      return;
    }
    var D = window.TARITUBA_DATA || {};
    window.TT_CADASTRO.abrir(view, {
      doc: doc,
      pendentes: D.pendentes || [],
      origem: (D.meta && D.meta.estrutura && D.meta.estrutura.origem) || 'planilha',
      gerado_em: D.meta && D.meta.gerado_em
    }, { salvar: salvarCadastro, voltar: voltarAoPainel });
  }

  function voltarAoPainel() {
    mostrarPainel(true);
    if (typeof render === 'function') render();
    window.scrollTo(0, 0);
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
    /* ANTES de baixar o dado, de propósito: é este botão que faz a PRIMEIRA publicação.
     * Ligado só depois do dado, ele aparecia na tela de "Painel indisponível" e não fazia
     * nada — o painel nunca publicado não tinha como se publicar pela tela (achado no
     * primeiro uso, 02/10/2026). O carimbo de antes é null, e qualquer publicação o muda. */
    ligarAtualizar();
    if (!window.TARITUBA_DATA) {
      try {
        window.TARITUBA_DATA = await baixar(ARQ);
      } catch (e) {
        mostrarErro('O painel ainda não foi publicado no hub, ou você não tem acesso a ele (' +
                    e.message + '). Ele é publicado toda segunda às 9h — ou agora, pelo ' +
                    '"Atualizar agora" acima (uns 10 minutos).');
        return;
      }
    }
    await script('app.js');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { ligarCard: ligarCard, cliente: cliente, abrirCadastro: abrirCadastro };
})();
