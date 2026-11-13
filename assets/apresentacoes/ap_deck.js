/* Casca do deck: trimestre, navegação, apresentação em tela cheia e export.
 *
 * O desenho de cada slide é do ap_layout.js. Aqui só se escolhe O QUE mostrar (qual
 * trimestre, qual slide, qual idioma da carta) e se manda a mesma lista de primitivas
 * para a tela, para a impressão (PDF) ou para o pptxgenjs (PPTX).
 *
 * window.AP_DECK.iniciar(spec, opcoes) é chamado pelo ap_fonte.js quando o JSON chega.
 *   opcoes.textos       textos da carta por trimestre (app_state 'carta'), ver CONTEUDO
 *   opcoes.podeEditar   mostra "Editar textos" (admin; quem grava é a policy do banco)
 *   opcoes.salvar(t)    grava os textos de todos os trimestres e devolve a versão salva
 */
window.AP_DECK = (function () {
  'use strict';
  var LAY = window.AP_LAYOUT;
  var SPEC = null, OPC = {}, periodo = null, slides = [], idx = 0;
  var ctx = {moeda: null, lang: 'pt', tela: true};
  /* CONTEUDO da carta, por trimestre:
     { "2026-Q3": { pt: {destaques, atualizacoes}, en: {destaques, atualizacoes},
                    leituras: [{img, pt, en}] } } */
  var textos = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
    });
  }
  var ehCarta = function () { return SPEC && SPEC.deck === 'carta'; };

  /* textos do trimestre na tela, no idioma da tela, no formato que o layout lê */
  function textosDe(p, lang) {
    var t = textos[p] || {};
    var l = t[lang] || {};
    return {destaques: l.destaques || '', atualizacoes: l.atualizacoes || '',
            leituras: (t.leituras || []).map(function (x) { return {img: x.img, texto: x[lang] || ''}; })};
  }
  function ctxDe(tela) {
    return {moeda: ctx.moeda, lang: ctx.lang, tela: tela, textos: textosDe(periodo, ctx.lang)};
  }

  function caixaSlide(s, html) {
    var t = LAY.tam();
    return '<div class="slide" style="width:' + t.W + 'px;height:' + t.H + 'px;background:#' + LAY.fundo(s) + '">' + html + '</div>';
  }

  function slideHTML(s) {
    var extra = '';
    if (s.t === 'investidores') {
      // a troca de moeda é da tela; o PPTX/PDF sai na moeda escolhida
      extra = Object.keys(s.moedas).map(function (k, i) {
        return '<button type="button" class="moeda" data-moeda="' + k + '" style="left:' + (190 + i * 64) +
               'px;top:120px" aria-label="Mostrar em ' + k + '"></button>';
      }).join('');
    }
    return LAY.html(LAY.prims(s, ctxDe(true)), '') + extra;
  }

  function render() {
    var s = slides[idx];
    if (!s) return;
    var stage = $('stage');
    stage.innerHTML = caixaSlide(s, slideHTML(s)).replace('class="slide"', 'class="slide" id="slide"');
    stage.querySelectorAll('.moeda').forEach(function (b) {
      b.onclick = function () { ctx.moeda = b.dataset.moeda; render(); };
    });
    fit();
    $('pos').textContent = (idx + 1) + ' / ' + slides.length;
    $('prev').disabled = idx === 0;
    $('next').disabled = idx === slides.length - 1;
    if ($('ir').value !== String(idx)) $('ir').value = String(idx);
    try { history.replaceState(null, '', '#' + periodo + '/' + (idx + 1)); } catch (e) { }
  }

  /* escala a página para a área disponível. position:absolute + translate(-50%,-50%)
     centraliza sempre, qualquer que seja o tamanho relativo (achado do deck do HPG). */
  function fit() {
    var el = $('slide');
    if (!el) return;
    var box = $('stage').getBoundingClientRect(), t = LAY.tam();
    var pad = document.body.classList.contains('play') ? 0 : 28;
    var k = Math.min((box.width - pad) / t.W, (box.height - pad) / t.H);
    el.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
  }

  function go(i) { idx = Math.max(0, Math.min(slides.length - 1, i)); render(); }

  var NOME_PAGINA = {carta_capa: 'Capa', carta_proposito: 'Propósito e Valores', carta_retornos: 'Retornos',
                     carta_patrimonio: 'Patrimônio e Alocação'};
  function titulo(s) {
    if (s.t === 'capa') return s.texto;
    if (s.t === 'foto') return (s.cartao && s.cartao.nome) || 'Foto';
    if (s.t === 'carta_texto') return s.slot === 'destaques' ? 'Destaques e Prioridades' : 'Atualizações do Grupo Luxor';
    if (NOME_PAGINA[s.t]) return NOME_PAGINA[s.t];
    return ((s.titulo || s.id || s.t) + ' ' + (s.destaque || '')).trim();
  }

  function trocaPeriodo(p) {
    if (!SPEC.decks[p]) return;
    periodo = p;
    slides = SPEC.decks[p];
    $('periodo').value = p;
    $('ir').innerHTML = slides.map(function (s, i) {
      return '<option value="' + i + '">' + String(i + 1).padStart(2, '0') + ' · ' + esc(titulo(s).slice(0, 60)) + '</option>';
    }).join('');
    var pend = slides.filter(function (s) { return s.t === 'pendente'; }).length;
    var quando = SPEC.gerado_por_periodo && SPEC.gerado_por_periodo[p];
    $('aviso').textContent = (pend ? pend + ' slide(s) sem dado · ' : '') +
      (quando ? 'gerado em ' + new Date(quando).toLocaleString('pt-BR', {dateStyle: 'short', timeStyle: 'short'}) : '');
    go(Math.min(idx, slides.length - 1));
  }

  function play() {
    document.body.classList.add('play');
    var el = document.documentElement;
    (el.requestFullscreen ? el.requestFullscreen() : Promise.resolve()).catch(function () { });
    fit();
  }
  function sairPlay() {
    document.body.classList.remove('play');
    if (document.fullscreenElement) document.exitFullscreen().catch(function () { });
    fit();
  }

  /* PDF: imprime todas as páginas do trimestre num container próprio, uma por folha do
     tamanho exato da página (1280×720 px = 13,333×7,5 in; carta 888×1134 = 9,25×11,81 in).
     Chamado de dentro do iframe, imprime só o iframe (é o que se quer). */
  function exportarPdf() {
    var t = LAY.tam();
    $('pagina-impressa').textContent = '@media print{@page{size:' + (t.W / 96).toFixed(3) + 'in ' +
      (t.H / 96).toFixed(3) + 'in;margin:0}}';
    var caixa = $('impressao');
    caixa.innerHTML = slides.map(function (s) { return caixaSlide(s, LAY.html(LAY.prims(s, ctxDe(false)), '')); }).join('');
    document.body.classList.add('imprimindo');
    var limpa = function () {
      document.body.classList.remove('imprimindo');
      caixa.innerHTML = '';
      window.removeEventListener('afterprint', limpa);
    };
    window.addEventListener('afterprint', limpa);
    var imgs = Array.prototype.slice.call(caixa.querySelectorAll('img'));
    Promise.all(imgs.map(function (im) {
      return im.complete ? null : new Promise(function (r) { im.onload = im.onerror = r; });
    })).then(function () { window.print(); });
  }

  /* imagem -> {png, w, h}: o pptxgen quer base64, e SVG (logo) vira PNG num canvas */
  function carrega(url) {
    return new Promise(function (ok) {
      var im = new Image();
      im.onload = function () { ok(im); };
      im.onerror = function () { ok(null); };
      im.src = url;
    });
  }
  async function paraPptx(url, larguraPng) {
    var im = await carrega(url);
    if (!im) return null;
    var w = im.naturalWidth || 512, h = im.naturalHeight || 512;
    if (/^data:image\/(png|jpe?g)/.test(url)) return {data: url, w: w, h: h};
    var k = (larguraPng || 1200) / w;
    var c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    try { return {data: c.toDataURL('image/png'), w: w, h: h}; } catch (e) { return null; }
  }

  function nomeArquivo() {
    if (ehCarta()) {
      var m = /^(\d{4})-Q([1-4])$/.exec(periodo) || [];
      return 'Carta_Trimestral_' + (ctx.lang === 'en' ? 'English' : 'Portugues') + '_' + m[2] + 'Q' + m[1];
    }
    return SPEC.titulo.replace(/[^\w\- ]+/g, '').trim() + ' ' + periodo;
  }

  async function exportarPptx(btn) {
    if (!window.PptxGenJS) { $('aviso').textContent = 'o gerador de PPTX não carregou'; return; }
    var rot = btn.textContent;
    btn.disabled = true; btn.textContent = 'Gerando…';
    try {
      var t = LAY.tam();
      var p = new window.PptxGenJS();
      p.defineLayout({name: 'HUB', width: +(t.W / 96).toFixed(4), height: +(t.H / 96).toFixed(4)});
      p.layout = 'HUB';
      p.title = SPEC.titulo + ' — ' + (SPEC.labels[periodo] || periodo);
      var listas = slides.map(function (s) { return LAY.prims(s, ctxDe(false)); });
      // toda imagem usada: logo SVG e SVGs viram PNG; as outras guardam o tamanho (encaixe)
      var imgs = {__dim: {}};
      var fontes = {};
      listas.forEach(function (ps) { ps.forEach(function (q) { if (q.k === 'i') fontes[q.src] = 1; }); });
      for (var src in fontes) {
        var r = await paraPptx(src, src === LAY.LOGO ? 128 : 1600);
        if (r) { imgs[src] = r.data; imgs.__dim[src] = [r.w, r.h]; }
      }
      slides.forEach(function (s, i) {
        var sl = p.addSlide();
        sl.background = {color: LAY.fundo(s)};
        LAY.pptx(p, sl, listas[i], imgs);
      });
      await p.writeFile({fileName: nomeArquivo() + '.pptx'});
    } catch (e) {
      console.error(e);
      $('aviso').textContent = 'não foi possível gerar o PPTX: ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = rot;
    }
  }

  /* ---------------- editor dos textos da carta ----------------
     Os textos do CEO chegam por fora e o Arthur cola aqui (decisão dele, 13/11/2026); a
     tradução também é feita fora e colada no EN. Uma linha = um parágrafo; **negrito** e
     *itálico* valem. A prévia atualiza enquanto digita; gravar manda tudo de uma vez. */
  function abreEditor() {
    var ed = $('editor');
    var t = JSON.parse(JSON.stringify(textos[periodo] || {}));
    t.pt = t.pt || {}; t.en = t.en || {}; t.leituras = t.leituras || [];
    var original = JSON.stringify(t);

    function campo(lang, k, rotulo, linhas) {
      return '<label class="ed-campo"><span>' + rotulo + ' — ' + lang.toUpperCase() + '</span>' +
        '<textarea rows="' + linhas + '" data-l="' + lang + '" data-k="' + k + '">' + esc(t[lang][k] || '') + '</textarea></label>';
    }
    function leituraHTML(x, i) {
      return '<div class="ed-leitura" data-i="' + i + '">' +
        '<div class="ed-capa">' + (x.img ? '<img src="' + esc(x.img) + '" alt="">' : '<span>sem imagem</span>') +
        '<label class="ed-arq">imagem<input type="file" accept="image/*" data-img="' + i + '"></label></div>' +
        '<label class="ed-campo"><span>Texto — PT</span><textarea rows="5" data-li="' + i + '" data-l="pt">' + esc(x.pt || '') + '</textarea></label>' +
        '<label class="ed-campo"><span>Texto — EN</span><textarea rows="5" data-li="' + i + '" data-l="en">' + esc(x.en || '') + '</textarea></label>' +
        '<button type="button" class="ed-tira" data-tira="' + i + '">remover</button></div>';
    }
    function monta() {
      ed.innerHTML = '<div class="ed-caixa" role="dialog" aria-label="Textos da carta">' +
        '<div class="ed-topo"><b>Textos da carta — ' + esc(SPEC.labels[periodo] || periodo) + '</b>' +
        '<span class="ed-dica">uma linha = um parágrafo · **negrito** · *itálico*</span>' +
        '<span class="esp"></span><span id="ed-msg"></span>' +
        '<button type="button" id="ed-fecha">Fechar</button><button type="button" id="ed-grava" class="pri">Gravar</button></div>' +
        '<div class="ed-corpo">' +
        '<div class="ed-grade">' + campo('pt', 'destaques', 'Destaques e Prioridades', 14) + campo('en', 'destaques', 'Highlights and Priorities', 14) + '</div>' +
        '<div class="ed-grade">' + campo('pt', 'atualizacoes', 'Atualizações do Grupo Luxor', 8) + campo('en', 'atualizacoes', 'Luxor Group Updates', 8) + '</div>' +
        '<h4>O que temos lido, ouvido ou feito</h4><div id="ed-leituras">' + t.leituras.map(leituraHTML).join('') + '</div>' +
        '<button type="button" id="ed-mais">+ leitura</button></div></div>';
      ligar();
    }
    var prev = null;
    function aplica() {
      textos[periodo] = t;
      clearTimeout(prev);
      prev = setTimeout(render, 150);
    }
    function ligar() {
      ed.querySelectorAll('textarea').forEach(function (a) {
        a.oninput = function () {
          if (a.dataset.li != null) t.leituras[+a.dataset.li][a.dataset.l] = a.value;
          else t[a.dataset.l][a.dataset.k] = a.value;
          // a prévia mostra o idioma do campo que está sendo editado
          if (ctx.lang !== a.dataset.l) { ctx.lang = a.dataset.l; $('lang').value = ctx.lang; }
          aplica();
        };
      });
      ed.querySelectorAll('input[type=file]').forEach(function (f) {
        f.onchange = async function () {
          var arq = f.files && f.files[0];
          if (!arq) return;
          var url = await new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.readAsDataURL(arq); });
          var im = await carrega(url);
          if (!im) return;
          // capa de livro: 600 px de altura em JPEG basta para a página e não pesa no banco
          var k = Math.min(1, 600 / im.naturalHeight);
          var c = document.createElement('canvas');
          c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
          var g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(im, 0, 0, c.width, c.height);
          t.leituras[+f.dataset.img].img = c.toDataURL('image/jpeg', 0.85);
          aplica(); monta();
        };
      });
      ed.querySelectorAll('[data-tira]').forEach(function (b) {
        b.onclick = function () { t.leituras.splice(+b.dataset.tira, 1); aplica(); monta(); };
      });
      $('ed-mais').onclick = function () { t.leituras.push({img: null, pt: '', en: ''}); aplica(); monta(); };
      $('ed-fecha').onclick = function () {
        if (JSON.stringify(t) !== original && !confirm('Fechar sem gravar? O que foi colado aqui se perde.')) return;
        if (JSON.stringify(t) !== original) { textos[periodo] = JSON.parse(original); render(); }
        ed.hidden = true;
      };
      $('ed-grava').onclick = async function () {
        var b = $('ed-grava'), msg = $('ed-msg');
        b.disabled = true; msg.textContent = 'gravando…'; msg.className = '';
        try {
          textos[periodo] = t;
          textos = await OPC.salvar(textos);
          original = JSON.stringify(textos[periodo] || {});
          msg.textContent = 'gravado ' + new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
        } catch (e) {
          msg.textContent = e.message; msg.className = 'erro';
        } finally { b.disabled = false; }
      };
    }
    monta();
    ed.hidden = false;
  }

  function teclado(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!$('editor').hidden) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { go(idx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(idx - 1); e.preventDefault(); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length - 1);
    else if (e.key === 'Escape' && document.body.classList.contains('play')) sairPlay();
    else if (e.key.toLowerCase() === 'p') play();
  }

  /* as imagens vêm uma vez em spec.imagens; os slides guardam só a chave */
  function resolveImagens(spec) {
    var im = spec.imagens || {};
    var r = function (v) { return v && !/^data:/.test(v) ? (im[v] || null) : v; };
    Object.keys(spec.decks).forEach(function (p) {
      spec.decks[p].forEach(function (s) {
        if (s.t === 'foto') s.img = r(s.img);
        if (s.t === 'carta_capa') s.logo = r(s.logo);
        if (s.t === 'carta_proposito' && s.img) Object.keys(s.img).forEach(function (k) { s.img[k] = r(s.img[k]); });
      });
    });
  }

  function iniciar(spec, opcoes) {
    SPEC = spec;
    OPC = opcoes || {};
    textos = OPC.textos || {};
    if (!spec.periodos || !spec.periodos.length) throw new Error('o deck publicado não tem nenhum trimestre');
    LAY.pagina(spec.pagina);
    resolveImagens(spec);
    $('titulo-deck').textContent = spec.titulo;
    $('periodo').innerHTML = spec.periodos.map(function (p) {
      return '<option value="' + p + '">' + esc(spec.labels[p] || p) + '</option>';
    }).join('');
    $('periodo').onchange = function (e) { trocaPeriodo(e.target.value); };
    $('ir').onchange = function (e) { go(+e.target.value); };
    $('prev').onclick = function () { go(idx - 1); };
    $('next').onclick = function () { go(idx + 1); };
    $('play').onclick = play;
    $('pdf').onclick = exportarPdf;
    $('pptx').onclick = function () { exportarPptx($('pptx')); };
    if (ehCarta()) {
      $('lang').hidden = false;
      $('lang').onchange = function (e) { ctx.lang = e.target.value; render(); };
      if (OPC.podeEditar) { $('btn-editar').hidden = false; $('btn-editar').onclick = abreEditor; }
    }
    $('stage').onclick = function (e) {
      if (!document.body.classList.contains('play') || e.target.closest('.moeda')) return;
      go(idx + (e.clientX > window.innerWidth / 3 ? 1 : -1));
    };
    window.addEventListener('resize', fit);
    document.addEventListener('keydown', teclado);
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement) sairPlay(); });
    // #2026-Q3/5 abre direto no slide
    var m = /^#(\d{4}-Q[1-4])(?:\/(\d+))?$/.exec(location.hash || '');
    var p0 = m && spec.decks[m[1]] ? m[1] : spec.padrao;
    idx = m && m[2] ? (+m[2] - 1) : 0;
    trocaPeriodo(p0);
  }

  return {iniciar: iniciar};
})();
