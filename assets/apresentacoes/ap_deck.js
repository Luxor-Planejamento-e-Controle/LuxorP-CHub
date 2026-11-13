/* Casca do deck: trimestre, navegação, apresentação em tela cheia e export.
 *
 * O desenho de cada slide é do ap_layout.js. Aqui só se escolhe O QUE mostrar (qual
 * trimestre, qual slide) e se manda a mesma lista de primitivas para a tela, para a
 * impressão (PDF) ou para o pptxgenjs (PPTX).
 *
 * window.AP_DECK.iniciar(spec) é chamado pelo ap_fonte.js quando o JSON chega.
 */
window.AP_DECK = (function () {
  'use strict';
  var LAY = window.AP_LAYOUT;
  var SPEC = null, periodo = null, slides = [], idx = 0;
  var ctx = {moeda: null};           // estado de tela (moeda do NAV Break Down)

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
    });
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
    return LAY.html(LAY.prims(s, ctx), '') + extra;
  }

  function render() {
    var s = slides[idx];
    if (!s) return;
    var stage = $('stage');
    stage.innerHTML = '<div class="slide" id="slide" style="background:#' + LAY.fundo(s) + '">' + slideHTML(s) + '</div>';
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

  /* escala o slide de 1280×720 para a área disponível. position:absolute +
     translate(-50%,-50%) centraliza sempre, qualquer que seja o tamanho relativo
     (o mesmo achado do deck do HPG em 31/08/2026). */
  function fit() {
    var el = $('slide');
    if (!el) return;
    var box = $('stage').getBoundingClientRect();
    var pad = document.body.classList.contains('play') ? 0 : 28;
    var k = Math.min((box.width - pad) / LAY.W, (box.height - pad) / LAY.H);
    el.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
  }

  function go(i) { idx = Math.max(0, Math.min(slides.length - 1, i)); render(); }

  function titulo(s) {
    if (s.t === 'capa') return s.texto;
    if (s.t === 'foto') return (s.cartao && s.cartao.nome) || 'Foto';
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

  /* PDF: imprime todos os slides do trimestre num container próprio. 1280×720 px a
     96 dpi = 13,333×7,5 in, exatamente o @page — uma página por slide, sem escala.
     Chamado de dentro do iframe, imprime só o iframe (é o que se quer). */
  function exportarPdf() {
    var caixa = $('impressao');
    caixa.innerHTML = slides.map(function (s) {
      return '<div class="slide" style="background:#' + LAY.fundo(s) + '">' + LAY.html(LAY.prims(s, ctx), '') + '</div>';
    }).join('');
    document.body.classList.add('imprimindo');
    var limpa = function () {
      document.body.classList.remove('imprimindo');
      caixa.innerHTML = '';
      window.removeEventListener('afterprint', limpa);
    };
    window.addEventListener('afterprint', limpa);
    // espera as imagens (foto, logo) antes de abrir a impressão
    var imgs = Array.prototype.slice.call(caixa.querySelectorAll('img'));
    Promise.all(imgs.map(function (im) {
      return im.complete ? null : new Promise(function (r) { im.onload = im.onerror = r; });
    })).then(function () { window.print(); });
  }

  /* o pptxgen quer imagem em base64; o logo é SVG e vira PNG num canvas antes */
  function pngDe(url, w, h) {
    return new Promise(function (ok) {
      var im = new Image();
      im.onload = function () {
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        try { ok(c.toDataURL('image/png')); } catch (e) { ok(null); }
      };
      im.onerror = function () { ok(null); };
      im.src = url;
    });
  }

  async function exportarPptx(btn) {
    if (!window.PptxGenJS) { $('aviso').textContent = 'o gerador de PPTX não carregou'; return; }
    var rot = btn.textContent;
    btn.disabled = true; btn.textContent = 'Gerando…';
    try {
      var p = new window.PptxGenJS();
      p.layout = 'LAYOUT_WIDE';                    // 13,333×7,5 in = 1280×720 px a 96 dpi
      p.title = SPEC.titulo + ' — ' + (SPEC.labels[periodo] || periodo);
      var imgs = {};
      imgs[LAY.LOGO] = await pngDe(LAY.LOGO, 128, 120);
      slides.forEach(function (s) {
        var sl = p.addSlide();
        sl.background = {color: LAY.fundo(s)};
        LAY.pptx(p, sl, LAY.prims(s, ctx), imgs);
      });
      await p.writeFile({fileName: SPEC.titulo.replace(/[^\w\- ]+/g, '').trim() + ' ' + periodo + '.pptx'});
    } catch (e) {
      console.error(e);
      $('aviso').textContent = 'não foi possível gerar o PPTX: ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = rot;
    }
  }

  function teclado(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { go(idx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(idx - 1); e.preventDefault(); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length - 1);
    else if (e.key === 'Escape' && document.body.classList.contains('play')) sairPlay();
    else if (e.key.toLowerCase() === 'p') play();
  }

  function iniciar(spec) {
    SPEC = spec;
    if (!spec.periodos || !spec.periodos.length) throw new Error('o deck publicado não tem nenhum trimestre');
    // a foto vem uma vez em spec.imagens; o slide guarda só a chave
    Object.keys(spec.decks).forEach(function (p) {
      spec.decks[p].forEach(function (s) {
        if (s.t === 'foto' && s.img && !/^data:/.test(s.img)) s.img = (spec.imagens || {})[s.img] || null;
      });
    });
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
