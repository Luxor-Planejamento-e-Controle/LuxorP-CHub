/* De onde o deck lê: bucket privado `hub-data`, `<deck>.json` — o JSON que o
 * tools/build_apresentacoes.py gera e o publish_hub.py sobe (no fechamento trimestral
 * ou pelo "Atualizar agora" desta tela, que roda o mesmo build na Azure).
 *
 * O deck vem da URL: index.html?deck=comite_fo | board_fo. Cada um é uma aba do hub
 * com permissão própria (hub_can('<deck>')), e a policy do bucket usa o mesmo prefixo
 * do nome do arquivo — quem não tem a aba não baixa o JSON.
 *
 * file:// (demo local, ver CONTRIBUTING): sem sessão e sem bucket; o dado vem de
 * ../data/<deck>.js, gerado pelo build e git-ignorado.
 */
(function () {
  'use strict';

  var BUCKET = 'hub-data';
  var DECKS = {comite_fo: 1, board_fo: 1, carta: 1};
  var deck = new URLSearchParams(location.search).get('deck');
  var _sb = null;

  function cliente() {
    if (_sb) return _sb;
    if (!window.supabase || !window.SUPABASE_URL) throw new Error('supabase-js não carregou');
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  async function baixar() {
    var dl = await cliente().storage.from(BUCKET).download(deck + '.json');
    if (dl.error || !dl.data) throw new Error((dl.error && dl.error.message) || 'arquivo não encontrado');
    return JSON.parse(await dl.data.text());
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

  function erro(msg) {
    document.getElementById('stage').innerHTML = '<div class="vazio"><h2>Deck indisponível</h2><p></p></div>';
    document.querySelector('#stage .vazio p').textContent = msg;
  }

  /* O "Atualizar agora" refaz o trimestre MAIS RECENTE na Azure (pc_apresentacoes) e
   * mantém os anteriores como foram apresentados. Quem diz que terminou — e se deu certo —
   * é `<deck>.status.json`, gravado pela Azure no fim, com sucesso ou com o motivo. */
  async function status() {
    try {
      var dl = await cliente().storage.from(BUCKET).download(deck + '.status.json');
      return dl.data ? JSON.parse(await dl.data.text()) : null;
    } catch (e) { return null; }
  }

  function ligarAtualizar() {
    if (!window.HUB_REPROCESSAR || location.protocol === 'file:') return;
    window.HUB_REPROCESSAR.ligar({
      painel: deck,
      botao: document.getElementById('btn-atualizar'),
      status: document.getElementById('reproc-status'),
      cliente: cliente,
      aguardando: 'pedido enviado — a Azure está refazendo o trimestre corrente a partir das bases do fechamento…',
      limite: 6 * 60000,
      lerCarimbo: async function () {
        var s = await status();
        return s ? s.quando : null;
      },
      aoConcluir: async function () {
        var s = await status();
        if (s && !s.ok) return {texto: 'não atualizado: ' + s.mensagem, erro: true};
        location.reload();
      }
    });
  }

  /* Textos da carta: app_state, id 'carta' ({versao, trimestres: {<AAAA-QN>: ...}}).
   * Quem vê a aba lê; só admin grava (policy em sql/hub_schema.sql) — os textos do CEO e
   * a tradução são colados pelo Arthur. `_versao` é o updated_at de quando a tela abriu:
   * o UPDATE só casa se ninguém gravou no meio (mesma guarda do Tarituba). */
  var _versao = null;
  async function lerTextos() {
    var r = await cliente().from('app_state').select('data, updated_at').eq('id', 'carta').maybeSingle();
    if (r.error || !r.data) return {};
    _versao = r.data.updated_at;
    return (r.data.data && r.data.data.trimestres) || {};
  }
  async function salvarTextos(trimestres) {
    var agora = new Date().toISOString();
    var r = await cliente().from('app_state').update({data: {versao: 1, trimestres: trimestres}, updated_at: agora})
      .eq('id', 'carta').eq('updated_at', _versao).select('id, updated_at');
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    if (!r.data || !r.data.length) {
      throw new Error('outra pessoa gravou enquanto esta tela estava aberta, ou você não tem permissão. ' +
                      'Nada foi sobrescrito — recarregue e cole de novo.');
    }
    _versao = r.data[0].updated_at || agora;
    return trimestres;
  }
  function ehAdmin() {
    try { return !!(window.parent && window.parent.HUB && window.parent.HUB.role === 'admin'); } catch (e) { return false; }
  }

  async function boot() {
    if (!DECKS[deck]) { erro('Deck desconhecido: ' + (deck || '(nenhum)')); return; }
    // o botão antes do dado: é ele que faz a primeira publicação (lição do Tarituba)
    ligarAtualizar();
    var spec = null;
    if (location.protocol === 'file:') {
      try {
        await script('../data/' + deck + '.js');
        spec = window['APRESENTACAO_' + deck.toUpperCase()];
      } catch (e) { /* sem demo local */ }
    }
    if (!spec) {
      try { spec = await baixar(); } catch (e) {
        erro('O deck ainda não foi publicado no hub, ou você não tem acesso a ele (' + e.message + ').');
        return;
      }
    }
    var opcoes = {};
    if (deck === 'carta') {
      if (location.protocol === 'file:') {
        // demo local: edita em memória, sem gravar
        opcoes = {textos: {}, podeEditar: true, salvar: function (t) { return Promise.resolve(t); }};
      } else {
        opcoes = {textos: await lerTextos(), podeEditar: ehAdmin(), salvar: salvarTextos};
      }
    }
    try { window.AP_DECK.iniciar(spec, opcoes); } catch (e) { erro(e.message); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
