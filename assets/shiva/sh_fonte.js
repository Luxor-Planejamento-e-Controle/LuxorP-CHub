/* De onde o painel do Shiva lê, e o que só existe no hub: o botão "Atualizar agora" e o
 * cadastro de naturezas (app_state, id 'shiva'). Cópia do tt_fonte.js do Tarituba, com
 * duas diferenças:
 *
 *   - SEM o botão "Criar card no Trello" (decisão do Leonardo, 18/11/2026: o Shiva sobe
 *     sem card). Sem `ligarCard` aqui, o app.js nem desenha o botão.
 *   - o documento do cadastro tem `resumo` além de `naturezas`: as linhas da página
 *     Resumo, com o "exceto" (Dividendos a Pagar fora das Despesas Administrativas).
 *
 *   painel   bucket privado `hub-data`, `shiva.json` — o mesmo payload que o
 *            extrair_shiva.py gera na máquina, publicado pelo Azure toda segunda e pelo
 *            "Atualizar agora".
 *
 * O app.js do painel lê `window.SHIVA_DATA` no TOPO do arquivo, então ele só é carregado
 * depois que o dado chegou — por isso este arquivo injeta o <script> do app.js em vez de
 * o index.html listá-lo. Nenhuma chave passa por aqui: o pedido vai para a Edge Function
 * `reprocessar`, que confere hub_can('shiva') de quem clicou.
 */
window.SHIVA_HUB = (function () {
  'use strict';

  var BUCKET = 'hub-data';
  var ARQ = 'shiva.json';
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

  /* ------------------------------------------------ cadastro de naturezas
   *
   * `app_state`, id 'shiva' — policy por hub_can('shiva'): quem vê a aba edita, como no
   * Tarituba. O job do Azure lê este documento com a service_role e monta o painel a partir
   * dele (vazio = estrutura da planilha).
   *
   * `_versao` é o updated_at no instante em que a TELA abriu: o UPDATE só casa se a linha
   * ainda estiver nessa versão, então duas pessoas com o cadastro aberto não apagam o
   * trabalho uma da outra em silêncio (mesma guarda do tt_fonte.js). */
  var DOC = 'shiva';
  var _versao = null;

  async function lerCadastro() {
    var r = await cliente().from('app_state').select('data, updated_at').eq('id', DOC).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    if (!r.data) throw new Error('o documento do cadastro não existe no hub (falta o SQL de implantação)');
    var doc = window.SH_DADOS.normalizar(r.data.data);
    /* Vazio, o editor abriria uma lista em branco e quem gravasse criaria o cadastro do
     * zero sem a estrutura da planilha. O ponto de partida é o seed (cadastro_shiva.py). */
    if (!doc.naturezas.length) {
      throw new Error('o cadastro ainda não foi semeado no hub — o painel segue a estrutura da ' +
                      'planilha até o seed (gerado pelo cadastro_shiva.py) rodar');
    }
    _versao = r.data.updated_at;
    return doc;
  }

  async function quemSou() {
    try {
      var s = await cliente().auth.getSession();
      return (s.data && s.data.session && s.data.session.user && s.data.session.user.email) || null;
    } catch (e) { return null; }
  }

  /* Grava o cadastro inteiro (naturezas + linhas do Resumo), carimbando só a natureza que
   * MUDOU — carimbar tudo a cada gravação tornaria `atualizado_em` inútil para responder
   * "quem mexeu nesta natureza". */
  async function salvarCadastro(conteudo) {
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
    var novas = conteudo.naturezas.map(function (n) {
      var v = antes[n.cod];
      if (v && chave(v) === chave(n)) return v;
      return Object.assign({}, n, { atualizado_em: agora, atualizado_por: email });
    });
    var novo = Object.assign({}, estado, { versao: 1, naturezas: novas, resumo: conteudo.resumo });
    var r = await sb.from('app_state').update({ data: novo, updated_at: agora })
      .eq('id', DOC).eq('updated_at', _versao).select('id, updated_at');
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    if (!r.data || !r.data.length) {
      throw new Error('outra pessoa gravou o cadastro enquanto esta tela estava aberta. ' +
                      'Nada foi sobrescrito — volte ao painel, abra o cadastro de novo e refaça.');
    }
    _versao = r.data[0].updated_at || agora;
    return window.SH_DADOS.normalizar(novo);
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
        '<button type="button" class="btn-ghost" id="sh-voltar-erro" style="margin-top:12px">' +
        '← Voltar ao painel</button></div>';
      view.querySelector('.hint').textContent = e.message;
      document.getElementById('sh-voltar-erro').onclick = voltarAoPainel;
      return;
    }
    var D = window.SHIVA_DATA || {};
    window.SH_CADASTRO.abrir(view, {
      doc: doc,
      pendentes: D.pendentes || [],
      origem: (D.meta && D.meta.estrutura && D.meta.estrutura.origem) || 'planilha',
      gerado_em: D.meta && D.meta.gerado_em
      // sem `remonta`: no hub o cadastro vale a partir da próxima publicação do Azure
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
      painel: 'shiva',
      botao: document.getElementById('btn-atualizar'),
      status: document.getElementById('reproc-status'),
      cliente: cliente,
      aguardando: 'pedido enviado — a consulta ao Bimer leva uns 13 minutos. '
                  + 'Pode fechar e voltar depois.',
      limite: 25 * 60000,
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
     * de ../data/shiva.js (`window.SHIVA_DATA = {...}`), que é git-ignorado, se alguém o
     * tiver copiado do painel local. */
    if (location.protocol === 'file:') {
      try { await script('../data/shiva.js'); } catch (e) { /* cai no bucket abaixo */ }
    }
    /* ANTES de baixar o dado, de propósito (lição do Tarituba, 02/10/2026): é este botão
     * que faz a PRIMEIRA publicação. Ligado só depois do dado, ele aparecia na tela de
     * "Painel indisponível" e não fazia nada. */
    ligarAtualizar();
    if (!window.SHIVA_DATA) {
      try {
        window.SHIVA_DATA = await baixar(ARQ);
      } catch (e) {
        mostrarErro('O painel ainda não foi publicado no hub, ou você não tem acesso a ele (' +
                    e.message + '). Ele é publicado toda segunda às 10h — ou agora, pelo ' +
                    '"Atualizar agora" acima (uns 13 minutos).');
        return;
      }
    }
    await script('app.js');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { cliente: cliente, abrirCadastro: abrirCadastro };
})();
