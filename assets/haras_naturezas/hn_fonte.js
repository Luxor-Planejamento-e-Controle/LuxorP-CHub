/* De onde a tela de naturezas do Haras lê e onde ela grava.
 *
 *   cadastro    tabela `app_state`, id 'haras_naturezas' — o que a tela edita. É também o
 *               que o job do Azure lê (service role) para montar o painel de Gastos.
 *
 *   pendentes   bucket privado `hub-data`, arquivo `haras_naturezas.json`, publicado pelo
 *               job: os códigos do Bimer que apareceram nos relatórios e que o cadastro
 *               não conhece. Forma: { gerado_em, pendentes: [{bimer, nome, qtd, valor,
 *               meses}] }. O nome do arquivo é o id do painel: a policy do bucket decide
 *               quem baixa por `hub_can(split_part(name,'.',1))`.
 *
 * A CONSEQUÊNCIA, que a tela precisa dizer: gravar aqui NÃO atualiza o painel do HubHPG
 * na hora. O painel é publicado pelo job (segunda 08:30, ou publicação manual), e é nele
 * que a edição passa a valer.
 */
window.HN_FONTE = (function () {
  'use strict';

  var DOC = 'haras_naturezas';
  var ARQUIVO = 'haras_naturezas.json';
  var BUCKET = 'hub-data';
  var _sb = null;

  /* `updated_at` da linha quando ESTA tela carregou. É o que impede a gravação de apagar
   * em silêncio o que outra pessoa gravou no intervalo: o UPDATE só casa se a linha ainda
   * está na versão que a tela leu. O cadastro sobe INTEIRO a cada gravação, então sem esta
   * guarda a segunda pessoa a salvar desfaz o trabalho da primeira sem erro nenhum. */
  var _versao = null;

  function cliente() {
    if (_sb) return _sb;
    if (!window.supabase || !window.SUPABASE_URL) {
      throw new Error('supabase-js não carregou (veja config.js e ../vendor/supabase.min.js)');
    }
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  async function lerEstado(sb) {
    var r = await sb.from('app_state').select('data, updated_at').eq('id', DOC).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    return { doc: (r.data && r.data.data) || {}, versao: r.data && r.data.updated_at };
  }

  async function carregar() {
    var sb = cliente();

    /* O bucket pode não ter o arquivo ainda (o job não publicou). Não é erro: a tela abre
     * sem a seção de pendentes e diz por quê. */
    var pendentes = null;
    try {
      var dl = await sb.storage.from(BUCKET).download(ARQUIVO);
      if (dl.data) pendentes = JSON.parse(await dl.data.text());
    } catch (e) {
      console.warn('[haras_naturezas] pendentes ainda não publicados:', e.message);
    }

    var lido = await lerEstado(sb);
    _versao = lido.versao;
    return { doc: HN_DADOS.normalizar(lido.doc), pendentes: pendentes };
  }

  /* Campos que contam como "conteúdo". `atualizado_*` são consequência da mudança. */
  var CAMPOS_NAT = ['ordem', 'cod', 'alt', 'nome', 'resp', 'bimer', 'path'];
  var CAMPOS_IGN = ['nome'];

  function iguais(a, b, campos) {
    return campos.every(function (c) {
      return JSON.stringify(a[c] === undefined ? null : a[c]) ===
             JSON.stringify(b[c] === undefined ? null : b[c]);
    });
  }

  /* Carimba só o que MUDOU: `atualizado_por` existe para responder "quem mexeu nesta
   * natureza e quando", e carimbar tudo a cada gravação o tornaria inútil. */
  function carimbar(novos, antigos, chave, campos, agora, email) {
    var idx = {};
    antigos.forEach(function (x) { idx[chave(x)] = x; });
    return novos.map(function (x) {
      var velho = idx[chave(x)];
      if (velho && iguais(velho, x, campos)) return velho;
      return Object.assign({}, x, { atualizado_em: agora, atualizado_por: email });
    });
  }

  /* Grava o cadastro inteiro. Lê antes porque `app_state` guarda o documento completo:
   * escrever só `naturezas` apagaria qualquer outra chave que o documento venha a ter. */
  async function salvar(cadastro) {
    var sb = cliente();
    var lido = await lerEstado(sb);
    var estado = HN_DADOS.normalizar(lido.doc);
    var email = (window.HUB && window.HUB.email) || null;
    var agora = new Date().toISOString();

    var naturezas = carimbar(cadastro.naturezas, estado.naturezas,
      function (n) { return n.cod; }, CAMPOS_NAT, agora, email);
    var ignoradas = carimbar(cadastro.ignoradas, estado.ignoradas,
      function (g) { return String(g.bimer); }, CAMPOS_IGN, agora, email);

    var novo = Object.assign({}, lido.doc, {
      versao: 1, naturezas: naturezas, ignoradas: ignoradas
    });

    /* `_versao` é a do carregamento da tela, não a da releitura logo acima: é a releitura
     * que enxergaria a gravação do outro e faria a guarda passar sempre. */
    var esperada = _versao || lido.versao;
    var r = await sb.from('app_state')
      .update({ data: novo, updated_at: agora })
      .eq('id', DOC)
      .eq('updated_at', esperada)
      .select('id, updated_at');
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    if (!r.data || !r.data.length) {
      throw new Error('outra pessoa gravou o cadastro enquanto esta tela estava aberta. ' +
                      'Nada foi sobrescrito — recarregue o painel e refaça a alteração.');
    }
    /* A versão vem da resposta: quem decide o valor gravado é o banco. */
    _versao = r.data[0].updated_at || agora;
    return { naturezas: naturezas, ignoradas: ignoradas };
  }

  return { carregar: carregar, salvar: salvar, cliente: cliente };
})();
