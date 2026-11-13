/* Desenho dos slides do Comitê FO e do Board — a geometria dos relatórios do Power BI.

   Os dois relatórios (Comitê_FO.pbip e Board_FO.pbip) tinham página de 1280×720 px,
   fundo #103E44, Segoe UI Semibold e títulos de 36pt com sublinhado laranja. Cada
   tipo de slide aqui vira uma lista de primitivas (retângulo, texto, linha, imagem)
   nessas coordenadas, e a MESMA lista é desenhada no HTML e no PPTX — tela, PDF e
   PowerPoint não têm como divergir entre si.

   Unidades: px do relatório (96 por polegada → slide de 13,333×7,5 in); fonte em pt
   (1 pt = 4/3 px), como no PBI e no PowerPoint.

   O JSON vem de tools/build_apresentacoes.py: números crus + o que o PBI já entregava
   como texto pronto (os cartões). A formatação dos números é daqui. */
'use strict';

(function () {
  const PX_IN = 96;
  const PT = 4 / 3;
  // tamanho da página: 1280×720 nos decks do PBI; a carta é retrato (pagina() troca)
  let W = 1280, H = 720;
  const pagina = p => { W = (p && p.w) || 1280; H = (p && p.h) || 720; };
  const FONTE = 'Segoe UI Semibold';
  const FONTE_TAB = 'Calibri';                    // a planilha do fluxo de caixa (Budget FO)
  const FONTE_CARTA = 'Aptos';                    // corpo e títulos da carta (tema do PPTX dela)
  const FONTE_CARTA_T = 'Roboto Medium';          // capa e títulos verticais da carta
  const COR = {
    fundo: '103E44', branco: 'FFFFFF', laranja: 'FFA400', vermelho: 'FF0000', teal: '1D6E79',
    tealEsc: '215968', cinzaKR: 'D9D9D9', ini: 'F2A900', neg: 'FF2D16', fim: '3E7D8C',
    verdeFav: '92D050', chip: '1F5F63', eixo: '7FA0A3',
  };
  const LOGO = 'logo-x.svg';

  /* ---------------- medida de texto ----------------
     O navegador mede com a fonte de verdade (canvas). Só serve para decidir corte e
     corpo — a posição de tudo é fixa. Sem canvas (teste), estimativa por caractere. */
  let _ctx = null;
  function largura(txt, pt, fonte) {
    const px = pt * PT;
    try {
      if (!_ctx) _ctx = document.createElement('canvas').getContext('2d');
      _ctx.font = `${fonte && fonte !== FONTE ? 400 : 600} ${px}px "${fonte || FONTE}", "Segoe UI", Arial, sans-serif`;
      return _ctx.measureText(String(txt)).width;
    } catch (e) {
      return String(txt).length * px * 0.55;
    }
  }
  function encaixa(txt, pt, w, minimo, fonte) {
    let p = pt;
    const piso = minimo || pt;
    while (p > piso && largura(txt, p, fonte) > w) p = Math.max(piso, p - 0.5);
    return p;
  }

  /* ---------------- primitivas ---------------- */
  const R = (x, y, w, h, o) => Object.assign({k: 'r', x, y, w, h}, o || {});
  const T = (x, y, w, h, t, o) => Object.assign({k: 't', x, y, w, h, t: String(t == null ? '' : t)}, o || {});
  const L = (x1, y1, x2, y2, o) => Object.assign({k: 'l', x1, y1, x2, y2}, o || {});
  const I = (x, y, w, h, src, o) => Object.assign({k: 'i', x, y, w, h, src}, o || {});

  /* ---------------- números (pt-BR, como o PBI em português) ----------------
     Negativo que arredonda a zero sai "-0,0": o Arthur quer ver o sinal (11/11/2026). */
  function nf(v, d) {
    if (v == null || !isFinite(v)) return '';
    const s = Math.abs(v).toLocaleString('pt-BR', {minimumFractionDigits: d, maximumFractionDigits: d});
    return (v < 0 ? '-' : '') + s;
  }
  const pct = (v, d) => v == null ? '' : nf(v * 100, d) + '%';
  const FMT = {
    pct1: v => pct(v, 1),
    num1: v => nf(v, 1),
    num2: v => nf(v, 2),
    mi: v => nf(v, 0) + 'M',
  };
  const fmt = (f, v) => (FMT[f] || FMT.num1)(v);

  /* ---------------- moldura ---------------- */
  function titulo(P, s, o) {
    o = o || {};
    const pt = s.titulo_pt || o.pt || 36;
    const runs = [{t: (s.titulo || '') + (s.destaque ? ' ' : ''), c: COR.branco}];
    if (s.destaque) runs.push({t: s.destaque, c: COR.laranja});
    P.push(T(o.x || 53, o.y || 22, 1150, pt * PT * 1.45, '', {pt, runs, va: 't'}));
    const y = (o.y || 22) + pt * PT * 1.42 + 6;
    P.push(L(64, y, 176, y, {c: COR.laranja, esp: 2}));
    return y;
  }
  function logo(P) {
    P.push(I(1222, 668, 32, 30, LOGO, {logo: 1}));
  }
  function nota(P, txt, pt) {
    if (!txt) return;
    const linhas = Array.isArray(txt) ? txt : [txt];
    const p = pt || 12;
    linhas.forEach((l, i) => P.push(T(16, 690 - (linhas.length - 1 - i) * p * PT * 1.3, 1150, p * PT * 1.3, l,
                                      {pt: p, va: 'm'})));
  }
  function cabecalhos(P, cols, xs, y, pt) {
    cols.forEach((c, i) => P.push(T(xs[i][0], y, xs[i][1], 30, c, {pt: pt || 16, al: 'c', va: 'm'})));
  }

  /* ---------------- barras agrupadas ----------------
     Uma "painel" = um gráfico de barras do PBI. A escala é a do PBI quando ele fixava
     o eixo (±20%, ±150…), alargada só se algum valor não couber; senão, automática. */
  function escala(paineis, eixo) {
    let lo = 0, hi = 0;
    paineis.forEach(p => p.barras.forEach(b => { lo = Math.min(lo, b.v); hi = Math.max(hi, b.v); }));
    if (eixo) return [Math.min(eixo[0], lo * 1.1), Math.max(eixo[1], hi * 1.1)];
    const folga = (hi - lo) * 0.18 || 1;
    return [lo < 0 ? lo - folga : 0, hi > 0 ? hi + folga : 0];
  }
  function barras(P, painel, x, y, w, h, o) {
    o = o || {};
    const [lo, hi] = o.escala || escala([painel], painel.eixo);
    const n = painel.barras.length;
    const slot = w / n;
    const bw = Math.min(slot * (o.larg || 0.52), o.max || 90);
    const ptv = o.ptValor || 12;
    // folga em px para o rótulo do valor não invadir o eixo X nem o título da coluna
    const pad = ptv * PT * 1.3 + 4;
    const yv = v => y + pad + (h - 2 * pad) * (hi - v) / (hi - lo || 1);
    const y0 = yv(0);
    painel.barras.forEach((b, i) => {
      const cx = x + slot * (i + 0.5);
      const ya = yv(Math.max(b.v, 0)), yb = yv(Math.min(b.v, 0));
      if (yb - ya >= 0.5) P.push(R(cx - bw / 2, ya, bw, yb - ya, {fill: b.cor || COR.laranja}));
      const txt = fmt(painel.fmt, b.v);
      const hl = ptv * PT * 1.3;
      P.push(T(cx - slot / 2, b.v >= 0 ? ya - hl - 2 : yb + 2, slot, hl, txt, {pt: ptv, al: 'c', va: 'm'}));
    });
    P.push(L(x, y0, x + w, y0, {c: COR.branco, esp: 1.5}));
    if (o.semCat) return;
    // rótulos da categoria embaixo do gráfico, como o eixo X do PBI
    const ptc = o.ptCat || 11;
    painel.barras.forEach((b, i) => {
      const cx = x + slot * (i + 0.5);
      // quebra por palavra: o corpo só encolhe se a MAIOR palavra não couber
      const maior = String(b.r).split(/\s+/).reduce((a, w) => (largura(w, ptc) > largura(a, ptc) ? w : a), '');
      const p = encaixa(maior, ptc, slot - 4, 7);
      P.push(T(cx - slot / 2, y + h + 4, slot, ptc * PT * 2.6, b.r, {pt: p, al: 'c', va: 't', wrap: 1}));
    });
  }

  const S = {};

  S.barras = s => {
    const P = [];
    titulo(P, s);
    const nl = s.linhas.length;
    const compacto = nl > 1;
    const x0 = 72, x1 = 1208, gap = 70;
    const wp = (x1 - x0 - gap) / 2;
    const xs = [[x0, wp], [x0 + wp + gap, wp]];
    const yTopo = compacto ? 118 : 190;
    const yFim = s.nota ? 640 : 662;
    cabecalhos(P, s.colunas || [], xs, yTopo - 34, compacto ? 14 : 16);
    const hLinha = (yFim - yTopo) / nl;
    // a mesma escala nas colunas de uma linha (Q e YTD lado a lado comparam)
    s.linhas.forEach((linha, li) => {
      const temEixo = linha.some(p => p.eixo);
      const esc = temEixo ? null : escala(linha);
      linha.forEach((p, ci) => {
        const ycat = compacto ? 26 : 54;
        const top = yTopo + li * hLinha + (compacto ? 6 : 20);
        barras(P, p, xs[ci][0], top, xs[ci][1], hLinha - ycat - (compacto ? 8 : 24), {
          escala: temEixo ? escala([p], p.eixo) : esc,
          ptValor: compacto ? 9.5 : 12, ptCat: compacto ? 9 : (s.rotulo_pequeno ? 10 : 11),
          larg: s.rotulo_pequeno ? 0.5 : 0.4, max: compacto ? 46 : 90,
        });
      });
    });
    nota(P, s.nota);
    logo(P);
    return P;
  };

  /* ---------------- cartões (Luxor Portfolio, Leverage) ---------------- */
  function cartao(P, c, x, y, w, h, o) {
    o = o || {};
    P.push(R(x, y, w, h, {fill: c.cor, raio: 10}));
    const linhas = c.linhas || [];
    const passo = o.passo || 30, alto = o.alto || 40;
    const yNome = y + h - 22 - linhas.length * passo - alto;
    P.push(T(x + 14, yNome, w - 24, alto, c.nome, {pt: o.ptNome || 24, va: 'm'}));
    linhas.forEach((l, i) => P.push(T(x + 14, yNome + alto + i * passo, w - 24, passo, l,
                                      {pt: encaixa(l, o.ptLinha || 20, w - 28, 9), va: 'm'})));
  }
  S.cartoes = s => {
    const P = [];
    titulo(P, s);
    (s.resumo || []).forEach((l, i) => P.push(T(53, 128 + i * 36, 1000, 34, l, {pt: 20, va: 'm'})));
    s.cartoes.forEach((c, i) => cartao(P, c, 48 + i * 400, 304, 384, 288));
    logo(P);
    return P;
  };

  S.foto = s => {
    const P = [];
    if (s.img) P.push(I(0, 0, W, H, s.img, {cobre: 1}));
    // o véu do PBI: uma imagem da cor do fundo com ~67% de opacidade por cima da foto
    P.push(R(0, 0, W, H, {fill: COR.fundo, alfa: s.img ? 0.67 : 1}));
    cartao(P, s.cartao, 32, 400, 384, 288);
    logo(P);
    return P;
  };

  /* ---------------- cascata (waterfall do Deneb) ----------------
     1ª barra = início, do zero; as do meio flutuam a partir do acumulado; a última é o
     valor REAL do fim (não a soma), como no PBI. */
  function cascata(P, painel, x, y, w, h, o) {
    o = o || {};
    const bs = painel.barras;
    let acc = 0, lo = 0, hi = 0;
    const seg = bs.map(b => {
      let a, z;
      if (b.k === 'ini' || b.k === 'fim') { a = 0; z = b.v; if (b.k === 'ini') acc = b.v; }
      else if (o.soltas) { a = 0; z = b.v; }
      else { a = acc; z = acc + b.v; acc = z; }
      lo = Math.min(lo, a, z); hi = Math.max(hi, a, z);
      return [a, z];
    });
    hi *= 1.12;
    const slot = w / bs.length;
    const bw = Math.min(slot * 0.62, 90);
    const yv = v => y + h * (hi - v) / (hi - lo || 1);
    const ptv = o.ptValor || 12, ptc = o.ptCat || 10;
    bs.forEach((b, i) => {
      const cx = x + slot * (i + 0.5);
      const [a, z] = seg[i];
      const top = yv(Math.max(a, z)), bot = yv(Math.min(a, z));
      const cor = b.k === 'ini' ? (o.corIni || COR.ini) : b.k === 'fim' ? (o.corFim || COR.fim)
        : (b.v >= 0 ? (o.corPos || COR.ini) : COR.neg);
      P.push(R(cx - bw / 2, top, bw, Math.max(bot - top, 1), {fill: cor}));
      const hl = ptv * PT * 1.3;
      const txt = o.fmt ? o.fmt(b.v) : fmt(painel.fmt, b.v);
      P.push(T(cx - slot / 2, b.v < 0 && b.k === 'd' ? bot + 2 : top - hl - 2, slot, hl, txt, {pt: ptv, al: 'c', va: 'm'}));
      P.push(T(cx - slot / 2, y + h + 8, slot, ptc * PT * 2.6, b.r,
               {pt: encaixa(b.r, ptc, slot - 4, 7), al: 'c', va: 't', wrap: 1}));
    });
    if (lo < 0) P.push(L(x, yv(0), x + w, yv(0), {c: COR.eixo, esp: 1}));
  }
  S.cascata = s => {
    const P = [];
    titulo(P, s);
    const n = s.paineis.length;
    if (n === 1) {
      cascata(P, s.paineis[0], 90, 150, 1100, 430, {ptCat: 10});
    } else {
      const xs = [[72, 540], [668, 540]];
      cabecalhos(P, s.colunas || [], xs, 150, 16);
      s.paineis.forEach((p, i) => cascata(P, p, xs[i][0], 220, xs[i][1], 360, {ptCat: 9}));
    }
    logo(P);
    return P;
  };

  /* ---------------- tabelas ---------------- */
  const corNum = v => (v != null && v < 0 ? COR.vermelho : COR.branco);
  S.ativos = s => {
    const P = [];
    titulo(P, s);
    // nome | Weight | NAV ‖ P&L Return (Q) ‖ P&L Return (YTD)
    const cols = [[80, 330, 'l'], [410, 110, 'r'], [520, 120, 'r'], [690, 120, 'r'], [810, 110, 'r'],
                  [970, 120, 'r'], [1090, 110, 'r']];
    const yCab = 150;
    P.push(R(72, yCab, 1136, 76, {fill: COR.teal}));
    [[690, 230, s.colunas[0]], [970, 230, s.colunas[1]]].forEach(([x, w, t]) =>
      P.push(T(x, yCab + 4, w, 32, t, {pt: 15, al: 'c', va: 'm'})));
    ['', 'Weight', 'NAV', 'P&L', 'Return', 'P&L', 'Return'].forEach((t, i) =>
      P.push(T(cols[i][0], yCab + 38, cols[i][1], 34, t, {pt: 13, al: cols[i][2] === 'l' ? 'l' : 'r', va: 'm'})));
    const fmts = [v => pct(v, 1), v => nf(v, 2), v => nf(v, 2), v => pct(v, 1), v => nf(v, 2), v => pct(v, 1)];
    const passo = Math.min(30, (668 - (yCab + 84)) / Math.max(s.linhas.length, 1));
    let y = yCab + 84;
    s.linhas.forEach((l, i) => {
      const pt = l.n === 2 ? 10.5 : 13;
      if (l.n <= 1 && i) P.push(L(72, y - 1, 1208, y - 1, {c: COR.teal, esp: 1}));
      if (l.n === 0) P.push(R(72, y, 1136, passo, {fill: COR.tealEsc}));
      P.push(T(cols[0][0] + (l.n === 2 ? 18 : 0), y, cols[0][1], passo, l.r, {pt, va: 'm'}));
      l.v.forEach((v, j) => P.push(T(cols[j + 1][0], y, cols[j + 1][1], passo, fmts[j](v),
                                     {pt, al: 'r', va: 'm', c: j >= 2 ? corNum(v) : COR.branco})));
      y += passo;
    });
    [660, 940].forEach(x => P.push(L(x, yCab + 6, x, y, {c: COR.branco, esp: 1, alfa: 0.5})));
    logo(P);
    return P;
  };

  S.fcf = s => {
    const P = [];
    titulo(P, s);
    // nome | NAV ‖ FCF Q  FCF YTD ‖ %NAV — as divisórias ficam nos vãos entre colunas
    const cols = [[90, 380, 'l'], [500, 150, 'r'], [690, 160, 'r'], [870, 160, 'r'], [1070, 120, 'r']];
    const yCab = 170;
    P.push(R(72, yCab, 1136, 84, {fill: COR.teal}));
    P.push(T(500, yCab + 20, 150, 40, 'NAV', {pt: 18, al: 'r', va: 'm'}));
    P.push(T(690, yCab + 2, 340, 36, 'FCF', {pt: 18, al: 'c', va: 'm'}));
    P.push(T(690, yCab + 42, 160, 36, s.colunas[0], {pt: 14, al: 'r', va: 'm'}));
    P.push(T(870, yCab + 42, 160, 36, s.colunas[1], {pt: 14, al: 'r', va: 'm'}));
    P.push(T(1070, yCab + 20, 120, 40, '%NAV', {pt: 18, al: 'r', va: 'm'}));
    const fmts = [v => nf(v, 2), v => nf(v, 2), v => nf(v, 2), v => pct(v, 1)];
    let y = yCab + 96;
    const passo = 34;
    s.linhas.forEach((l, i) => {
      const pt = l.n === 2 ? 12 : 15;
      if (l.n === 1 && i) P.push(L(72, y - 2, 1208, y - 2, {c: COR.teal, esp: 1}));
      P.push(T(cols[0][0] + (l.n === 2 ? 22 : 0), y, cols[0][1], passo, l.r, {pt, va: 'm'}));
      l.v.forEach((v, j) => P.push(T(cols[j + 1][0], y, cols[j + 1][1], passo, fmts[j](v),
                                     {pt, al: 'r', va: 'm', c: j >= 1 ? corNum(v) : COR.branco})));
      y += passo;
    });
    [670, 1050].forEach(x => P.push(L(x, yCab + 6, x, y, {c: COR.branco, esp: 1, alfa: 0.5})));
    logo(P);
    return P;
  };

  /* Luxor FO Result: a tabela de duas colunas do board, células escuras com borda teal */
  function celula(P, x, y, w, h, t, o) {
    P.push(R(x, y, w, h, {fill: COR.fundo, line: COR.teal, espL: 2}));
    P.push(T(x + 14, y, w - 28, h, t, Object.assign({pt: 18, va: 'm', wrap: 1}, o || {})));
  }
  S.resultado_fo = s => {
    const P = [];
    titulo(P, s);
    const x = 448, w = 464;
    const n = s.linhas.length + 1;
    const hc = 72, gap = 10;
    const hTot = 80 + n * (hc + gap) + 10;
    const y0 = Math.max(96, (720 - hTot) / 2 + 10);
    P.push(R(x, y0, w, hTot, {fill: COR.teal}));
    P.push(R(x, y0, w, 78, {fill: COR.tealEsc}));
    P.push(T(x + 23, y0, 208, 78, 'Result', {pt: 20, al: 'c', va: 'm'}));
    P.push(T(x + 239, y0, 208, 78, 'R$', {pt: 20, al: 'c', va: 'm'}));
    let y = y0 + 88;
    s.linhas.forEach(([r, v]) => {
      celula(P, x + 23, y, 208, hc, r, {i: 1});
      celula(P, x + 239, y, 208, hc, nf(v, 2), {al: 'r'});
      y += hc + gap;
    });
    P.push(R(x, y, w, hc + 6, {fill: COR.tealEsc}));
    P.push(T(x + 16, y, 220, hc + 6, s.total[0], {pt: 18, va: 'm'}));
    P.push(T(x + 239, y, 194, hc + 6, nf(s.total[1], 2), {pt: 18, al: 'r', va: 'm'}));
    logo(P);
    return P;
  };

  S.receita = s => {
    const P = [];
    titulo(P, s);
    const x = 288, w = 744, n = s.linhas.length;
    const hc = 72, gap = 12;
    const y0 = 160;
    P.push(R(x, y0, w, 84 + n * (hc + gap) + 8, {fill: COR.teal}));
    P.push(R(x, y0, w, 80, {fill: COR.tealEsc}));
    const cx = [[x + 8, 268], [x + 288, 200], [x + 512, 216]];
    s.cab.forEach((t, i) => P.push(T(cx[i][0], y0, cx[i][1], 80, t, {pt: 20, al: 'c', va: 'm'})));
    let y = y0 + 88;
    s.linhas.forEach(([r, v, p]) => {
      celula(P, cx[0][0], y, cx[0][1], hc, r, {i: 1, pt: 20});
      celula(P, cx[1][0], y, cx[1][1], hc, nf(v, 2), {al: 'c', pt: 20});
      celula(P, cx[2][0], y, cx[2][1], hc, p == null ? '' : (s.cab[2] === '%' && Math.abs(p - 1) < 1e-9 ? '100%' : pct(p, 1)),
             {al: 'c', pt: 20});
      y += hc + gap;
    });
    if (s.nota_centro) P.push(T(0, y + 18, W, 40, s.nota_centro, {pt: 20, al: 'c', va: 'm'}));
    logo(P);
    return P;
  };

  /* ---------------- colunas simples (preços, resultado patrimonial) ---------------- */
  S.colunas = s => {
    const P = [];
    titulo(P, s);
    const n = s.paineis.length;
    const xs = n === 1 ? [[100, 1080]] : [[72, 540], [668, 540]];
    s.paineis.forEach((p, i) => {
      let y = 160;
      if (p.titulo) { P.push(T(xs[i][0], 150, xs[i][1], 36, p.titulo, {pt: 16, al: 'c', va: 'm'})); y = 210; }
      const bs = p.barras.map(b => Object.assign({cor: b.cor || p.cor}, b));
      barras(P, Object.assign({}, p, {barras: bs}), xs[i][0], y, xs[i][1], 600 - y,
             {larg: n === 1 ? 0.6 : 0.62, max: 80, ptValor: n === 1 ? 10 : 12, ptCat: n === 1 ? 10 : 11});
    });
    logo(P);
    return P;
  };

  /* ---------------- pilhas (New Asset Value | Growth) ---------------- */
  function pilhas(P, s, x, y, w, h, o) {
    o = o || {};
    const max = Math.max(...s.barras.map(b => b.total)) * 1.08;
    const slot = w / s.barras.length, bw = slot * 0.66;
    const ptT = o.ptTot || 8, ptC = o.ptCat || 7;
    s.barras.forEach((b, i) => {
      const cx = x + slot * (i + 0.5);
      let acc = 0;
      b.partes.forEach(pa => {
        const top = y + h * (1 - (acc + pa.v) / max), bot = y + h * (1 - acc / max);
        P.push(R(cx - bw / 2, top, bw, bot - top, {fill: pa.cor}));
        acc += pa.v;
      });
      const ytop = y + h * (1 - acc / max);
      P.push(T(cx - slot, ytop - ptT * PT * 1.6, slot * 2, ptT * PT * 1.4, nf(b.total, 0), {pt: ptT, al: 'c', va: 'm'}));
      P.push(T(cx - slot / 2 - 4, y + h + 5, slot + 8, ptC * PT * 1.5, b.r, {pt: ptC, al: 'c', va: 'm'}));
    });
    P.push(L(x, y + h, x + w, y + h, {c: COR.branco, esp: 1.5}));
    // legenda embaixo, centrada no gráfico
    const itens = s.legenda || [];
    const ptL = o.ptLeg || 10;
    const larg = itens.map(l => 2.2 * ptL + largura(l.s, ptL) + 2.4 * ptL);
    let lx = x + (w - larg.reduce((a, b) => a + b, 0)) / 2;
    const yl = o.yLeg || y + h + 42;
    itens.forEach((l, i) => {
      P.push(R(lx, yl + ptL * 0.35, ptL, ptL, {fill: l.cor, forma: 'elipse'}));
      P.push(T(lx + 1.6 * ptL, yl - ptL * 0.45, larg[i], ptL * 2.6, l.s, {pt: ptL, va: 'm'}));
      lx += larg[i];
    });
  }
  S.pilhas = s => {
    const P = [];
    titulo(P, s);
    pilhas(P, s, 110, 170, 1080, 400, {yLeg: 612});
    logo(P);
    return P;
  };

  /* ---------------- Alvorada Receivables sale ---------------- */
  S.recebiveis = s => {
    const P = [];
    titulo(P, s);
    // legenda à esquerda (no PBI era uma imagem)
    s.legenda.forEach((l, i) => {
      P.push(R(120, 220 + i * 52, 14, 14, {fill: l.cor}));
      P.push(T(142, 210 + i * 52, 220, 34, l.s, {pt: 13, va: 'm'}));
    });
    const y0 = 520, esc = 330 / Math.max(...s.barras.map(b => b.total));
    const xs = [520, 820], bw = 150;
    P.push(L(440, y0, 1080, y0, {c: COR.branco, esp: 1.5}));
    s.barras.forEach((b, i) => {
      const cx = xs[i];
      let pos = 0, neg = 0;
      const marcas = {};
      b.partes.forEach(pa => {
        let top, alt;
        if (pa.v >= 0) { top = y0 - (pos + pa.v) * esc; alt = pa.v * esc; pos += pa.v; }
        else { top = y0 + neg * esc; alt = -pa.v * esc; neg += -pa.v; }
        if (alt < 0.5) return;
        P.push(R(cx - bw / 2, top, bw, alt, {fill: pa.cor}));
        if (alt >= 14) P.push(T(cx - bw / 2, top, bw, alt, nf(pa.v, 1), {pt: 10, al: 'c', va: 'm'}));
        marcas[pa.s] = [top, alt];
      });
      P.push(T(cx - 100, y0 - pos * esc - 32, 200, 28, nf(b.total, 1), {pt: 15, al: 'c', va: 'm'}));
      P.push(T(cx - 100, y0 + neg * esc + 8, 200, 28, b.r, {pt: 15, al: 'c', va: 'm'}));
      P.push(T(i ? cx + bw / 2 + 8 : cx - bw / 2 - 128, y0 + 2, 120, 26, nf(b.impostos, 1),
               {pt: 15, al: i ? 'l' : 'r', va: 'm'}));
      // setas com o total de boi e de soja da posição atual
      if (b.boi != null) {
        [['boi', ['Cattle Receivable', 'Cattle Received']], ['soja', ['Soy Receivable', 'Soy Received']]].forEach(([k, cats]) => {
          const ms = cats.map(c => marcas[c]).filter(Boolean);
          if (!ms.length) return;
          const ym = Math.min(...ms.map(m => m[0])) + (Math.max(...ms.map(m => m[0] + m[1])) - Math.min(...ms.map(m => m[0]))) / 2;
          const xa = cx + bw / 2 + 14;
          P.push(L(xa, ym, xa + 36, ym, {c: COR.branco, esp: 4, seta: 1}));
          P.push(T(xa + 46, ym - 16, 120, 32, nf(b[k], 1), {pt: 15, va: 'm'}));
        });
      }
    });
    nota(P, s.nota, 15);
    logo(P);
    return P;
  };

  /* ---------------- Leverage & Debt Cost (Deneb do board) ---------------- */
  S.linhas = s => {
    const P = [];
    titulo(P, s);
    const ss = s.series;
    // cartões da legenda com o Kd do período
    const larg = 1040 / ss.length;
    ss.forEach((sr, i) => {
      const cx = 120 + larg * (i + 0.5);
      P.push(T(cx - larg / 2, 112, larg, 22, sr.s, {pt: 10, al: 'c', va: 'm', c: sr.cor}));
      P.push(R(cx - 37, 138, 74, 20, {fill: COR.chip, raio: 3}));
      if (sr.kd != null) P.push(T(cx - 37, 138, 74, 20, 'Kd: ' + pct(sr.kd, 1), {pt: 9, al: 'c', va: 'm'}));
    });
    const x = 110, w = 1060, y = 190, h = 380;
    const n = s.rotulos.length;
    const xv = j => x + (n > 1 ? w * j / (n - 1) : w / 2);
    s.rotulos.forEach((r, j) => P.push(T(xv(j) - 30, y + h + 8, 60, 12, r, {pt: 7, al: 'r', va: 'm', rot: -90,
                                                                            rx: xv(j), ry: y + h + 8})));
    ss.forEach(sr => {
      const [lo, hi] = sr.eixo2 ? s.eixo2 : s.eixo;
      const yv = v => y + h * (1 - (v - lo) / (hi - lo));
      const pts = sr.pontos;
      for (let j = 1; j < pts.length; j++)
        P.push(L(xv(pts[j - 1][0]), yv(pts[j - 1][1]), xv(pts[j][0]), yv(pts[j][1]),
                 {c: sr.cor, esp: sr.eixo2 ? 2.5 : 2, traco: sr.eixo2 ? 1 : 0}));
      if (pts.length === 1) P.push(R(xv(pts[0][0]) - 5, yv(pts[0][1]) - 5, 10, 10, {fill: sr.cor, forma: 'elipse'}));
      if (pts.length > 1) {
        const a = pts[0], z = pts[pts.length - 1];
        P.push(T(xv(a[0]) - 70, yv(a[1]) - 10, 62, 20, pct(a[1], 1), {pt: 10, al: 'r', va: 'm', c: sr.cor}));
      }
      const z = pts[pts.length - 1];
      if (z) P.push(T(xv(z[0]) + 8, yv(z[1]) - 10, 70, 20, pct(z[1], 1), {pt: 10, va: 'm', c: sr.cor}));
    });
    nota(P, s.nota, 8);
    logo(P);
    return P;
  };

  /* ---------------- NAV Break Down by Investors ---------------- */
  S.investidores = (s, ctx) => {
    const P = [];
    titulo(P, s);
    const moeda = (ctx && ctx.moeda && s.moedas[ctx.moeda]) ? ctx.moeda : s.padrao;
    const m = s.moedas[moeda];
    // data e moeda, como o slicer e os botões do PBI
    P.push(R(48, 120, 130, 30, {line: COR.branco, espL: 1}));
    P.push(T(56, 120, 120, 30, s.data, {pt: 11, va: 'm'}));
    ['BRL', 'USD'].filter(k => s.moedas[k]).forEach((k, i) => {
      P.push(R(190 + i * 64, 120, 60, 30, {fill: k === moeda ? COR.laranja : COR.fundo, line: COR.branco, espL: 1}));
      P.push(T(190 + i * 64, 120, 60, 30, k, {pt: 11, al: 'c', va: 'm', c: k === moeda ? COR.fundo : COR.branco}));
    });
    // tabela de membros
    P.push(R(48, 168, 270, 26, {fill: COR.tealEsc}));
    P.push(T(56, 168, 200, 26, 'Luxor Investors', {pt: 10, va: 'm'}));
    P.push(T(256, 168, 54, 26, '#', {pt: 10, al: 'r', va: 'm'}));
    m.membros.forEach(([r, n], i) => {
      const y = 196 + i * 22;
      P.push(T(56 + Math.min(String(r).length - String(r).trimStart().length, 8) * 2, y, 200, 22, String(r).trim(), {pt: 9, va: 'm'}));
      P.push(T(256, y, 54, 22, String(n), {pt: 9, al: 'r', va: 'm'}));
      P.push(L(48, y + 22, 318, y + 22, {c: COR.teal, esp: 0.75}));
    });
    // cascata: itens laranja, totais teal
    const x = 340, w = 900, y = 170, h = 400;
    const bs = m.barras;
    let acc = 0, max = 0;
    const seg = bs.map(b => {
      let a, z;
      if (b.k === 'fim') { a = 0; z = b.v; acc = b.v; }
      else { a = acc; z = acc + b.v; acc = z; }
      max = Math.max(max, a, z);
      return [a, z];
    });
    max *= 1.06;
    const slot = w / bs.length, bw = slot * 0.7;
    bs.forEach((b, i) => {
      const cx = x + slot * (i + 0.5);
      const [a, z] = seg[i];
      const top = y + h * (1 - Math.max(a, z) / max), bot = y + h * (1 - Math.min(a, z) / max);
      P.push(R(cx - bw / 2, top, bw, Math.max(bot - top, 1.5), {fill: b.k === 'fim' ? COR.teal : COR.laranja}));
      P.push(T(cx - slot / 2, top - 18, slot, 16, nf(b.v, 0) + 'M', {pt: 8, al: 'c', va: 'm'}));
      P.push(T(cx - slot / 2, y + h + 6, slot, 34, b.r, {pt: encaixa(b.r, 8, slot * 2, 6), al: 'c', va: 't', wrap: 1}));
    });
    P.push(L(x, y + h, x + w, y + h, {c: COR.branco, esp: 1}));
    P.push(T(0, 640, W, 34, m.frase, {pt: 16, al: 'c', va: 'm'}));
    logo(P);
    return P;
  };

  /* ---------------- Budget ---------------- */
  S.capa = s => {
    const P = [];
    P.push(R(16, 416, 384, 288, {fill: 'FFC000', raio: 10}));
    P.push(T(32, 608, 352, 80, s.texto, {pt: 22, va: 'm'}));
    logo(P);
    return P;
  };

  /* A aba Comitê do fluxo de caixa do FO, como no Excel: fundo branco, preenchimento e
     negrito de cada linha vindos da própria planilha. */
  S.budget_fc = s => {
    const P = [];
    titulo(P, s);
    const x = 120, w = 1040, y0 = 124;
    // rótulo | Mês: Orçado Realizado ΔR$k | YTD: Orçado Realizado ΔR$k %PL | Ano: Orçado Real+Orç
    const larg = [262, 92, 92, 62, 92, 92, 62, 62, 112, 112];
    const xs = [];
    larg.reduce((acc, l) => { xs.push(acc); return acc + l; }, x);
    const n = s.linhas.length;
    const hl = Math.min(17.5, (700 - y0 - 40) / (n + 2));
    P.push(R(x, y0, w, hl * (n + 2), {fill: 'FFFFFF'}));
    // cabeçalho em duas linhas
    P.push(R(x, y0, w, hl * 2, {fill: '1A3C34'}));
    P.push(T(xs[0] + 4, y0, larg[0] - 8, hl * 2, s.cabecalho, {pt: 8, va: 'm', fonte: FONTE_TAB, b: 1}));
    const grupos = [[1, 3, s.grupos[0]], [4, 4, s.grupos[1]], [8, 2, s.grupos[2]]];
    grupos.forEach(([i0, k, t]) => {
      const gx = xs[i0], gw = larg.slice(i0, i0 + k).reduce((a, b) => a + b, 0);
      P.push(T(gx, y0, gw, hl, t, {pt: 8, al: 'c', va: 'm', fonte: FONTE_TAB, b: 1}));
      P.push(L(gx, y0, gx, y0 + hl * (n + 2), {c: 'BFBFBF', esp: 0.75}));
    });
    ['Orçado', 'Realizado', 'Δ R$ k', 'Orçado', 'Realizado', 'Δ R$ k', '% PL', 'Orçado', 'Real + Orç'].forEach((t, i) =>
      P.push(T(xs[i + 1], y0 + hl, larg[i + 1] - 4, hl, t, {pt: 7.5, al: 'r', va: 'm', fonte: FONTE_TAB, b: 1})));
    const f = [v => nf(v, 0), v => nf(v, 0), v => nf(v, 0), v => nf(v, 0), v => nf(v, 0), v => nf(v, 0),
               v => pct(v, 1), v => nf(v, 0), v => nf(v, 0)];
    s.linhas.forEach((l, i) => {
      const y = y0 + hl * (i + 2);
      if (l.sep) return;
      const escuro = l.fill && parseInt(l.fill.slice(0, 2), 16) + parseInt(l.fill.slice(2, 4), 16) + parseInt(l.fill.slice(4, 6), 16) < 300;
      const ct = escuro ? 'FFFFFF' : '000000';
      if (l.fill) P.push(R(x, y, w, hl, {fill: l.fill}));
      P.push(T(xs[0] + 4, y, larg[0] - 8, hl, l.r, {pt: 8, va: 'm', fonte: FONTE_TAB, b: l.b ? 1 : 0, c: ct}));
      l.v.forEach((v, j) => {
        if (v == null) return;
        const neg = v < -0.0005 && !escuro && (j === 2 || j === 5);
        P.push(T(xs[j + 1], y, larg[j + 1] - 4, hl, f[j](v),
                 {pt: 8, al: 'r', va: 'm', fonte: FONTE_TAB, b: l.b ? 1 : 0, c: neg ? 'C00000' : ct}));
      });
      P.push(L(x, y + hl, x + w, y + hl, {c: 'D9D9D9', esp: 0.5}));
    });
    logo(P);
    return P;
  };

  S.highlights = s => {
    const P = [];
    titulo(P, s);
    const pos = [[176, 163], [624, 163], [176, 510], [624, 510]];
    P.push(L(608, 150, 608, 660, {c: COR.laranja, esp: 1}));
    P.push(L(140, 460, 1140, 460, {c: COR.laranja, esp: 1}));
    s.quadrantes.slice(0, 4).forEach((q, i) => {
      const [x, y] = pos[i];
      const y0 = i < 2 ? 150 : 478;
      P.push(T(x - 20, y0, 440, 30, q.q, {pt: 16, va: 'm', c: COR.laranja}));
      q.itens.forEach((it, j) => {
        const yy = y0 + 40 + j * 32;
        const txt = it.v == null ? `${it.r} N/A` : `${it.r} ${it.v >= 0 ? '+' : '-'}${nf(Math.abs(it.v), 0)}k`;
        const c = it.fav ? COR.verdeFav : COR.branco;
        P.push(R(x - 4, yy + 11, 6, 6, {fill: c, forma: 'elipse'}));
        P.push(T(x + 10, yy, 420, 28, txt, {pt: 13, va: 'm', c}));
      });
    });
    logo(P);
    return P;
  };

  S.pendente = s => {
    const P = [];
    titulo(P, {titulo: s.titulo});
    P.push(T(64, 300, 1150, 40, 'Sem dado para este trimestre', {pt: 20, c: COR.laranja}));
    P.push(T(64, 344, 1150, 60, s.motivo || '', {pt: 14, wrap: 1, va: 't'}));
    logo(P);
    return P;
  };

  /* ================= Carta Trimestral (retrato, 888×1134 px) =================
     Geometria tirada do Carta_Trimestral_<idioma>_2Q2026.pptx (polegada × 96). Os
     números vêm do build; os textos (ctx.textos) são os que o Arthur cola na aba, no
     idioma da tela (ctx.lang). */
  const CARTA = {fundo: '0F3E44', caixa: '1D6E79', tinta: '262626', ouro: 'FFA400', cinza: 'BFBFBF'};
  const ROT = {
    pt: {capa: 'Carta\nTrimestral', proposito: 'Propósito e Missão', valores: 'Valores',
         destaques: 'Destaques e Prioridades', atualizacoes: 'Atualizações do Grupo Luxor',
         lido: 'O que temos lido, ouvido ou feito:', retorno: 'Retorno do Grupo Luxor vs IPCA',
         portfolio: 'Retorno por Portfolio', m36: '36 Meses', patrimonio: 'Evolução do Patrimônio - R$ Milhões',
         alocacao: 'Alocação por Portfolio', vazio: 'Texto ainda não colado — use "Editar textos".'},
    en: {capa: 'Quarterly\nLetter', proposito: 'Purpose and Mission', valores: 'Values',
         destaques: 'Highlights and Priorities', atualizacoes: 'Luxor Group Updates',
         lido: 'What we have been reading, listening to or doing:', retorno: 'Luxor Group Return vs IPCA',
         portfolio: 'Return by Portfolio', m36: '36 Months', patrimonio: 'Asset Evolution - R$ Millions',
         alocacao: 'Allocation by Portfolio', vazio: 'English text not pasted yet — use "Editar textos".'},
  };
  const rot = (ctx, k) => (ROT[ctx.lang] || ROT.pt)[k];
  const tituloCarta = (P, t, y, h) =>
    P.push(T(34, y, 821, h || 56, t, {pt: 24.5, al: 'c', va: 'm', c: CARTA.ouro, fonte: FONTE_CARTA, sp: 2.5}));
  function rodapeCarta(P, branca) {
    if (branca) {
      P.push(L(140, 1108, 800, 1108, {c: CARTA.ouro, esp: 1}));
      P.push(I(806, 1094, 32, 29, LOGO, {logo: 1}));
    } else {
      P.push(L(75, 1108, 811, 1108, {c: CARTA.ouro, esp: 1}));
      P.push(I(816, 1094, 32, 29, LOGO, {logo: 1}));
    }
  }

  /* texto colado → parágrafos (uma linha = um parágrafo) com **negrito** e *itálico* */
  function paragrafos(txt) {
    return String(txt || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const runs = [];
      const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
      let i = 0, m;
      while ((m = re.exec(l))) {
        if (m.index > i) runs.push({t: l.slice(i, m.index)});
        const b = m[0].startsWith('**');
        runs.push({t: m[0].slice(b ? 2 : 1, b ? -2 : -1), b: b ? 1 : 0, i: b ? 0 : 1});
        i = m.index + m[0].length;
      }
      if (i < l.length) runs.push({t: l.slice(i)});
      return runs;
    });
  }
  /* maior corpo (de `max` até `min`) em que os parágrafos cabem na caixa — medido no
     próprio navegador, com a mesma fonte e entrelinha da tela e do PPTX */
  const ENTRE = 1.2, ESP_PAR = 0.55;    // entrelinha e espaço depois do parágrafo (em "em")
  function corpoQueCabe(paras, w, h, max, min, fonte) {
    if (typeof document === 'undefined' || !paras.length) return max;
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:-99999px;top:0;width:${w}px;line-height:${ENTRE};` +
      `font-family:'${fonte}','Segoe UI',Arial,sans-serif;text-align:justify`;
    d.innerHTML = paras.map(r => `<p style="margin:0 0 ${ESP_PAR}em">${'  ' + r.map(x => escH(x.t)).join('')}</p>`).join('');
    document.body.appendChild(d);
    let pt = max;
    for (; pt > min; pt -= 0.25) {
      d.style.fontSize = (pt * PT) + 'px';
      if (d.scrollHeight <= h) break;
    }
    d.remove();
    return pt;
  }
  function blocoTexto(P, txt, x, y, w, h, ctx, o) {
    o = o || {};
    const paras = paragrafos(txt);
    if (!paras.length) {
      if (ctx && ctx.tela) P.push(T(x, y, w, 40, rot(ctx, 'vazio'), {pt: 11, c: '999999', i: 1, fonte: FONTE_CARTA, va: 't'}));
      return;
    }
    const pt = corpoQueCabe(paras, w, h * 0.97, o.max || 12, o.min || 8, FONTE_CARTA);
    P.push(T(x, y, w, h, '', {k2: 'par', paras, pt, c: o.c || CARTA.tinta, fonte: FONTE_CARTA, va: 't', al: 'j', wrap: 1}));
  }

  S.carta_capa = (s, ctx) => {
    const P = [];
    if (s.logo) P.push(I(222, 372, 482, 229, s.logo));
    // o SVG do logo traz "INVESTIMENTOS"; no PPTX original um retângulo da cor do fundo o cobre
    P.push(R(141, 563, 642, 70, {fill: CARTA.fundo}));
    P.push(R(10, 839, 482, 206, {fill: CARTA.caixa}));
    P.push(T(55, 846, 398, 117, rot(ctx, 'capa'), {pt: 32.6, al: 'c', va: 'm', fonte: FONTE_CARTA_T, sp: 3}));
    P.push(L(124, 963, 379, 963, {c: 'D9B54A', esp: 1}));
    P.push(T(89, 969, 329, 50, s.rotulo, {pt: 24.5, al: 'c', va: 'm', fonte: FONTE_CARTA_T, sp: 3}));
    rodapeCarta(P);
    return P;
  };

  S.carta_proposito = (s, ctx) => {
    const P = [];
    const l = ctx.lang === 'en' ? 'en' : 'pt';
    tituloCarta(P, rot(ctx, 'proposito'), 66);
    if (s.img && s.img['proposito_' + l]) P.push(I(21, 122, 821, 357, s.img['proposito_' + l], {cabe: 1}));
    tituloCarta(P, rot(ctx, 'valores'), 518);
    if (s.img && s.img['valores_' + l]) P.push(I(42, 606, 804, 406, s.img['valores_' + l], {cabe: 1}));
    rodapeCarta(P);
    return P;
  };

  S.carta_texto = (s, ctx) => {
    const P = [];
    const tx = (ctx.textos || {});
    P.push(R(0, 0, 130, 1134, {fill: CARTA.fundo}));
    // título vertical, lendo de baixo para cima, centrado na faixa
    P.push(T(0, 0, 1067, 90, rot(ctx, s.slot), {pt: 36.7, al: 'c', va: 'm', c: CARTA.ouro, fonte: FONTE_CARTA_T, sp: 2,
                                                  rot: -90, rx: 65, ry: 567 - 1067 / 2}));
    const leituras = s.slot === 'atualizacoes' ? (tx.leituras || []).filter(x => x.img || x.texto) : [];
    if (!leituras.length) {
      blocoTexto(P, tx[s.slot], 170, 69, 661, 1010, ctx);
    } else {
      blocoTexto(P, tx[s.slot], 170, 69, 661, 380, ctx, {max: 12.2});
      P.push(T(88, 460, 826, 44, rot(ctx, 'lido'), {pt: 20, al: 'c', va: 'm', c: CARTA.ouro, fonte: FONTE_CARTA, sp: 2}));
      const passo = Math.min(294, 560 / leituras.length);
      leituras.slice(0, 3).forEach((it, i) => {
        const y = 522 + i * passo;
        if (it.img) P.push(I(215, y + 7, 159, Math.min(242, passo - 30), it.img, {cabe: 1}));
        blocoTexto(P, it.texto, 416, y, 290, Math.min(252, passo - 20), ctx, {max: 12.2});
      });
    }
    rodapeCarta(P, true);
    return P;
  };

  S.carta_retornos = (s, ctx) => {
    const P = [];
    tituloCarta(P, rot(ctx, 'retorno'), 51, 64);
    // três painéis (trimestre, YTD, 36 meses) na MESMA escala — o ajuste feito no PBI em 11/11
    const cab = [s.q, s.ytd, rot(ctx, 'm36')];
    const pain = s.ipca.map(([fo, ip]) => ({fmt: 'pct1', barras: [
      {r: 'Luxor FO', v: fo, cor: fo >= 0 ? COR.laranja : COR.vermelho}, {r: 'IPCA', v: ip, cor: COR.cinzaKR}]}));
    const esc = escala(pain);
    const wp = 262;
    pain.forEach((p, i) => {
      P.push(T(58 + i * wp, 150, wp, 24, cab[i], {pt: 11, al: 'c', va: 'm'}));
      barras(P, p, 58 + i * wp, 180, wp, 290, {escala: esc, ptValor: 10, semCat: 1, larg: 0.36, max: 60});
    });
    // legenda: o FO tem as duas cores (positivo/negativo), como no PBI
    P.push(R(330, 498, 12, 12, {fill: COR.laranja}));
    P.push(R(346, 498, 12, 12, {fill: COR.vermelho}));
    P.push(T(364, 490, 110, 28, 'Luxor FO', {pt: 13, va: 'm'}));
    P.push(R(484, 498, 12, 12, {fill: COR.cinzaKR}));
    P.push(T(502, 490, 80, 28, 'IPCA', {pt: 13, va: 'm'}));

    tituloCarta(P, rot(ctx, 'portfolio'), 602, 64);
    const wq = 380;
    [s.q, s.ytd].forEach((c, i) => {
      P.push(T(58 + i * (wq + 26), 720, wq, 24, c, {pt: 10, al: 'c', va: 'm'}));
      barras(P, {fmt: 'pct1', barras: s.portfolio[i]}, 58 + i * (wq + 26), 750, wq, 170,
             {escala: [-0.5, 0.5], ptValor: 8.5, ptCat: 8, larg: 0.45, max: 50});
    });
    rodapeCarta(P);
    return P;
  };

  S.carta_patrimonio = (s, ctx) => {
    const P = [];
    tituloCarta(P, rot(ctx, 'patrimonio'), 40);
    const bs = s.barras.map(b => Object.assign({}, b, {r: ctx.lang === 'en' ? b.r : (b.rp || b.r)}));
    pilhas(P, {barras: bs, legenda: s.legenda}, 60, 130, 770, 300, {ptTot: 6.5, ptCat: 5.5, yLeg: 462, ptLeg: 8});
    tituloCarta(P, rot(ctx, 'alocacao'), 690);
    s.cartoes.forEach((c, i) => cartao(P, c, 53 + i * 265, 790, 253, 200, {ptNome: 14, ptLinha: 12.5, passo: 20, alto: 26}));
    rodapeCarta(P);
    return P;
  };

  const prims = (s, ctx) => (S[s.t] || S.pendente)(s, ctx || {});
  const fundo = s => s && s.t === 'carta_texto' ? 'FFFFFF' : s && s.t && s.t.startsWith('carta_') ? CARTA.fundo : COR.fundo;

  /* ---------------- saída HTML ---------------- */
  const escH = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const rgba = (hex, a) => {
    const n = parseInt(hex, 16);
    return a == null ? '#' + hex : `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  };
  const JUST = {l: 'flex-start', c: 'center', r: 'flex-end'};
  const ALINH = {t: 'flex-start', m: 'center', b: 'flex-end'};
  /* aspas SIMPLES: isto vai dentro de style="…" — aspas duplas fechavam o atributo e
     tudo depois da fonte (alinhamento inclusive) sumia */
  function fonteCSS(p) {
    if (p.fonte === FONTE_TAB) return `font-family:Calibri,Carlito,Arial,sans-serif;font-weight:${p.b ? 700 : 400}`;
    if (p.fonte === FONTE_CARTA) return `font-family:Aptos,'Segoe UI',Arial,sans-serif;font-weight:${p.b ? 700 : 400}`;
    if (p.fonte === FONTE_CARTA_T) return `font-family:'Roboto Medium',Roboto,'Segoe UI',Arial,sans-serif;font-weight:500`;
    return `font-family:'Segoe UI Semibold','Segoe UI',system-ui,sans-serif;font-weight:600`;
  }
  const runHTML = r => {
    const st = (r.b ? 'font-weight:700;' : '') + (r.i ? 'font-style:italic;' : '');
    return st ? `<span style="${st}">${escH(r.t)}</span>` : escH(r.t);
  };
  function html(ps, base) {
    const linhas = [];
    const corpo = ps.map(p => {
      if (p.k === 'l') { linhas.push(p); return ''; }
      const box = `left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px;width:${p.w.toFixed(1)}px;height:${p.h.toFixed(1)}px`;
      if (p.k === 'r') {
        const st = box + (p.fill ? `;background:${rgba(p.fill, p.alfa)}` : '') +
          (p.line ? `;border:${p.espL || 1}px solid #${p.line}` : '') +
          (p.forma === 'elipse' ? ';border-radius:50%' : p.raio ? `;border-radius:${p.raio}px` : '');
        return `<div class="pr" style="${st}"></div>`;
      }
      if (p.k === 'i') {
        const src = String(p.src).startsWith('data:') ? p.src : (base || '') + p.src;
        return `<img class="pi${p.cobre ? ' cobre' : ''}${p.cabe ? ' cabe' : ''}" src="${escH(src)}" alt="" style="${box}">`;
      }
      if (p.k2 === 'par') {
        // parágrafos justificados da carta; o recuo da 1ª linha são dois em-spaces, igual no PPTX
        const st = `${box};font-size:${(p.pt * PT).toFixed(2)}px;color:#${p.c || CARTA.tinta};${fonteCSS(p)};line-height:${ENTRE}`;
        return `<div class="ppar" style="${st}">` + p.paras.map(r =>
          `<p style="margin:0 0 ${ESP_PAR}em;text-align:justify">  ${r.map(runHTML).join('')}</p>`).join('') + '</div>';
      }
      /* texto girado (rótulo do eixo X do Leverage): a caixa fica de pé com o fim do
         texto em (rx, ry) — mesma conta do PPTX, que gira em torno do centro */
      const caixa = p.rot ? `left:${(p.rx - p.w / 2).toFixed(1)}px;top:${(p.ry + p.w / 2 - p.h / 2).toFixed(1)}px;` +
        `width:${p.w.toFixed(1)}px;height:${p.h.toFixed(1)}px;transform:rotate(${p.rot}deg)` : box;
      const st = `${caixa};font-size:${(p.pt * PT).toFixed(2)}px;color:${rgba(p.c || COR.branco, p.alfa)};${fonteCSS(p)};` +
        `justify-content:${JUST[p.al || 'l']};align-items:${ALINH[p.va || 'm']};text-align:${{l: 'left', c: 'center', r: 'right'}[p.al || 'l']}` +
        (p.i ? ';font-style:italic' : '') + (p.sp ? `;letter-spacing:${(p.sp * PT).toFixed(2)}px` : '');
      const conteudo = p.runs ? p.runs.map(r => `<span style="color:#${r.c || p.c || COR.branco}">${escH(r.t)}</span>`).join('')
        : `<span>${escH(p.t)}</span>`;
      return `<div class="pt${p.wrap ? ' quebra' : ''}" style="${st}">${conteudo}</div>`;
    }).join('');
    const svg = linhas.length ? `<svg class="plinhas" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
      `<defs><marker id="seta" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill="#FFFFFF"/></marker></defs>` +
      linhas.map(l => `<line x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" ` +
        `stroke="#${l.c || COR.branco}" stroke-width="${l.esp || 1}"${l.alfa != null ? ` stroke-opacity="${l.alfa}"` : ''}` +
        `${l.traco ? ' stroke-dasharray="6 4"' : ''}${l.seta ? ' marker-end="url(#seta)"' : ''}/>`).join('') + '</svg>' : '';
    return corpo + svg;
  }

  /* ---------------- saída PPTX (pptxgenjs) ---------------- */
  const AL = {l: 'left', c: 'center', r: 'right'};
  const VA = {t: 'top', m: 'middle', b: 'bottom'};
  const pol = v => +(v / PX_IN).toFixed(4);
  function pptx(pres, sl, ps, imagens) {
    for (const p of ps) {
      if (p.k === 'l') {
        const x = Math.min(p.x1, p.x2), y = Math.min(p.y1, p.y2);
        const o = {x: pol(x), y: pol(y), w: pol(Math.max(Math.abs(p.x2 - p.x1), 0.01)), h: pol(Math.max(Math.abs(p.y2 - p.y1), 0.01)),
          line: Object.assign({color: p.c || COR.branco, width: (p.esp || 1) * 0.75},
                              p.traco ? {dashType: 'dash'} : {}, p.seta ? {endArrowType: 'triangle'} : {},
                              p.alfa != null ? {transparency: Math.round((1 - p.alfa) * 100)} : {})};
        if ((p.x2 - p.x1) * (p.y2 - p.y1) < 0) o.flipV = true;
        if (p.x2 < p.x1 && p.y2 === p.y1) o.flipH = true;
        sl.addShape(pres.ShapeType.line, o);
        continue;
      }
      const g = {x: pol(p.x), y: pol(p.y), w: pol(Math.max(p.w, 0.5)), h: pol(Math.max(p.h, 0.5))};
      if (p.k === 'r') {
        const o = Object.assign({}, g);
        if (p.fill) o.fill = {color: p.fill, transparency: p.alfa != null ? Math.round((1 - p.alfa) * 100) : 0};
        else o.fill = {type: 'none'};
        if (p.line) o.line = {color: p.line, width: (p.espL || 1) * 0.75};
        let forma = pres.ShapeType.rect;
        if (p.forma === 'elipse') forma = pres.ShapeType.ellipse;
        else if (p.raio) { forma = pres.ShapeType.roundRect; o.rectRadius = Math.min(0.5, p.raio / Math.min(p.w, p.h)); }
        sl.addShape(forma, o);
        continue;
      }
      if (p.k === 'i') {
        const data = imagens && imagens[p.src] ? imagens[p.src] : (String(p.src).startsWith('data:') ? p.src : null);
        if (!data) continue;
        const o = Object.assign({data}, g);
        if (p.cobre) o.sizing = {type: 'cover', w: g.w, h: g.h};
        if (p.cabe && imagens && imagens.__dim && imagens.__dim[p.src]) {
          // "contain": a imagem inteira dentro da caixa, centrada, sem distorcer
          const [iw, ih] = imagens.__dim[p.src];
          const k = Math.min(p.w / iw, p.h / ih), w2 = iw * k, h2 = ih * k;
          Object.assign(o, {x: pol(p.x + (p.w - w2) / 2), y: pol(p.y + (p.h - h2) / 2), w: pol(w2), h: pol(h2)});
        }
        sl.addImage(o);
        continue;
      }
      if (p.k2 === 'par') {
        const runs = [];
        p.paras.forEach(r => r.forEach((x, j) => runs.push({
          text: (j === 0 ? '  ' : '') + x.t,
          options: {bold: !!x.b, italic: !!x.i, breakLine: j === r.length - 1, paraSpaceAfter: +(p.pt * ESP_PAR).toFixed(2)}})));
        sl.addText(runs, Object.assign({}, g, {fontFace: p.fonte, fontSize: +p.pt.toFixed(2), color: p.c || CARTA.tinta,
          align: 'justify', valign: 'top', margin: 0, lineSpacingMultiple: ENTRE, fit: 'none'}));
        continue;
      }
      const base = {fontFace: p.fonte || FONTE, fontSize: +p.pt.toFixed(2),
        bold: p.fonte && p.fonte !== FONTE ? !!p.b : false, italic: !!p.i, color: p.c || COR.branco,
        align: AL[p.al || 'l'], valign: VA[p.va || 'm'], margin: 0, wrap: !!p.wrap, fit: 'none'};
      if (p.sp) base.charSpacing = p.sp;
      if (p.alfa != null) base.transparency = Math.round((1 - p.alfa) * 100);
      let o = Object.assign({}, g, base);
      if (p.rot) {
        // gira em torno do centro: a caixa vira de pé com o fim do texto em (rx, ry)
        const cw = p.w, ch = p.h;
        o = Object.assign(o, {x: pol(p.rx - cw / 2), y: pol(p.ry + cw / 2 - ch / 2), w: pol(cw), h: pol(ch), rotate: 270});
      }
      const txt = p.runs ? p.runs.map(r => ({text: r.t, options: {color: r.c || p.c || COR.branco}})) : p.t;
      sl.addText(txt, o);
    }
  }

  window.AP_LAYOUT = {prims, html, pptx, fundo, COR, LOGO, nf, pct, pagina,
                      tam: () => ({W, H})};
})();
