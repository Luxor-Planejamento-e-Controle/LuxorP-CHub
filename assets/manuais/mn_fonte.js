/* De onde o manual lê e onde grava.
 *
 *   texto  : app_state, id = <manual> (ex. 'manual_backoffice')
 *            {versao: 1, titulo, secoes: [{id, titulo, periodicidade, md, atualizado_em, atualizado_por}]}
 *   prints : bucket privado `manuais`, em <manual>/<arquivo>; o markdown cita `img/<arquivo>`
 *
 * Quem lê: hub_can(<manual>). Quem grava texto e print: hub_manual_pode_editar(<manual>) =
 * admin ou linha em manual_editores (ver sql/hub_schema.sql, seção 11). A tela só esconde
 * os botões; a barreira é a RLS.
 *
 * Gravação é POR SEÇÃO: relê o documento, troca só a seção editada e grava com a guarda
 * `updated_at = <o que acabou de ler>`. Se outra pessoa gravou OUTRA seção no meio, relê e
 * tenta de novo; se gravou A MESMA seção depois que a edição começou, recusa — senão o
 * trabalho dela sumiria calado.
 */
(function () {
  'use strict';

  var BUCKET = 'manuais';
  var _sb = null;

  function cliente() {
    if (_sb) return _sb;
    if (!window.supabase || !window.SUPABASE_URL) throw new Error('supabase-js não carregou');
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  function normalizar(d) {
    d = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    var secoes = Array.isArray(d.secoes) ? d.secoes : [];
    return {
      versao: 1,
      titulo: d.titulo || '',
      secoes: secoes.filter(function (s) { return s && s.id; }).map(function (s) {
        return {id: String(s.id), titulo: s.titulo || s.id, periodicidade: s.periodicidade || '',
                md: s.md || '', atualizado_em: s.atualizado_em || null, atualizado_por: s.atualizado_por || null};
      })
    };
  }

  async function ler(manual) {
    var r = await cliente().from('app_state').select('data, updated_at').eq('id', manual).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    if (!r.data) throw new Error('o manual não existe no hub (falta o SQL de implantação)');
    return {doc: normalizar(r.data.data), versao: r.data.updated_at};
  }

  async function podeEditar(manual) {
    try {
      var r = await cliente().rpc('hub_manual_pode_editar', {m: manual});
      return !r.error && r.data === true;
    } catch (e) { return false; }
  }

  async function quemSou() {
    try {
      var s = await cliente().auth.getSession();
      return (s.data && s.data.session && s.data.session.user && s.data.session.user.email) || null;
    } catch (e) { return null; }
  }

  /* lê, aplica `mudar(doc)` (que pode lançar conflito) e grava com a guarda; até 3 voltas
   * quando a corrida foi com gravação de outra seção */
  async function mutar(manual, mudar) {
    var sb = cliente();
    for (var volta = 0; volta < 3; volta++) {
      var atual = await ler(manual);
      var novo = mudar(JSON.parse(JSON.stringify(atual.doc)));
      var agora = new Date().toISOString();
      var r = await sb.from('app_state').update({data: novo, updated_at: agora})
        .eq('id', manual).eq('updated_at', atual.versao).select('id, updated_at');
      if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
      if (r.data && r.data.length) return normalizar(novo);
    }
    throw new Error('o manual está sendo gravado por outra pessoa agora. Tente salvar de novo.');
  }

  function conflito(s, base) {
    // base = a seção como estava quando a edição abriu (null = seção nova)
    if (!base) return false;
    return !s || (s.atualizado_em || null) !== (base.atualizado_em || null);
  }

  async function salvarSecao(manual, secao, base) {
    var email = await quemSou();
    var agora = new Date().toISOString();
    return mutar(manual, function (doc) {
      var i = doc.secoes.findIndex(function (s) { return s.id === (base ? base.id : secao.id); });
      if (conflito(i >= 0 ? doc.secoes[i] : null, base)) {
        var s = i >= 0 ? doc.secoes[i] : null;
        throw new Error(s ? ('"' + s.titulo + '" foi alterada por ' + (s.atualizado_por || 'outra pessoa') +
                             ' enquanto você editava. Nada foi sobrescrito: copie seu texto, recarregue e refaça.')
                          : 'a seção foi apagada enquanto você editava. Nada foi gravado.');
      }
      if (!base && i >= 0) throw new Error('já existe uma seção com o identificador "' + secao.id + '".');
      var nova = Object.assign({}, secao, {atualizado_em: agora, atualizado_por: email});
      if (i >= 0) doc.secoes[i] = nova; else doc.secoes.push(nova);
      return doc;
    });
  }

  async function apagarSecao(manual, id) {
    return mutar(manual, function (doc) {
      doc.secoes = doc.secoes.filter(function (s) { return s.id !== id; });
      return doc;
    });
  }

  async function moverSecao(manual, id, passo) {
    return mutar(manual, function (doc) {
      var i = doc.secoes.findIndex(function (s) { return s.id === id; }), j = i + passo;
      if (i < 0 || j < 0 || j >= doc.secoes.length) return doc;
      var t = doc.secoes[i]; doc.secoes[i] = doc.secoes[j]; doc.secoes[j] = t;
      return doc;
    });
  }

  /* URLs assinadas dos prints citados (1 h; a página relê ao trocar de seção) */
  async function urlsImgs(manual, nomes) {
    if (!nomes.length) return {};
    var r = await cliente().storage.from(BUCKET)
      .createSignedUrls(nomes.map(function (n) { return manual + '/' + n; }), 3600);
    var mapa = {};
    (r.data || []).forEach(function (x) {
      if (x && x.signedUrl && x.path) mapa[x.path.split('/').pop()] = x.signedUrl;
    });
    return mapa;
  }

  var EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'};

  async function enviarImg(manual, arquivo) {
    var ext = EXT[arquivo.type];
    if (!ext) throw new Error('só imagem PNG, JPG, GIF ou WEBP');
    if (arquivo.size > 8 * 1024 * 1024) throw new Error('imagem maior que 8 MB');
    var nome = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '_' +
               Math.random().toString(36).slice(2, 8) + '.' + ext;
    var r = await cliente().storage.from(BUCKET).upload(manual + '/' + nome, arquivo,
      {contentType: arquivo.type, upsert: false});
    if (r.error) throw new Error('não foi possível enviar a imagem: ' + r.error.message);
    return nome;
  }

  window.MN_FONTE = {ler: ler, podeEditar: podeEditar, salvarSecao: salvarSecao, apagarSecao: apagarSecao,
                     moverSecao: moverSecao, urlsImgs: urlsImgs, enviarImg: enviarImg, normalizar: normalizar};
})();
