/* De onde o painel da FPG (Fazenda Pão Grande) lê, e o que só existe no hub: o botão
 * "Atualizar agora", o cadastro de naturezas (app_state, id 'fpg') e as movimentações manuais
 * (app_state, id 'fpg_manuais'). Cópia do pc_fonte.js do Passivo Hoteleiro, com as mesmas
 * diferenças em relação ao tt_fonte.js do Tarituba, e uma a mais:
 *
 *   - SEM o botão "Criar card no Trello" (decisão do Leonardo, 24/11/2026: a FPG sobe sem
 *     card, como o Shiva e o Passivo). Sem `ligarCard` aqui, o app.js nem desenha o botão.
 *   - o documento do cadastro tem `resumo` além de `naturezas` (as linhas da página Resumo).
 *   - MOVIMENTAÇÕES MANUAIS (só a FPG tem, 28/10/2026): o papel da aba Base da planilha —
 *     avulsa, reclassificação, mudar mês —, gravadas aqui no app_state 'fpg_manuais' e lidas
 *     pelo job do Azure, que as soma nas naturezas. A tela (fpg_manuais.js) é a mesma do
 *     painel local; o carimbo (id, ano, quem, quando) é posto AQUI, a partir do que está
 *     gravado, como o abrir_painel.py faz no local.
 *
 *   painel   bucket privado `hub-data`, `fpg.json` — o mesmo payload que o extrair_fpg.py
 *            gera na máquina, publicado pelo Azure toda segunda e pelo "Atualizar agora".
 *
 * O app.js do painel lê `window.FPG_DATA` no TOPO do arquivo, então ele só é carregado depois
 * que o dado chegou — por isso este arquivo injeta o <script> do app.js em vez de o index.html
 * listá-lo. Nenhuma chave passa por aqui: o pedido vai para a Edge Function `reprocessar`,
 * que confere hub_can('fpg') de quem clicou.
 */
window.FPG_HUB = (function () {
  'use strict';

  var BUCKET = 'hub-data';
  var ARQ = 'fpg.json';
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

  async function quemSou() {
    try {
      var s = await cliente().auth.getSession();
      return (s.data && s.data.session && s.data.session.user && s.data.session.user.email) || null;
    } catch (e) { return null; }
  }

  /* Troca o painel pela tela do cadastro (ou das movimentações), no mesmo lugar (como o
   * "Editar cadastro" do Controle de Pagamentos) e volta com "← Voltar ao painel". */
  var ESCONDER = ['nav-slot', 'btn-export-pdf', 'btn-atualizar', 'btn-cadastro', 'btn-manuais',
                  'banner-slot', 'reproc-status'];

  function mostrarPainel(sim) {
    ESCONDER.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = !sim;
    });
  }

  function telaDeErro(view, titulo, msg) {
    view.innerHTML = '<div class="card"><h2></h2><div class="hint"></div>' +
      '<button type="button" class="btn-ghost" id="fpg-voltar-erro" style="margin-top:12px">' +
      '← Voltar ao painel</button></div>';
    view.querySelector('h2').textContent = titulo;
    view.querySelector('.hint').textContent = msg;
    document.getElementById('fpg-voltar-erro').onclick = voltarAoPainel;
  }

  /* ------------------------------------------------ cadastro de naturezas
   *
   * `app_state`, id 'fpg' — policy por hub_can('fpg'): quem vê a aba edita, como no Tarituba.
   * O job do Azure lê este documento com a service_role e monta o painel a partir dele (vazio
   * = estrutura da planilha).
   *
   * `_versao` é o updated_at no instante em que a TELA abriu: o UPDATE só casa se a linha
   * ainda estiver nessa versão, então duas pessoas com o cadastro aberto não apagam o
   * trabalho uma da outra em silêncio (mesma guarda do tt_fonte.js). */
  var DOC = 'fpg';
  var _versao = null;

  async function lerCadastro() {
    var r = await cliente().from('app_state').select('data, updated_at').eq('id', DOC).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    if (!r.data) throw new Error('o documento do cadastro não existe no hub (falta o SQL de implantação)');
    var doc = FPG_DADOS.normalizar(r.data.data);
    /* Vazio, o editor abriria uma lista em branco e quem gravasse criaria o cadastro do
     * zero sem a estrutura da planilha. O ponto de partida é o seed (cadastro_fpg.py). */
    if (!doc.naturezas.length) {
      throw new Error('o cadastro ainda não foi semeado no hub — o painel segue a estrutura da ' +
                      'planilha até o seed (gerado pelo cadastro_fpg.py) rodar');
    }
    _versao = r.data.updated_at;
    return doc;
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
    return FPG_DADOS.normalizar(novo);
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
      telaDeErro(view, 'Cadastro indisponível', e.message);
      return;
    }
    var D = window.FPG_DATA || {};
    window.SH_CADASTRO.abrir(view, {
      doc: doc,
      pendentes: D.pendentes || [],
      origem: (D.meta && D.meta.estrutura && D.meta.estrutura.origem) || 'planilha',
      gerado_em: D.meta && D.meta.gerado_em
      // sem `remonta`: no hub o cadastro vale a partir da próxima publicação do Azure
    }, { salvar: salvarCadastro, voltar: voltarAoPainel });
  }

  /* ------------------------------------------------ movimentações manuais
   *
   * `app_state`, id 'fpg_manuais' — {versao, movimentos: [...]}; mesma policy e a mesma
   * guarda de versão do cadastro. As regras do que cada tipo soma moram no repo Automacoes
   * (`shared_fpg/manuais.py`), que o job usa; aqui só o que o abrir_painel.py faz ao gravar:
   * conferir a forma e carimbar. A tela não deixa escolher natureza nem mês fora da lista,
   * então a conferência daqui é a da forma (motivo, valor, meses, de ≠ para). */
  var DOC_MAN = 'fpg_manuais';
  var _versaoMan = null;
  var CAMPOS_MOV = ['tipo', 'mes', 'cod', 'de', 'para', 'de_mes', 'para_mes', 'valor', 'motivo'];
  var CARIMBO = ['id', 'ano', 'criado_em', 'criado_por', 'atualizado_em', 'atualizado_por'];
  var TIPOS = { avulsa: 1, reclassificacao: 1, mudar_mes: 1 };

  async function lerManuais() {
    var r = await cliente().from('app_state').select('data, updated_at').eq('id', DOC_MAN).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    if (!r.data) throw new Error('o documento das movimentações não existe no hub (falta o SQL de implantação)');
    _versaoMan = r.data.updated_at;
    var d = r.data.data || {};
    return { versao: 1, movimentos: Array.isArray(d.movimentos) ? d.movimentos : [] };
  }

  /* A mesma regra do `abrir_painel._carimbar_manuais`: movimentação nova (sem id) ganha id,
   * `ano` (o do painel), `criado_em` e `criado_por`; a que já existia mantém o carimbo e, se
   * mudou, ganha `atualizado_em`/`atualizado_por`. O carimbo vem SEMPRE do que está gravado,
   * nunca do que a tela mandou. */
  function carimbar(movimentos, antes, quem, agora, ano) {
    var porId = {};
    antes.forEach(function (m) { porId[m.id] = m; });
    var prox = antes.reduce(function (mx, m) { return typeof m.id === 'number' && m.id > mx ? m.id : mx; }, 0) + 1;
    return movimentos.map(function (m) {
      var dado = {};
      CAMPOS_MOV.forEach(function (k) {
        if (m[k] !== undefined && m[k] !== null && m[k] !== '') dado[k] = m[k];
      });
      if (typeof dado.motivo === 'string') dado.motivo = dado.motivo.trim();
      var velho = porId[m.id];
      if (!velho) {
        return Object.assign(dado, { id: prox++, ano: ano, criado_em: agora, criado_por: quem });
      }
      var carimbo = {};
      CARIMBO.forEach(function (k) { if (velho[k] !== undefined) carimbo[k] = velho[k]; });
      var mudou = CAMPOS_MOV.some(function (k) { return JSON.stringify(velho[k]) !== JSON.stringify(dado[k]); });
      return Object.assign(dado, carimbo, mudou ? { atualizado_em: agora, atualizado_por: quem } : {});
    });
  }

  function problemas(movimentos, mesesFechados, ano) {
    var p = [];
    movimentos.forEach(function (m) {
      var quem = 'movimentação ' + (m.id || '');
      if (!TIPOS[m.tipo]) { p.push(quem + ': tipo ' + m.tipo); return; }
      if (!String(m.motivo || '').trim()) p.push(quem + ': falta o motivo');
      if (typeof m.valor !== 'number' || Math.abs(m.valor) < 0.005) p.push(quem + ': valor tem de ser diferente de zero');
      var lim = (m.ano || 2026) === ano ? mesesFechados : 12;
      (m.tipo === 'mudar_mes' ? ['de_mes', 'para_mes'] : ['mes']).forEach(function (c) {
        if (!(m[c] >= 1 && m[c] <= lim)) p.push(quem + ': ' + c + ' fora de 1..' + lim + ' (só meses com realizado)');
      });
      if (m.tipo === 'reclassificacao' && m.de === m.para) p.push(quem + ': reclassificação para a mesma natureza');
      if (m.tipo === 'mudar_mes' && m.de_mes === m.para_mes) p.push(quem + ': mudança para o mesmo mês');
    });
    return p;
  }

  async function salvarManuais(movimentos) {
    var sb = cliente();
    var D = window.FPG_DATA || {};
    var ano = D.meta && D.meta.ano;
    var lido = await sb.from('app_state').select('data').eq('id', DOC_MAN).maybeSingle();
    if (lido.error) throw new Error('app_state: ' + lido.error.message);
    var antes = ((lido.data && lido.data.data) || {}).movimentos || [];
    // hora local sem fuso, no formato do abrir_painel.py (isoformat timespec=seconds)
    var d = new Date();
    var agora = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    var novos = carimbar(movimentos, antes, await quemSou(), agora, ano);
    var p = problemas(novos, (D.qual && D.qual.meses_fechados) || 0, ano);
    if (p.length) throw new Error(p.slice(0, 3).join('; '));
    var novo = { versao: 1, movimentos: novos };
    var r = await sb.from('app_state').update({ data: novo, updated_at: new Date().toISOString() })
      .eq('id', DOC_MAN).eq('updated_at', _versaoMan).select('id, updated_at');
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    if (!r.data || !r.data.length) {
      throw new Error('outra pessoa gravou as movimentações enquanto esta tela estava aberta. ' +
                      'Nada foi sobrescrito — volte ao painel, abra as movimentações de novo e refaça.');
    }
    _versaoMan = r.data[0].updated_at;
    return novo;
  }

  async function abrirManuais() {
    var view = document.getElementById('view');
    if (typeof clearCharts === 'function') clearCharts();
    mostrarPainel(false);
    view.innerHTML = '<div class="card"><div class="hint">carregando as movimentações…</div></div>';
    window.scrollTo(0, 0);
    var doc;
    try {
      doc = await lerManuais();
    } catch (e) {
      telaDeErro(view, 'Movimentações indisponíveis', e.message);
      return;
    }
    var D = window.FPG_DATA || {};
    window.FPG_MANUAIS.abrir(view, {
      doc: doc,
      nats: (D.nat || []).map(function (n) { return { cod: n.cod, nome: n.nome, bloco: n.bloco }; }),
      meses: D.meses || [],
      meses_fechados: (D.qual && D.qual.meses_fechados) || 0,
      ano: D.meta && D.meta.ano
      // sem `remonta`: no hub a movimentação vale a partir da próxima publicação do Azure
    }, { salvar: salvarManuais, voltar: voltarAoPainel });
  }

  function voltarAoPainel() {
    mostrarPainel(true);
    if (typeof render === 'function') render();
    window.scrollTo(0, 0);
  }

  function ligarAtualizar() {
    if (!window.HUB_REPROCESSAR) return;
    window.HUB_REPROCESSAR.ligar({
      painel: 'fpg',
      botao: document.getElementById('btn-atualizar'),
      status: document.getElementById('reproc-status'),
      cliente: cliente,
      aguardando: 'pedido enviado — a consulta ao Bimer leva uns 20 minutos. '
                  + 'Pode fechar e voltar depois.',
      // 22 min medidos rodando local (24/11/2026); acima do teto de 30 da função, a tela não
      // desiste antes do Azure
      limite: 35 * 60000,
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
     * de ../data/fpg.js (`window.FPG_DATA = {...}`), que é git-ignorado, se alguém o tiver
     * copiado do painel local. */
    if (location.protocol === 'file:') {
      try { await script('../data/fpg.js'); } catch (e) { /* cai no bucket abaixo */ }
    }
    /* ANTES de baixar o dado, de propósito (lição do Tarituba, 02/10/2026): é este botão
     * que faz a PRIMEIRA publicação. Ligado só depois do dado, ele aparecia na tela de
     * "Painel indisponível" e não fazia nada. */
    ligarAtualizar();
    if (!window.FPG_DATA) {
      try {
        window.FPG_DATA = await baixar(ARQ);
      } catch (e) {
        mostrarErro('O painel ainda não foi publicado no hub, ou você não tem acesso a ele (' +
                    e.message + '). Ele é publicado toda segunda às 10h30 — ou agora, pelo ' +
                    '"Atualizar agora" acima (uns 20 minutos).');
        return;
      }
    }
    await script('app.js');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { cliente: cliente, abrirCadastro: abrirCadastro, abrirManuais: abrirManuais,
           // para o teste do painel conferir o carimbo sem o Supabase
           _carimbar: carimbar, _problemas: problemas };
})();
