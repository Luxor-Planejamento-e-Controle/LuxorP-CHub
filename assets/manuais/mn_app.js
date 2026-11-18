/* Manual de processos: índice de seções à esquerda, seção aberta à direita; quem é editor
 * edita a seção em markdown com prévia ao lado e cola/arrasta print direto no texto.
 *
 * O manual vem da URL: index.html?manual=manual_backoffice. Cada manual é uma aba do hub
 * com permissão própria (hub_can('<manual>')), como os decks em ../apresentacoes.
 * Seção aberta fica no hash da página (#s=<id>), então link para uma seção funciona.
 */
(function () {
  'use strict';

  var MANUAIS = {manual_backoffice: 'Manual de Processos — Backoffice'};
  var PERIODOS = ['Diário', 'Semanal', 'Mensal', 'Trimestral', 'Anual', 'Eventual', 'Referência'];

  var manual = new URLSearchParams(location.search).get('manual');
  var F = window.MN_FONTE, MD = window.MN_MD, esc = MD.esc;
  var doc = null, editor = false, imgs = {}, atual = null, busca = '';
  var edicao = null;          // {base, secao} enquanto o editor está aberto
  var $ = function (s) { return document.querySelector(s); };

  function dataBR(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
  }
  var quem = F.nome;
  function slug(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'secao';
  }
  function status(msg, erro) {
    var el = $('#status');
    el.textContent = msg || '';
    el.className = erro ? 'erro' : '';
  }

  /* ------------------------------------------------------------ índice */
  function casa(s) {
    if (!busca) return true;
    var alvo = (s.titulo + ' ' + MD.texto(s.md)).toLowerCase();
    return busca.split(/\s+/).every(function (t) { return alvo.indexOf(t) >= 0; });
  }

  function titulosDe(md) {
    var out = [];
    String(md || '').split('\n').forEach(function (l) {
      var m = /^#{1,2}\s+(.*)$/.exec(l);
      if (m) out.push(m[1].replace(/[*`]/g, ''));
    });
    return out;
  }

  function indice() {
    var lista = doc.secoes.filter(casa);
    var h = lista.map(function (s) {
      var on = atual && s.id === atual.id;
      var sub = on ? titulosDe(s.md).map(function (t, i) {
        return '<a class="sub" href="#s=' + esc(s.id) + '&t=' + i + '">' + esc(t) + '</a>';
      }).join('') : '';
      return '<a class="item' + (on ? ' on' : '') + '" href="#s=' + esc(s.id) + '">' +
             '<span class="t">' + esc(s.titulo) + '</span>' +
             (s.periodicidade ? '<span class="per">' + esc(s.periodicidade) + '</span>' : '') + '</a>' + sub;
    }).join('');
    if (!lista.length) h = '<div class="nada">' + (busca ? 'Nada encontrado.' : 'Nenhuma seção ainda.') + '</div>';
    $('#indice').innerHTML = h;
  }

  /* ------------------------------------------------------------ leitura */
  async function abrir(id, alvo) {
    if (edicao && !confirm('Descartar o que foi editado nesta seção?')) { history.replaceState(null, '', '#s=' + edicao.secao.id); return; }
    edicao = null;
    atual = doc.secoes.find(function (s) { return s.id === id; }) || doc.secoes[0] || null;
    indice();
    var el = $('#secao');
    if (!atual) {
      el.innerHTML = '<div class="vazio"><h2>Manual vazio</h2><p>' +
        (editor ? 'Use "Nova seção" para começar.' : 'Ainda não há seções publicadas.') + '</p></div>';
      return;
    }
    var faltam = MD.imagens(atual.md).filter(function (n) { return !imgs[n]; });
    if (faltam.length) {
      try { Object.assign(imgs, await F.urlsImgs(manual, faltam)); } catch (e) { /* mostra "indisponível" */ }
    }
    var i = doc.secoes.indexOf(atual);
    var acoes = editor ? '<div class="acoes">' +
      '<button type="button" data-a="editar">Editar</button>' +
      '<button type="button" data-a="subir" title="Mover para cima"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" data-a="descer" title="Mover para baixo"' + (i === doc.secoes.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button type="button" data-a="apagar" class="perigo">Apagar</button></div>' : '';
    el.innerHTML = '<header class="cab"><div><h1>' + esc(atual.titulo) + '</h1><div class="meta">' +
      (atual.periodicidade ? '<span class="chip">' + esc(atual.periodicidade) + '</span>' : '') +
      (atual.atualizado_em ? '<span>Atualizado em ' + dataBR(atual.atualizado_em) +
        (atual.atualizado_por ? ' por ' + esc(quem(atual.atualizado_por)) : '') + '</span>' : '') +
      '</div></div>' + acoes + '</header><article class="md">' + MD.render(atual.md, {imgs: imgs}) + '</article>';
    if (alvo != null) {
      var hs = el.querySelectorAll('.md h2');
      if (hs[alvo]) { hs[alvo].scrollIntoView({block: 'start'}); return; }
    }
    $('#principal').scrollTop = 0;
  }

  function rotear() {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''));
    var t = p.get('t');
    abrir(p.get('s'), t == null ? null : +t);
  }

  /* ------------------------------------------------------------ edição */
  function abrirEditor(base) {
    var s = base ? Object.assign({}, base) : {id: '', titulo: '', periodicidade: 'Mensal', md: ''};
    edicao = {base: base, secao: s};
    var el = $('#secao');
    el.innerHTML = '<div class="ed">' +
      '<div class="ed-campos">' +
        '<label>Título<input id="ed-titulo" maxlength="120"></label>' +
        '<label>Periodicidade<select id="ed-per">' + PERIODOS.map(function (p) {
          return '<option>' + p + '</option>'; }).join('') + '</select></label>' +
        '<div class="ed-bot">' +
          '<label class="btn-arq" title="Ou cole (Ctrl+V) / arraste a imagem no texto">Inserir print' +
          '<input type="file" id="ed-arq" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></label>' +
          '<button type="button" id="ed-cancelar">Cancelar</button>' +
          '<button type="button" id="ed-salvar" class="prim">Salvar</button></div>' +
      '</div>' +
      '<div class="ed-lados"><textarea id="ed-md" spellcheck="true"></textarea>' +
      '<article class="md" id="ed-previa"></article></div>' +
      '<div class="ed-ajuda">## título · - item · 1. passo · **negrito** · `caminho` · ``` bloco ``` · > destaque · | tabela | · [texto](https://…) · link de seção [texto](#s=id)</div>' +
      '</div>';
    $('#ed-titulo').value = s.titulo;
    $('#ed-per').value = PERIODOS.indexOf(s.periodicidade) >= 0 ? s.periodicidade : 'Mensal';
    var ta = $('#ed-md');
    ta.value = s.md;
    var previa = function () { $('#ed-previa').innerHTML = MD.render(ta.value, {imgs: imgs}); };
    var t = null;
    ta.addEventListener('input', function () { clearTimeout(t); t = setTimeout(previa, 200); });
    previa();
    ta.addEventListener('paste', function (e) {
      var fs = [].slice.call((e.clipboardData && e.clipboardData.files) || []);
      if (fs.length) { e.preventDefault(); enviar(fs, ta, previa); }
    });
    ta.addEventListener('drop', function (e) {
      var fs = [].slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      if (fs.length) { e.preventDefault(); enviar(fs, ta, previa); }
    });
    $('#ed-arq').onchange = function () { enviar([].slice.call(this.files), ta, previa); this.value = ''; };
    $('#ed-cancelar').onclick = function () {
      if (ta.value !== s.md && !confirm('Descartar o que foi editado?')) return;
      edicao = null;
      base ? abrir(base.id) : rotear();
    };
    $('#ed-salvar').onclick = salvar;
    ta.focus();
  }

  async function enviar(arquivos, ta, previa) {
    for (var i = 0; i < arquivos.length; i++) {
      var marca = '![enviando ' + (i + 1) + '…]()';
      inserir(ta, '\n' + marca + '\n');
      try {
        status('Enviando imagem…');
        var nome = await F.enviarImg(manual, arquivos[i]);
        Object.assign(imgs, await F.urlsImgs(manual, [nome]));
        ta.value = ta.value.replace(marca, '![](img/' + nome + ')');
        status('');
      } catch (e) {
        ta.value = ta.value.replace(marca, '');
        status(e.message, true);
      }
      previa();
    }
  }

  function inserir(ta, txt) {
    var a = ta.selectionStart, b = ta.selectionEnd;
    ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + txt.length;
  }

  async function salvar() {
    var s = edicao.secao, base = edicao.base;
    var titulo = $('#ed-titulo').value.trim();
    if (!titulo) { status('Dê um título à seção.', true); return; }
    var id = base ? base.id : slug(titulo);
    if (!base && doc.secoes.some(function (x) { return x.id === id; })) id = id + '-' + Date.now().toString(36).slice(-4);
    var nova = {id: id, titulo: titulo, periodicidade: $('#ed-per').value, md: $('#ed-md').value};
    $('#ed-salvar').disabled = true;
    status('Salvando…');
    try {
      doc = await F.salvarSecao(manual, Object.assign({}, s, nova), base);
      edicao = null;
      status('Salvo.');
      if (location.hash === '#s=' + id) abrir(id); else location.hash = 's=' + id;
    } catch (e) {
      status(e.message, true);
      $('#ed-salvar').disabled = false;
    }
  }

  async function acao(a) {
    if (!atual) return;
    if (a === 'editar') return abrirEditor(atual);
    try {
      if (a === 'apagar') {
        if (!confirm('Apagar a seção "' + atual.titulo + '"? Não tem desfazer.')) return;
        doc = await F.apagarSecao(manual, atual.id);
        status('Seção apagada.');
        location.hash = '';
        return abrir(null);
      }
      doc = await F.moverSecao(manual, atual.id, a === 'subir' ? -1 : 1);
      abrir(atual.id);
    } catch (e) { status(e.message, true); }
  }

  /* ------------------------------------------------------------ eventos */
  function ligar() {
    $('#busca').addEventListener('input', function () { busca = this.value.trim().toLowerCase(); indice(); });
    $('#secao').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-a]');
      if (b) return acao(b.dataset.a);
      var c = e.target.closest('.copiar');
      if (c) {
        var txt = c.parentNode.querySelector('code').textContent;
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
          .then(function () { c.textContent = 'Copiado'; setTimeout(function () { c.textContent = 'Copiar'; }, 1200); })
          .catch(function () { c.textContent = 'Selecione e copie'; });
        return;
      }
      var im = e.target.closest('.md img');
      if (im && !e.target.closest('#ed-previa')) {
        $('#zoom img').src = im.src;
        $('#zoom').hidden = false;
      }
    });
    $('#zoom').onclick = function () { this.hidden = true; };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('#zoom').hidden = true; });
    $('#nova').onclick = function () {
      if (edicao && !confirm('Descartar o que foi editado nesta seção?')) return;
      atual = null; indice(); abrirEditor(null);
    };
    window.addEventListener('hashchange', rotear);
    window.addEventListener('beforeunload', function (e) {
      if (edicao && $('#ed-md') && $('#ed-md').value !== edicao.secao.md) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  async function iniciar() {
    if (!MANUAIS[manual]) { $('#secao').innerHTML = '<div class="vazio"><h2>Manual não encontrado</h2></div>'; return; }
    try {
      var r = await F.ler(manual);
      doc = r.doc;
    } catch (e) {
      $('#secao').innerHTML = '<div class="vazio"><h2>Manual indisponível</h2><p></p></div>';
      $('#secao .vazio p').textContent = e.message;
      return;
    }
    editor = await F.podeEditar(manual);
    $('#titulo').textContent = doc.titulo || MANUAIS[manual];
    document.title = (doc.titulo || MANUAIS[manual]) + ' · Luxor P&C';
    $('#nova').hidden = !editor;
    ligar();
    rotear();
  }

  iniciar();
})();
