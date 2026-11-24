/* Painel de Fluxo de Caixa da Fazenda Pão Grande (FPG).

   CÓPIA do painel do Shiva, que é cópia do do Tarituba
   (`Fluxo de Caixa Tarituba/dashboard/app.js`), que
   já passou por várias rodadas de revisão da Controladoria — os comentários de
   histórico abaixo são de lá e explicam por que cada coisa é como é. O que muda
   aqui:
     - a aba Resumo escolhe à mão as linhas abaixo de Receita/Despesa Total
       (naturezas e grupos de níveis diferentes) — vêm de `D.resumo`, não dos
       grupos de nível 1 como no Tarituba (`linhasResumo`);
     - as contas bancárias são uma lista (`D.saldos.contas`), não três campos
       fixos — na FPG são nove;
     - um lançamento pode ter vindo de outra natureza do Bimer (de-para da
       planilha): o detalhe mostra a natureza de origem (`cod_bimer`).

   QUATRO PÁGINAS espelhando as abas da planilha: Resumo, Resumo Simplificado,
   Receitas e Despesas. A hierarquia de grupos vem da planilha (ou do cadastro de
   naturezas do Hub) pelo `extrair_fpg.py`, não escrita aqui.

   Identidade do Hub P&C (theme.css vendorizado de `Hub de Visualização/assets/`).
   ATENÇÃO: não copiar o vendor/ do painel do Haras — ele migrou para outra
   identidade (azul, --surface #0A3050) e não é mais o Hub P&C.

   CONVENÇÃO DE SINAL: sinal de caixa em tudo — entrada +, saída −, tanto no
   orçado quanto no realizado (o extrator normaliza os dois). Então:
     variação = receita + despesa       (despesa já é negativa)
     desvio   = realizado − orçado      (positivo = sobrou mais caixa = bom)

   O desvio NÃO inverte sinal como no painel do Haras. Lá a medida é gasto
   ("gastar mais é ruim, mostra −"); aqui é caixa, e caixa a mais já é positivo
   por natureza. Inverter seria mentir duas vezes. */
'use strict';

const D = window.FPG_DATA;
/* Ponte com o Hub (botão do Trello, cadastro) — só existe lá; por file:// é undefined. */
const HUB = window.FPG_HUB;

/* ── tokens (espelham o theme.css do hub) ── */
const C = {
  orange: '#FFA400', orangeDeep: '#E08E00', teal: '#2E97A6', tealDeep: '#1D6E79',
  ink: '#EAF4F4', ink2: '#A7C3C5', ink3: '#6E8C90', pos: '#46B678', neg: '#E5674E',
  warn: '#F2C14E', line: 'rgba(255,255,255,.10)', surface: '#143840'
};

const fmt = {
  rs: v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  k: v => Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'M'
    : (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + 'k',
  n: v => v == null ? '—' : (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  sig: v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  int: v => (v || 0).toLocaleString('pt-BR'),
  /* sem centavos: Receita Total e Despesa Total (pedido da chefe, 28/10/2026).
     Meio para LONGE do zero, como o Excel — o Math.round levaria −2,5 a −2 —, e sem "−0". */
  r0: v => v == null ? '—' : ((Math.sign(v) * Math.round(Math.abs(v))) || 0).toLocaleString('pt-BR'),
  pct: v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%'
};
const cls = v => v == null || Math.abs(v) < 0.005 ? '' : v > 0 ? 'pos' : 'neg';
const seta = v => v == null || Math.abs(v) < 0.005 ? '' : v > 0 ? '▲' : '▼';

/* ── ECharts: base compartilhada com o hub ── */
function baseOpt() {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Fakt Pro, system-ui, sans-serif', color: C.ink2 },
    grid: { left: 72, right: 62, top: 38, bottom: 40 },
    tooltip: {
      trigger: 'axis', backgroundColor: '#0b1f24', borderColor: C.line,
      textStyle: { color: C.ink }, axisPointer: { type: 'shadow' }
    },
    legend: { textStyle: { color: C.ink2 }, top: 2, icon: 'roundRect', itemWidth: 12, itemHeight: 12 }
  };
}
const axis = extra => Object.assign({
  axisLine: { lineStyle: { color: C.line } }, axisLabel: { color: C.ink3 },
  splitLine: { lineStyle: { color: C.line } }, axisTick: { show: false }
}, extra || {});
const charts = [];
function mkChart(el, opt) {
  if (!el) return null;
  const c = echarts.init(el, null, { renderer: 'canvas' });
  c.setOption(opt); charts.push(c); return c;
}
function clearCharts() { while (charts.length) charts.pop().dispose(); }
window.addEventListener('resize', () => charts.forEach(c => c.resize()));

/* ── estado ── */
const PAGINAS = [
  { v: 'resumo', t: 'Resumo' },
  { v: 'simples', t: 'Resumo Simplificado' },
  { v: 'receitas', t: 'Receitas' },
  { v: 'despesas', t: 'Despesas' }
];
const S = {
  pagina: 'resumo',
  /* Padrão 'ambos' (pedido do Leonardo, 25/09) — mesma lógica do
     `medidaFluxo` do Resumo logo abaixo: a página já abre comparando
     orçado × realizado, que é o que se quer olhar primeiro. */
  medida: 'ambos',   // 'real' | 'orc' | 'ambos'
  /* Não existe estado de "esconder sem uso" (botão removido a pedido do
     Leonardo, 21/09, no Tarituba). As naturezas sem orçamento e sem movimento
     aparecem SEMPRE, esmaecidas — poder escondê-las repetiria o erro que o
     painel existe para expor: natureza do plano sem linha na planilha some do
     fluxo sem erro nenhum aparecer. */
  /* Detalhe aberto por natureza — Map cod -> {ini,fim,tipo} (meses 1-12,
     inclusive nos dois lados; tipo 'real'|'orc'). Era um Set (só cod, sempre
     o ano inteiro); virou Map em 24/09 porque agora se clica na CÉLULA —
     mês, acumulado ou o total Ano — e cada uma abre só o recorte que
     representa. ini===fim é um mês só; ini=1,fim=12 é o ano.
     `tipo` entrou em 25/09 (pedido da chefe: "fazer pro orçado a mesma coisa
     que fizemos pro realizado") — cada natureza só tem UM detalhe aberto por
     vez, e agora esse detalhe pode ser tanto os lançamentos (clique no
     Realizado) quanto os itens do orçamento (clique no Orçado); `tipo` diz
     qual dos dois desenhar. */
  aberta: new Map(),
  formMes: null,      // mês (1–12) com o formulário de saldo aberto
  /* Mês de comparação do Resumo Simplificado — null usa o último mês fechado
     (NF). Botão pra trocar (pedido do Leonardo, 25/09): rever um mês anterior
     sem esperar o próximo fechar. */
  mesSimples: null,
  /* Quais grupos (nível 1+) estão destrinchados no Resumo Simplificado —
     Set de chaves "aba:índice-na-estrutura". Virou clique POR LINHA em
     25/09 (pedido do Leonardo, depois de comparar com um botão global de
     "mostrar tudo": clicar na linha deixa abrir só a que interessa — ex.:
     só "Suporte Tarituba" — sem destrinchar a Receita junto). */
  simplesAbertos: new Set(),
  /* estado PRÓPRIO da tabela do Resumo: o `medida` acima controla as tabelas
     de Receitas/Despesas, e compartilhar faria mexer numa alterar a outra.
     Padrão 'ambos' porque a fidelidade à aba da planilha foi o pedido. */
  medidaFluxo: 'ambos',
  /* Registro do centro do HPG (fim da página Resumo): fechado por padrão — não é do fluxo,
     é para investigar. `hpgMes` = mês com a lista de lançamentos aberta (1–12) ou null;
     `hpgFiltro` = 'todos' (clique no saldo do mês) ou 'fora' (fora da nota de débito). */
  hpgAberto: false,
  hpgMes: null,
  hpgFiltro: 'todos'
};

const MESES_LONGO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/* Texto -> número, aceitando "1.234,56", "1234.56" e "1234,56".
   O separador decimal é o ÚLTIMO sinal que aparecer e tudo antes dele é milhar.
   Existe como função única de propósito: eu tinha escrito dois parsers, um para
   salvar e outro para a prévia, e dois jeitos de ler o mesmo campo é como se
   cria um valor salvo diferente do que a tela mostrou. */
function parseValor(txt) {
  const s = String(txt == null ? '' : txt).trim().replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  const ult = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (ult < 0) return parseFloat(s) || 0;
  const inteiro = s.slice(0, ult).replace(/[.,]/g, '');
  return parseFloat(inteiro + '.' + s.slice(ult + 1)) || 0;
}

const MESES = D ? D.meses.map(m => m.rot) : [];
const NF = D ? D.qual.meses_fechados : 0;
const ABERTO = i => i + 1 > NF;
/* Mês com realizado da API, ainda SEM o export do Bimer (21/10/2026: o export é a fonte; a
   API é prévia até ele chegar). Marcado no cabeçalho de toda tabela e explicado na faixa
   do topo — o número desse mês ainda pode mudar quando a Controladoria exportar. */
const PREVIA = i => !!(D && D.meses[i] && D.meses[i].fonte === 'api');
const TITULO_PREVIA = 'prévia pela API do Bimer — ainda sem o export do mês';
const rotMes = i => `${MESES[i]}${ABERTO(i) ? '*' : ''}` +
  (PREVIA(i) ? `<span class="previa" title="${TITULO_PREVIA}">prévia</span>` : '');
const soma = (a, i = 0, f = 12) => a.slice(i, f).reduce((x, y) => x + (y || 0), 0);
const natDe = {};
if (D) D.nat.forEach(n => { natDe[n.cod] = n; });

/* ═════════════ SALDOS BANCÁRIOS DIGITADOS NO PAINEL ═════════════

   Decisão do Leonardo (21/09/2026): por enquanto o valor fica SÓ no painel
   (localStorage), não na planilha. Consequência que o código trata de propósito
   em vez de esconder: um saldo digitado aqui **não chega à aba Resumo
   Tarituba**, então o Confronto da planilha continua vazio para aquele mês.

   Por isso todo valor de origem local é marcado na tela. Sem essa marca, daqui a
   dois meses ninguém distingue um saldo que está na planilha de um que só existe
   no navegador de uma pessoa — e essa divergência silenciosa é exatamente o que
   o Confronto existe para impedir.

   Quando virar escrita na planilha, só `lerLocais`/`gravarLocal` mudam.

   RUMO (Leonardo, 21/09): o plano é o painel SUBSTITUIR a planilha; por ora os
   dois convivem. Duas consequências práticas disso:
     - na convivência, a planilha é o registro e o local é adiantamento;
     - o localStorage é bom para a transição e NÃO serve como fim da linha —
       ele vive num navegador, numa máquina. Quem abrir o painel noutro
       computador vê branco. No dia em que a planilha sair, o saldo precisa de
       um lugar durável (planilha via ajudante local, ou tabela no Supabase,
       como os colchões do Controle de Pagamentos). */
/* As CONTAS são as da planilha (`D.saldos.contas`, lidas pelo rótulo das linhas
   entre "Saldo Final Disponivel" e "Total Contas"). O valor local é guardado por
   `id` da conta ({c1: 123.45, ...}). */
const CONTAS = D ? D.saldos.contas : [];
const CHAVE_SALDOS = 'fpg.saldos.' + (D ? D.meta.ano : '');
const totalContas = vals => Math.round(CONTAS.reduce((s, c) => s + ((vals || {})[c.id] || 0), 0) * 100) / 100;

function lerLocais() {
  /* localStorage pode LANÇAR (janela anônima, site data bloqueado, captura de
     thumbnail), não só devolver vazio — daí o try/catch e não um `if`. */
  try {
    return JSON.parse(localStorage.getItem(CHAVE_SALDOS) || '{}');
  } catch (e) { return {}; }
}
function gravarLocal(mes, valores) {
  const todos = lerLocais();
  if (valores === null) delete todos[mes]; else todos[mes] = valores;
  try {
    localStorage.setItem(CHAVE_SALDOS, JSON.stringify(todos));
    return true;
  } catch (e) { return false; }
}

/* Saldo de um mês, juntando planilha e local.
   A PLANILHA GANHA quando tem valor: ela é o sistema de registro, e o local é
   só um adiantamento até alguém digitar lá. Se os dois existirem e divergirem,
   isso é notícia — vira aviso na tela, não desempate silencioso. */
function saldoDoMes(i) {
  const daPlanilha = D.saldos.mensal[i];
  const local = lerLocais()[i + 1];

  if (daPlanilha.preenchido) {
    const diverge = local && CONTAS.some(c =>
      Math.abs((local[c.id] || 0) - (daPlanilha.valores[c.id] || 0)) > 0.005);
    /* `fonte: 'extrato'` (17/11/2026, como no Shiva e no Passivo): as linhas de banco vieram
       dos extratos (`do_extrato`, ids das linhas); as outras seguem digitadas. Para o local é
       igual à planilha — o que está no payload ganha. */
    return Object.assign({}, daPlanilha,
      { origem: daPlanilha.fonte === 'extrato' ? 'extrato' : 'planilha', diverge: !!diverge });
  }
  if (local) {
    return { mes: i + 1, valores: local, preenchido: true, total: totalContas(local), origem: 'local' };
  }
  return Object.assign({}, daPlanilha, { origem: null });
}

/* Meses que já viraram no calendário. Um mês só pede saldo depois de acabar —
   pedir o saldo de setembro no dia 21 de setembro não faz sentido. */
const HOJE = new Date();
function mesEncerrado(i) {
  if (!D) return false;
  if (D.meta.ano < HOJE.getFullYear()) return true;
  if (D.meta.ano > HOJE.getFullYear()) return false;
  return (i + 1) < (HOJE.getMonth() + 1);
}
function mesesPendentes() {
  return MESES.map((_, i) => i).filter(i => mesEncerrado(i) && !saldoDoMes(i).preenchido);
}

/* lançamentos por natureza — é o que a planilha NÃO tem: lá a Base é um total
   por natureza e mês, e o título que originou o número fica fora. */
const lancDe = {};
if (D && D.detalhe) D.detalhe.forEach(l => {
  (lancDe[l.cod] = lancDe[l.cod] || []).push(l);
});
// as movimentações manuais (sem data de baixa) vão para o fim do mês
Object.values(lancDe).forEach(lst => lst.sort((a, b) =>
  (a.mes - b.mes) || (a.data_baixa || '9').localeCompare(b.data_baixa || '9')));

/* itens de orçamento por natureza — pedido da chefe, 25/09: "fazer pro
   orçado a mesma coisa que fizemos pro realizado" (o clique que abre o
   detalhe). O orçamento tem grão de FORNECEDOR (`D.orc_itens`, extraído
   desde 18/09 mas nunca usado na tela até agora): 15 itens colapsam em 11
   naturezas na planilha — a mesma relação um-para-muitos que os lançamentos
   têm com a natureza, só que cada item é RECORRENTE ao longo de vários
   meses (`item.meses`, 12 posições) em vez de um evento datado único. */
const orcItensDe = {};
if (D && D.orc_itens) D.orc_itens.forEach(it => {
  (orcItensDe[it.cod] = orcItensDe[it.cod] || []).push(it);
});

const dataBr = s => !s ? '' : s.slice(8, 10) + '/' + s.slice(5, 7);

/* ── componentes ── */
function kpi(label, val, sub, delta, deltaCls) {
  return `<div class="card kpi">
    <div class="label">${label}</div><div class="val">${val}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
    ${delta ? `<div class="delta ${deltaCls || ''}">${delta}</div>` : ''}</div>`;
}
/* Saldo inicial × saldo das contas em 31/12 do ano anterior (`saldos.ano_anterior`, só a
   partir de 2027): [delta, classe] do KPI. Com o extrato de dezembro, o inicial É esse saldo
   e quem confere é o digitado na planilha. */
function kpiInicial(ini) {
  const a = D.saldos.ano_anterior;
  if (!a) return [];
  if (a.total == null) return [`sem saldo de 31/12/${a.ano} para conferir`, 'neg'];
  if (D.saldos.inicial_fonte === 'extrato') {
    const p = D.saldos.inicial_planilha;
    if (p == null) return [`extratos de 31/12/${a.ano} · planilha sem saldo inicial`, ''];
    const d = p - ini;
    return Math.abs(d) < 0.005 ? [`extratos de 31/12/${a.ano} · ✓ planilha confere`, 'pos']
      : [`extratos de 31/12/${a.ano} · planilha ${fmt.sig(d)}`, 'neg'];
  }
  const dif = ini - a.total;
  return Math.abs(dif) < 0.005 ? [`✓ confere com 31/12/${a.ano}`, 'pos']
    : [`${fmt.sig(dif)} vs 31/12/${a.ano} (${fmt.rs(a.total)})`, 'neg'];
}
function seg(id, opts, val) {
  return `<div class="seg" id="${id}">` + opts.map(o =>
    `<button type="button" data-v="${o.v}" class="${o.v === val ? 'on' : ''}">${o.t}</button>`).join('') + '</div>';
}
function bindSeg(id, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); cb(b.dataset.v);
  }));
}
/* `redondo`: célula sem centavos, com o valor exato na dica — só Receita Total e Despesa
   Total do Resumo (o resto mostra centavos). */
function cel(v, extra, aberto, titulo, attrs, redondo) {
  const c = [extra || '', aberto ? 'aberto' : ''].filter(Boolean).join(' ');
  const dica = titulo || (redondo && v != null ? fmt.n(v) : '');
  return `<td class="${c}"${dica ? ` title="${dica}"` : ''}${attrs || ''}>${
    v == null ? '·' : (redondo ? fmt.r0(v) : fmt.n(v))}</td>`;
}
const celBase = cel;      // para quem sombreia `cel` com uma versão sem centavos

/* Linha de saldo bancário, marcando a origem de cada célula.
   A marca não é enfeite: enquanto painel e planilha convivem, um número que só
   existe no navegador tem de ser distinguível de um que está no arquivo. */
function linhaSaldo(rot, campo, saldos, klass, par) {
  // Sem tom de coluna (pedido da chefe, 24/09): saldo bancário nunca tem
  // orçamento, então o par orç/real nem fazia sentido de comparação aqui — só
  // ocupava uma coluna com "·". Ela pediu para tirar a cor da tabela inteira.
  // `campo` é o id de uma conta ('c1'…) ou 'total'.
  return `<tr class="confere ${klass || ''}"><td class="l">${rot}</td>` +
    saldos.map(sd => {
      const v = campo === 'total' ? sd.total : (sd.valores || {})[campo];
      /* Saldo bancário não tem orçamento: no modo par a coluna Orçado fica
         vazia. É o `x` que a planilha escreve nessas linhas. `.ini` marca a
         primeira coluna do bloco do mês (pedido da chefe, 28/09 — separação
         entre meses), que é a vazia quando par, ou a própria célula senão. */
      const vazia = par ? '<td class="na ini">·</td>' : '';
      const iniSolo = par ? '' : 'ini';
      if (v == null) return vazia + `<td class="${iniSolo}">·</td>`;
      const local = sd.origem === 'local';
      /* saldo lido do extrato: só a LINHA que veio dele (na FPG, a reserva e Adiantamento
         Fornecedor seguem digitados); a dica diz de onde, e mostra o digitado
         na planilha quando ele é diferente (o aviso da extração diz o mesmo) */
      const doExtrato = sd.origem === 'extrato' && (sd.do_extrato || []).includes(campo);
      let titulo = local ? 'digitado no painel — ainda não está na planilha' : '';
      if (doExtrato) {
        const p = (sd.planilha || {})[campo];
        titulo = 'lido do extrato do banco' + (sd.arquivos ? ` (${sd.arquivos.join('; ')})` : '') +
          (p != null && Math.abs(p - v) > 0.005 ? ` — na planilha: ${fmt.n(p)}` : '');
      }
      return vazia + `<td class="${[iniSolo, local ? 'vlocal' : '', doExtrato ? 'vextrato' : '']
        .filter(Boolean).join(' ')}"${titulo ? ` title="${esc(titulo)}"` : ''}>${fmt.n(v)}</td>`;
    }).join('') + '</tr>';
}

/* Formulário de saldo do mês. Abre pelos botões dos avisos: mês pendente (Lançar), mês
   com saldo só no navegador (Editar) e mês divergente (Ver). */
function formSaldo(mes) {
  const atual = saldoDoMes(mes - 1);
  /* "Apagar" quando HÁ valor no navegador, e não só quando ele é o que está valendo: no
     mês divergente a planilha ganha (`origem` é 'planilha'), e era justamente ali que o
     aviso prometia "pode ser apagado" e o botão não existia. */
  const local = lerLocais()[mes];
  const totalLocal = local ? totalContas(local) : null;
  const campo = (id, rot, v) => `
    <label class="f-campo"><span>${esc(rot)}</span>
      <input type="text" inputmode="decimal" id="sld-${id}" data-conta="${id}"
             value="${v == null ? '' : fmt.n(v)}" placeholder="0,00"></label>`;
  return `<div class="card form-saldo" id="form-saldo">
    <div class="card-title"><div>
      <h2>Saldos de ${MESES_LONGO[mes - 1]}</h2>
      <div class="hint">Posição no último dia do mês. O Confronto compara este
      total com o saldo que o fluxo calculou.</div></div>
      <button type="button" class="btn-ghost" id="sld-fechar" style="margin-left:auto">Fechar</button>
    </div>
    <div class="f-linha">
      ${CONTAS.map(c => campo(c.id, c.nome.replace(/^Saldo\s+/i, ''), (atual.valores || {})[c.id])).join('')}
      <div class="f-acao">
        <button type="button" class="btn-acao" id="sld-salvar">Salvar</button>
        ${local
          ? '<button type="button" class="btn-ghost btn-perigo" id="sld-limpar">Apagar</button>' : ''}
      </div>
    </div>
    ${atual.diverge ? `<div class="hint f-diverge">Os campos mostram o que está na
      <b>planilha</b> (total ${fmt.n(atual.total)}). O painel tinha ${fmt.n(totalLocal)}:
      <b>Apagar</b> descarta o valor do painel e fica valendo o da planilha.</div>` : ''}
    <div class="f-previa" id="sld-previa"></div>
    <div class="hint" style="margin-top:10px">
      ⚠ Guardado <b>só neste navegador</b>, não na planilha — enquanto os dois
      convivem, o registro oficial continua sendo a aba <b>Resumo FPG</b> da planilha.
    </div>
  </div>`;
}

/* Saldo final ORÇADO mês a mês: encadeia o saldo inicial com a variação
   orçada, igual ao `=B5+B7-B11` da planilha. Existe nos 12 meses — o
   orçamento cobre o ano inteiro, ao contrário do realizado. Fatorado de
   `pagResumo()` em 25/09 porque o Resumo Simplificado também precisa do
   mesmo encadeamento (para o Saldo Final de cada bloco de período), e ter
   dois cálculos do mesmo saldo orçado é como ter duas fontes da verdade.

   SEM arredondar a cada passo (19/10/2026, Passivo): a planilha encadeia o valor
   cheio, e a variação orçada carrega fração de centavo (orçamento anual/12).
   Arredondando mês a mês o erro acumulava 1 centavo a partir de junho — medido
   célula a célula pelo `conferir_planilha.py`. A exibição já arredonda. */
function calcFimOrc(ini) {
  const out = []; let acc = ini;
  for (let i = 0; i < 12; i++) { acc += D.serie.orc_variacao[i]; out.push(acc); }
  return out;
}

/* ═════════════════ PÁGINA 1: RESUMO ═════════════════ */
function pagResumo(el) {
  const s = D.serie, sal = D.saldos, ini = sal.inicial;
  const varAcum = soma(s.variacao, 0, NF);
  const saldoAtual = s.saldo_fim[NF - 1];
  const orcAcum = soma(s.orc_variacao, 0, NF);
  const desvioAcum = varAcum - orcAcum;

  /* Saldos e Confronto RECALCULADOS na tela, porque um saldo digitado aqui
     entra na conta na hora — o `D.serie.confronto` que o extrator trouxe só
     conhece o que estava na planilha na hora da extração. */
  const saldos = MESES.map((_, i) => saldoDoMes(i));
  const confronto = MESES.map((_, i) =>
    (i >= NF || !saldos[i].preenchido) ? null
      : Math.round((s.saldo_fim[i] - saldos[i].total) * 100) / 100);
  /* diferença ACEITA pela Controladoria (`CONFRONTO_ACEITO` do extrator, 27/10/2026): o mês
     fecha se o Confronto for EXATAMENTE o aceito; o que passar disso é diferença nova */
  const aceito = i => (s.confronto_aceito || [])[i] || 0;
  const resto = confronto.map((v, i) => v == null ? null : Math.round((v - aceito(i)) * 100) / 100);
  const ehAceito = i => confronto[i] != null && Math.abs(aceito(i)) >= 0.005 && Math.abs(resto[i]) < 0.005;
  const nAceitos = MESES.filter((_, i) => i < NF && ehAceito(i)).length;
  const confs = resto.slice(0, NF).filter(v => v != null);
  const pior = confs.length ? confs.reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b, 0) : null;
  const confOk = pior != null && Math.abs(pior) < 0.005;
  const pendentes = mesesPendentes();
  const locais = saldos.filter(x => x.origem === 'local').length;
  /* meses com saldo SÓ neste navegador — saem de `pendentes` assim que salvos, e o aviso
     de pendentes era a única porta para o formulário: um valor digitado errado ficava
     preso, sem editar nem apagar (achado do Arthur na revisão do hub, 05/10). */
  const soLocais = saldos.map((x, i) => x.origem === 'local' ? i : -1).filter(i => i >= 0);
  const divergentes = saldos.map((x, i) => x.diverge ? i : -1).filter(i => i >= 0);

  const iniMes = MESES.map((_, i) => i > NF ? null : (i === 0 ? ini : s.saldo_fim[i - 1]));
  const fimMes = MESES.map((_, i) => i >= NF ? null : s.saldo_fim[i]);
  const fimOrc = calcFimOrc(ini);
  /* DESVIO SÓ NOS MESES FECHADOS: num mês que ainda não aconteceu o realizado é
     zero, então "realizado − orçado" devolve o orçamento inteiro invertido e a
     tela mostraria um desvio favorável enorme que não existe. */
  const desvio = MESES.map((_, i) => ABERTO(i) ? null : s.variacao[i] - s.orc_variacao[i]);

  /* ── A TABELA COMPLETA DA ABA `Resumo Tarituba` (pedido da chefe, 21/09) ──
     A versão anterior era reduzida: só Realizado, sem as sublinhas de receita e
     despesa e sem o bloco de reconciliação (Saldo Anterior / Receitas − Despesas
     / Saldo Atual). Agora reproduz as linhas da aba e as colunas Orçado ×
     Realizado de cada mês.

     O seletor tem estado PRÓPRIO (`S.medidaFluxo`): o `S.medida` das páginas de
     Receitas e Despesas controla outra tabela, e compartilhar faria mexer numa
     alterar a outra sem ninguém pedir. */
  const modo = S.medidaFluxo;              // 'ambos' | 'real' | 'orc'
  const par = modo === 'ambos';
  const recSub = linhasResumo('receitas');
  const desSub = linhasResumo('despesas');
  const foraResumo = (D.qual.fora_do_resumo || {}).receitas || [];
  const foraResumoD = (D.qual.fora_do_resumo || {}).despesas || [];

  /* `.ini` marca a PRIMEIRA coluna de cada bloco (mês, acumulado, ou o bloco
     Ano de pagBloco) — pedido da chefe, 28/09: "a separação dos meses não
     está bem definida". Antes só os blocos acumulados tinham borda (via
     `.acum`), então um mês normal emendava direto no bloco anterior sem
     marca nenhuma. Marcado explicitamente no HTML, não por `nth-child`: a
     tabela tem 3 formatos de bloco (par orç/real, coluna única, bloco Ano de
     3 colunas) e cada um teria uma paridade diferente — frágil de acertar
     por seletor, e foi exatamente esse desalinhamento que deixou os meses
     "normais" sem borda nenhuma na versão anterior. CSS em index.html. */
  const cab = MESES.map((_, i) =>
    `<th class="mescab ini ${ABERTO(i) ? 'aberto' : ''}"${par ? ' colspan="2"' : ''}>${rotMes(i)}</th>`).join('');
  // sem o tom de coluna — cabeçalho da tabela "Saldo final e confronto"
  const subcabSemCor = par
    ? MESES.map(() => '<th class="sub ini">orç</th><th class="sub">real</th>').join('')
    : '';

  /* ── CABEÇALHO COM ACUMULADO ("Jan–Fev", "Jan–Mar", ...) ──
     Só para a tabela "O fluxo, mês a mês" (pedido da chefe, 24/09). Mesma
     estrutura da aba Resumo Tarituba: um bloco acumulado depois de CADA mês a
     partir de fevereiro — não depois de janeiro, porque acumulado de janeiro
     sozinho seria repetir janeiro. */
  const cabAcumArr = [], subcabAcumArr = [];
  MESES.forEach((m, i) => {
    cabAcumArr.push(`<th class="mescab ini ${ABERTO(i) ? 'aberto' : ''}"${par ? ' colspan="2"' : ''}>${rotMes(i)}</th>`);
    subcabAcumArr.push(par ? '<th class="sub ini c-orc">orç</th><th class="sub c-real">real</th>' : '<th class="sub ini"></th>');
    if (i > 0) {
      const rotAcum = `${MESES[0]}–${m}`;
      cabAcumArr.push(`<th class="mescab acum ini ${ABERTO(i) ? 'aberto' : ''}"${par ? ' colspan="2"' : ''}>${rotAcum}</th>`);
      subcabAcumArr.push(par
        ? '<th class="sub acum ini c-orc">orç</th><th class="sub acum c-real">real</th>'
        : '<th class="sub acum ini"></th>');
    }
  });
  const cabComAcum = cabAcumArr.join('');
  const subcabComAcum = subcabAcumArr.join('');

  /* COR EM UM LUGAR SÓ: a linha `Confronto` e o `Desvio`.
     `Saídas` é negativa em todo mês por definição, então colori-la pintava a
     linha inteira de vermelho — cor que aparece sempre não informa nada, e
     gasta o canal que deveria significar "olhe aqui". O sinal já está no número. */
  const linha = (rot, orc, real, klass, opc) => {
    const o = opc || {};
    // `semCor`: suprime o tom de coluna (pedido da chefe, 24/09 — a tabela de
    // saldo final e confronto não compara orçado x realizado, ela confere
    // contra o banco, então o par de cores não tinha sentido ali).
    const corOrc = o.semCor ? '' : ' c-orc', corReal = o.semCor ? '' : ' c-real';
    // `redondo`: só os somatórios PRINCIPAIS, Receita Total e Despesa Total, ficam sem
    // centavos (pedido da chefe, confirmado pelo Leonardo em 28/10/2026)
    const cel = (v, extra, aberto) => celBase(v, extra, aberto, '', '', !!o.redondo);
    const cels = MESES.map((_, i) => {
      const aberto = o.semAberto ? false : ABERTO(i);
      let saida;
      if (par) {
        const vo = o.semOrc ? null : (orc ? orc[i] : null);
        saida = cel(vo, 'ini' + (o.semOrc ? ' na' : '') + corOrc, aberto) +
                cel(real ? real[i] : null, (o.colorir ? cls(real[i]) : '') + corReal, aberto);
      } else {
        const v = modo === 'orc' ? (o.semOrc ? null : (orc ? orc[i] : null))
                                 : (real ? real[i] : null);
        saida = cel(v, 'ini' + (o.colorir ? ' ' + cls(v) : ''), aberto);
      }
      /* ACUMULADO desde janeiro até o mês i (pedido da chefe, 24/09) — só
         quando a linha pede (`comAcum`) e só a partir do 2º mês.

         `stubAcum` é para linhas de SALDO (ponto no tempo, não fluxo): somar
         "Saldo inicial" de jan+fev não tem sentido nenhum — é um snapshot, não
         algo que se acumula. Essas linhas mostram "·" nas colunas de
         acumulado, só para preservar a mesma contagem de colunas de todas as
         outras — senão a grade da tabela desalinha.

         Para linhas normais, soma direto os arrays `orc`/`real` de 0 até i.
         Funciona até para a linha "Desvio" (que recebe `real=desvio`, com
         `null` nos meses abertos): a soma trata null como 0, então acumular
         até um mês FECHADO soma só desvios reais — dá exatamente
         "variação acumulada real − variação acumulada orçada" sem precisar de
         um caminho de cálculo à parte. */
      if (o.comAcum && i > 0) {
        if (o.stubAcum) {
          saida += par ? cel(null, 'ini acum', aberto) + cel(null, 'acum', aberto)
                       : cel(null, 'ini acum', aberto);
        } else if (par) {
          const ao = o.semOrc ? null : (orc ? soma(orc, 0, i + 1) : null);
          const ar = real ? soma(real, 0, i + 1) : null;
          saida += cel(ao, 'ini acum' + (o.semOrc ? ' na' : '') + corOrc, aberto) +
                   cel(ar, 'acum' + corReal, aberto);
        } else {
          const av = modo === 'orc' ? (o.semOrc ? null : (orc ? soma(orc, 0, i + 1) : null))
                                     : (real ? soma(real, 0, i + 1) : null);
          saida += cel(av, 'ini acum' + (o.colorir ? ' ' + cls(av) : ''), aberto);
        }
      }
      return saida;
    }).join('');
    return `<tr class="${klass || ''}"><td class="l">${rot}</td>${cels}</tr>`;
  };
  /* sublinha do Resumo: recuo pela profundidade relativa (Salários fica dentro de
     Pessoal, que fica dentro de Despesas - Casa — na aba é só a ordem) */
  const sublinha = (g, base) => linha(
    `<span class="recuo-${Math.min(g.recuo, 3)}">${esc(g.nome)}</span>`,
    g.orc, g.real, `sub1 ${base}`, { comAcum: true });

  el.innerHTML = `
  ${pendentes.length ? `
  <div class="aviso-saldo">
    <span class="ic">📌</span>
    <div><b>${pendentes.length === 1
        ? `${MESES_LONGO[pendentes[0]]} fechou e ainda não tem os saldos.`
        : `${pendentes.length} meses fecharam sem saldo: ${pendentes.map(i => MESES_LONGO[i]).join(', ')}.`}</b>
      Sem eles o Confronto não fecha esse${pendentes.length === 1 ? '' : 's'} mês${pendentes.length === 1 ? '' : 'es'}.</div>
    ${pendentes.map(i => `<button type="button" class="btn-acao btn-saldo"
        data-mes="${i + 1}">Lançar ${MESES[i]}</button>`).join('')}
  </div>` : ''}

  ${divergentes.length ? `
  <div class="aviso-saldo alerta">
    <span class="ic">⚠</span>
    <div><b>${divergentes.map(i => MESES_LONGO[i]).join(', ')}:</b> o saldo digitado
    no painel difere do que está na planilha. A planilha está sendo usada; o valor
    local ficou para trás e pode ser apagado.</div>
    ${divergentes.map(i => `<button type="button" class="btn-ghost btn-saldo"
        data-mes="${i + 1}">Ver ${MESES[i]}</button>`).join('')}
  </div>` : ''}

  ${soLocais.length ? `
  <div class="aviso-saldo info">
    <span class="ic">ⓘ</span>
    <div><b>${soLocais.map(i => MESES_LONGO[i]).join(', ')}:</b> saldo digitado só neste
    navegador — ainda não está na planilha. Confira e lance na aba Resumo da planilha.</div>
    ${soLocais.map(i => `<button type="button" class="btn-ghost btn-saldo"
        data-mes="${i + 1}">Editar ${MESES[i]}</button>`).join('')}
  </div>` : ''}

  <div id="slot-form">${S.formMes ? formSaldo(S.formMes) : ''}</div>

  <!-- Gráfico e KPIs LADO A LADO. Empilhados, os dois comiam a primeira tela
       inteira e a tabela — que é a substância — começava a 765px num laptop de
       748px de altura útil. O gráfico também não precisava de 1.300px para 12
       meses; o espaço horizontal estava sobrando enquanto o vertical faltava. -->
  <div class="topo-resumo">
  <div class="card card-grafico">
    <div class="card-title"><div><h2>Entradas, saídas e saldo</h2>
      <div class="hint">Barras à esquerda, saldo acumulado na linha à direita.</div></div></div>
    <div id="g-fluxo"></div>
  </div>
  <div class="grid-kpi">
    ${kpi('Saldo inicial do ano', fmt.rs(ini), 'posição de 1º de janeiro', ...kpiInicial(ini))}
    ${kpi('Variação acumulada', fmt.sig(varAcum),
        `jan–${MESES[NF - 1]} · orçado ${fmt.sig(orcAcum)}`,
        `${seta(desvioAcum)} ${fmt.sig(desvioAcum)} vs orçado`, cls(desvioAcum))}
    ${kpi('Saldo atual', fmt.rs(saldoAtual), `fim de ${MESES[NF - 1]}`,
        `${seta(saldoAtual - ini)} ${fmt.sig(saldoAtual - ini)} no ano`, cls(saldoAtual - ini))}
    ${kpi('Confronto com os bancos', pior == null ? '—' : (confOk ? 'fecha' : fmt.sig(pior)),
        pior == null ? 'nenhum saldo digitado'
          : (confOk ? `${confs.length} ${confs.length === 1 ? 'mês confere' : 'meses conferem'} ao centavo`
                      + (nAceitos ? ` (${nAceitos} com diferença aceita)` : '')
                    : (nAceitos ? 'maior diferença além das aceitas' : 'maior diferença do período'))
          + (locais ? ` · ${locais} do painel` : ''),
        '', confOk ? 'pos' : (pior == null ? '' : 'neg'))}
  </div>
  </div>

  <!-- DUAS TABELAS, não uma (pedido da chefe, 24/09): a versão anterior emendava
       o fluxo projetado (Saldo inicial → Variação Líquida) direto na conferência
       contra o banco (Saldo Final Disponível → Confronto) na mesma tabela, e ela
       apontou que ficava confuso — são dois cálculos diferentes que só por
       acaso levam ao mesmo número. O corte é depois de Variação Líquida: tudo
       que vem antes é o fluxo (o que entrou e saiu); tudo que vem depois é
       "quanto sobrou, e isso bate com o banco?". -->
  <div class="card">
    <div class="card-title">
      <div><h2>O fluxo, mês a mês</h2>
      <div class="hint">As mesmas linhas da aba <b>Resumo FPG</b>, com o
      acumulado desde janeiro depois de cada mês (colunas em itálico).
      Sinal de caixa: entrada <b class="pos">+</b>, saída <b class="neg">−</b>.
      <b>*</b> marca mês sem lançamento.${(() => {
        const n = ((D.manuais || {}).movimentos || []).length;
        return n ? ` Inclui <b>${n} movimentaç${n === 1 ? 'ão' : 'ões'} manua${n === 1 ? 'l' : 'is'}</b>
          (no detalhe das células, marcadas “manual”).` : '';
      })()}</div></div>
      <div style="margin-left:auto">${seg('seg-fluxo',
        [{ v: 'ambos', t: 'Orçado × realizado' }, { v: 'real', t: 'Realizado' },
         { v: 'orc', t: 'Orçado' }], modo)}</div>
    </div>
    <div class="tbl-wrap">
      <table class="data wide fluxo ${par ? 'par' : ''}">
        <thead>
          <tr><th class="l"${par ? ' rowspan="2"' : ''}>&nbsp;</th>${cabComAcum}</tr>
          ${par ? `<tr>${subcabComAcum}</tr>` : ''}
        </thead>
        <tbody>
          ${linha('Saldo inicial', iniMes, iniMes, 'saldo', { semAberto: true, comAcum: true, stubAcum: true })}
          ${linha('Receita Total', s.orc_receita, s.receita, 'total receita', { comAcum: true, redondo: true })}
          ${recSub.map(g => sublinha(g, 'receita')).join('')}
          ${linha('Despesa Total', s.orc_despesa, s.despesa, 'total despesa', { comAcum: true, redondo: true })}
          ${desSub.map(g => sublinha(g, 'despesa')).join('')}
          ${linha('Variação Líquida', s.orc_variacao, s.variacao, 'variacao', { comAcum: true })}
          ${par ? '' : linha('Desvio vs orçado', null, desvio, '', { colorir: true, semAberto: true, comAcum: true })}
        </tbody>
      </table>
    </div>
    ${foraResumo.length || foraResumoD.length ? `<div class="hint" style="margin-top:12px">
      ⚠ ${[...foraResumo, ...foraResumoD].map(c => `<b>${esc(c)} ${esc((natDe[c] || {}).nome || '')}</b>`).join(', ')}
      não ${foraResumo.length + foraResumoD.length === 1 ? 'está' : 'estão'} em nenhuma sublinha
      da aba Resumo da planilha, cujo total é a soma das sublinhas. Aqui o total soma
      todas as naturezas da aba — se ${foraResumo.length + foraResumoD.length === 1 ? 'ela tiver' : 'elas tiverem'}
      movimento, painel e planilha divergem nesse total.</div>` : ''}
  </div>

  <div class="card">
    <div class="card-title">
      <div><h2>Saldo final e confronto com os bancos</h2>
      <div class="hint">O saldo que o fluxo calculou, contra os saldos das contas — ${
        D.saldos.mensal.some(m => m.fonte === 'extrato')
          ? `as de banco (e o Fundo Fixo) lidas dos extratos em ${D.saldos.mensal
              .filter(m => m.fonte === 'extrato').map(m => MESES[m.mes - 1]).join(', ')}
              (sublinhadas; passe o mouse para ver o arquivo), as demais digitadas pela Controladoria`
          : 'digitados pela Controladoria mês a mês'}. Segue a mesma vista (${par ? 'Orçado × realizado'
        : modo === 'orc' ? 'Orçado' : 'Realizado'}) selecionada acima.</div></div>
    </div>
    <div class="tbl-wrap">
      <table class="data wide fluxo ${par ? 'par' : ''}">
        <thead>
          <tr><th class="l"${par ? ' rowspan="2"' : ''}>&nbsp;</th>${cab}</tr>
          ${par ? `<tr>${subcabSemCor}</tr>` : ''}
        </thead>
        <tbody>
          ${linha('Saldo Final Disponível', fimOrc, fimMes, 'fechofinal', { semAberto: true, semCor: true })}
        </tbody>
        <tbody>
          ${CONTAS.map(c => linhaSaldo(esc(c.nome), c.id, saldos, '', par)).join('')}
          ${linhaSaldo(esc(D.saldos.rotulo_total || 'Total das contas'), 'total', saldos, 'forte', par)}
        </tbody>
        <tbody>
          ${linha('Saldo Anterior', iniMes, iniMes, 'confere', { semAberto: true, semCor: true })}
          ${linha('Receitas − Despesas', s.orc_variacao, s.variacao, 'confere', { semCor: true })}
          ${linha('Saldo Atual', fimOrc, fimMes, 'confere forte', { semAberto: true, semCor: true })}
          <tr class="confere ${confOk ? 'ok' : 'ruim'}"><td class="l">Confronto</td>
            ${MESES.map((_, i) => {
              const v = confronto[i], ac = ehAceito(i);
              const celReal = `<td class="ind${par ? '' : ' ini'}${ac ? ' aceito' : ''}"${ac
                ? ` title="Diferença aceita: ${esc((D.confronto_aceito || []).filter(a => a.mes <= i + 1).map(a => a.motivo).join('; '))}"` : ''}>${v == null ? '·'
                : (Math.abs(v) < 0.005 ? '0,00' : fmt.sig(v))}${ac ? '<sup>†</sup>' : ''}</td>`;
              return par ? '<td class="na ini">·</td>' + celReal : celReal;
            }).join('')}</tr>
          ${linhaDre(par, modo)}
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:12px">
      O <b>Confronto</b> é o saldo calculado menos o que os bancos dizem. Zero é o
      esperado — é o controle que prova que o fluxo fecha contra a realidade (e pega
      export emitido antes de um lançamento). Saldo bancário não
      tem orçamento, por isso a coluna Orçado fica vazia nessas linhas — é o
      <code>x</code> da planilha.
      ${D.dre && D.dre.disponivel ? `<br>O <b>Confere com o DRE</b> compara o fluxo, sem os
      ${D.dre.fora.map(f => esc(f.nome).toLowerCase()).join(', ')}, com o total do
      <code>${esc(D.dre.arquivo)}</code> (“Fluxo de caixa líquido após investimentos”) — o mesmo
      check que a planilha faz. Orçado nos 12 meses; realizado só nos meses com export. Passe o
      mouse num mês para ver as naturezas que diferem.` : ''}
      ${(D.confronto_aceito || []).length ? `<br><sup>†</sup> Diferença aceita pela Controladoria
      (27/10/2026) e registrada no painel — carrega para os meses seguintes, porque o Confronto
      é saldo: ${D.confronto_aceito.map(a => `<b>${MESES[a.mes - 1]} ${fmt.sig(a.valor)}</b>, ${esc(a.motivo)}`).join('; ')}.`
        : ''}
    </div>
  </div>
  ${blocoHpg()}`;

  bindSeg('seg-fluxo', v => { S.medidaFluxo = v; render(); });
  ligarHpg(el);

  /* ── eventos do lançamento de saldo ── */
  el.querySelectorAll('.btn-saldo').forEach(b => b.addEventListener('click', () => {
    S.formMes = parseInt(b.dataset.mes, 10);
    render();
    const f = document.getElementById('form-saldo');
    if (f) { f.scrollIntoView({ block: 'center' }); f.querySelector('input').focus(); }
  }));

  const fechar = document.getElementById('sld-fechar');
  if (fechar) fechar.addEventListener('click', () => { S.formMes = null; render(); });

  const campoValor = id => parseValor((document.getElementById('sld-' + id) || {}).value);

  const salvar = document.getElementById('sld-salvar');
  if (salvar) {
    salvar.addEventListener('click', () => {
      const v = {};
      CONTAS.forEach(c => { v[c.id] = campoValor(c.id); });
      if (!gravarLocal(S.formMes, v)) {
        alert('Não consegui gravar neste navegador (armazenamento bloqueado). '
            + 'O valor não foi salvo.');
        return;
      }
      S.formMes = null; render();
    });
  }

  const limpar = document.getElementById('sld-limpar');
  if (limpar) limpar.addEventListener('click', () => {
    gravarLocal(S.formMes, null); S.formMes = null; render();
  });

  /* prévia do Confronto enquanto digita: o número só vale se fechar, então
     mostrar o resultado ANTES de salvar evita salvar errado e descobrir depois */
  const previa = document.getElementById('sld-previa');
  if (previa) {
    const calc = () => {
      const tot = CONTAS.reduce((a, c) => a + campoValor(c.id), 0);
      const calculado = s.saldo_fim[S.formMes - 1];
      const dif = Math.round((calculado - tot) * 100) / 100;
      const ac = aceito(S.formMes - 1), fecha = Math.abs(dif - ac) < 0.005;
      previa.innerHTML = `Total informado <b>${fmt.n(tot)}</b> · o fluxo calculou
        <b>${fmt.n(calculado)}</b> · Confronto
        <b class="${fecha ? 'pos' : 'neg'}">${
          !fecha ? (Math.abs(dif) < 0.005 ? '0,00' : fmt.sig(dif))
            : Math.abs(ac) < 0.005 ? 'fecha (0,00)' : `fecha (${fmt.sig(dif)}, diferença aceita)`}</b>${
          !fecha && Math.abs(ac) >= 0.005 ? ` · neste mês o aceito é <b>${fmt.sig(ac)}</b>` : ''}`;
    };
    CONTAS.forEach(c => {
      const inp = document.getElementById('sld-' + c.id);
      if (inp) inp.addEventListener('input', calc);
    });
    calc();
  }

  /* faixa do eixo do saldo: min/max dos meses com dado, com folga */
  const faixaSaldo = (() => {
    const vals = s.saldo_fim.slice(0, NF).concat([ini]);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const folga = Math.max((hi - lo) * 0.15, 1000);
    return { min: Math.floor((lo - folga) / 10000) * 10000,
             max: Math.ceil((hi + folga) / 10000) * 10000 };
  })();

  mkChart(document.getElementById('g-fluxo'), Object.assign(baseOpt(), {
    legend: { textStyle: { color: C.ink2 }, top: 2, icon: 'roundRect', itemWidth: 12, itemHeight: 12,
      data: ['Entradas', 'Saídas', 'Saldo acumulado'] },
    tooltip: {
      trigger: 'axis', backgroundColor: '#0b1f24', borderColor: C.line,
      textStyle: { color: C.ink }, axisPointer: { type: 'shadow' },
      formatter: p => {
        const i = p[0].dataIndex;
        const l = p.map(x => `${x.marker} ${x.seriesName}: <b>${fmt.n(x.value)}</b>`);
        if (ABERTO(i)) l.push('<span style="color:#6E8C90">mês sem lançamento</span>');
        return `<b>${MESES[i]}</b><br>` + l.join('<br>');
      }
    },
    xAxis: axis({ type: 'category', data: MESES }),
    yAxis: [axis({ type: 'value', axisLabel: { color: C.ink3, formatter: v => fmt.k(v) } }),
            /* EIXO DO SALDO ANCORADO NOS DADOS, não em zero (decisão do
               Tarituba: com o eixo partindo de zero a linha fica praticamente
               reta e o movimento desaparece). Folga de 15% para a linha não
               encostar nas bordas, arredondada a 10k. */
            axis({ type: 'value', position: 'right', splitLine: { show: false },
                   min: faixaSaldo.min, max: faixaSaldo.max,
                   axisLabel: { color: C.ink3, formatter: v => fmt.k(v) } })],
    series: [
      { name: 'Entradas', type: 'bar', stack: 'f', itemStyle: { color: C.teal },
        data: s.receita.map((v, i) => ({ value: v, itemStyle: { opacity: ABERTO(i) ? .32 : 1 } })) },
      { name: 'Saídas', type: 'bar', stack: 'f', itemStyle: { color: C.orange },
        data: s.despesa.map((v, i) => ({ value: v, itemStyle: { opacity: ABERTO(i) ? .32 : 1 } })) },
      { name: 'Saldo acumulado', type: 'line', yAxisIndex: 1,
        lineStyle: { color: C.ink, width: 2 }, itemStyle: { color: C.ink },
        data: s.saldo_fim.map((v, i) => i < NF ? v : null) }
    ]
  }));
}

/* ═════════════════ PÁGINA: RESUMO SIMPLIFICADO ═════════════════

   Pedido da chefe (25/09/2026): ela mandou um exemplo de outro fluxo (Family
   Office) com três blocos de coluna lado a lado — o mês atual, o acumulado do
   ano (YTD) e a projeção de como o ano deve fechar — em vez dos 12 meses
   espalhados horizontalmente como nas outras páginas. Perguntei ao Leonardo o
   nível de detalhe: ele escolheu só os TOTAIS e os subtotais de nível 1 (as
   mesmas linhas de "O fluxo, mês a mês" do Resumo — Saldo Inicial, Receita
   Total + sublinhas, Despesa Total + sublinha, Variação Líquida, Saldo
   Final), sem descer a cada natureza — isso já existe nas páginas
   Receitas/Despesas. %PL e "Variação Ex-Bônus" do exemplo ficaram de fora
   por ora (não confirmados para o Tarituba).

   TRÊS BLOCOS DE COLUNA:
   - Mês:  o mês escolhido (Orçado, Realizado, Δ em R$ k)
   - YTD:  acumulado de janeiro até o mês escolhido (mesmas 3 colunas)
   - Ano:  Orçado do ano inteiro × "Real + Orç" — realizado até o mês
     escolhido somado ao orçado do que falta, ou seja, uma projeção de
     fechamento do ano com o que já é fato — + Δ (real+orç − orçado do ano),
     pedido do Leonardo em 28/09 (a versão de 25/09 não tinha Δ aqui: o
     raciocínio de que "seria um desvio que muda de natureza mês a mês" foi
     revisto — ele quis o mesmo par de colunas nos três blocos).

   MÊS DE COMPARAÇÃO com seletor (pedido do Leonardo, 25/09): abre no último
   mês fechado, mas dá pra rever qualquer mês fechado anterior — só fechados
   entram na lista, um mês aberto não tem realizado pra comparar.

   DESTRINCHAR POR LINHA (pedido do Leonardo, 25/09, depois de comparar com
   um botão global "mostrar tudo"): cada linha de grupo (nível 1+) tem uma
   seta clicável que revela só os FILHOS DIRETOS dela, um nível de cada vez —
   dá pra abrir só "Suporte Tarituba" sem destrinchar a Receita junto, coisa
   que um botão único não permitia. Nível 1 (Receita Adm/Financeira, Demais
   Receitas, Despesas Tarituba) sempre aparece, como já era antes desta
   rodada; a seta nele é o que revela nível 2 em diante.

   Linhas de FLUXO (Receita/Despesa/Variação) reaproveitam os mesmos arrays
   `s.receita`/`s.orc_receita`/etc. da página Resumo; linhas de SALDO (ponto no
   tempo, não soma) tratam Mês e YTD como o MESMO instante — dá o mesmo par de
   valores nas duas, igual ao exemplo da chefe (o saldo de agora não muda
   conforme a "lente" de leitura, só a Receita/Despesa mudam). */
function pagSimplificado(el) {
  const s = D.serie, ini = D.saldos.inicial;
  if (NF < 1) {
    el.innerHTML = `<div class="card"><div class="hint">Nenhum mês fechado
      ainda neste ano — o Resumo Simplificado precisa de pelo menos um mês
      com realizado para comparar.</div></div>`;
    return;
  }
  // padrão: o último mês FECHADO PELO EXPORT (é o do card); sem export nenhum, o último com dado
  const ultExport = D.meses.reduce((u, m, i) => (m.fonte === 'export' ? i + 1 : u), 0);
  const mes = Math.min(Math.max(S.mesSimples || ultExport || NF, 1), NF);
  const fimOrc = calcFimOrc(ini);

  /* Δ em R$ K (pedido da chefe, formato do exemplo; rótulo virou "Δ k" em
     28/09, mesmo valor de antes — só o texto do cabeçalho mudou) —
     arredondado, sem casas decimais. É a ÚNICA célula desta tabela em
     milhares; as de Orçado/Realizado continuam em reais cheios, como o
     resto do painel. */
  const celK = v => `<td class="${cls(v)}">${v == null ? '·' : Math.round(v / 1000).toLocaleString('pt-BR')}</td>`;
  const celTraco = () => '<td class="na">·</td>';

  /* linha de FLUXO: soma de intervalo em cada bloco. `rotulo` pode ser texto
     puro ou já vir com a seta de expandir embutida (ver `rotuloGrupo`).
     `opcLabel` é opcional: {classeExtra, attrs} pro `<td class="l">` — nunca
     um `class=` pronto, senão o `<td>` acaba com DOIS atributos `class`
     (o HTML só honra o primeiro e descarta o segundo em silêncio — foi
     assim que a classe `expandivel` não aparecia na 1ª versão).

     O bloco Ano ganhou Δ em 28/09 (pedido do Leonardo) — antes só Mês e YTD
     tinham; os três blocos agora têm o mesmo par orç/real/Δ. */
  const linhaFluxo = (rotulo, orc, real, klass, opcLabel) => {
    const ol = opcLabel || {};
    const mesO = orc[mes - 1], mesR = real[mes - 1];
    const ytdO = soma(orc, 0, mes), ytdR = soma(real, 0, mes);
    const anoO = soma(orc, 0, 12), anoRO = soma(real, 0, mes) + soma(orc, mes, 12);
    return `<tr class="${klass}"><td class="l${ol.classeExtra ? ' ' + ol.classeExtra : ''}"${ol.attrs || ''}>${rotulo}</td>
      ${cel(mesO, 'ini c-orc')}${cel(mesR, 'c-real')}${celK(mesR - mesO)}
      ${cel(ytdO, 'ini c-orc')}${cel(ytdR, 'c-real')}${celK(ytdR - ytdO)}
      ${cel(anoO, 'ini c-orc')}${cel(anoRO, 'c-real')}${celK(anoRO - anoO)}</tr>`;
  };

  /* Rótulo de um grupo, com a seta ▸/▾ de expandir e o `data-chave` que o
     clique delegado lê pra saber qual nó abrir/fechar. Todo nó `grupo` tem
     filhos (só `natureza` é folha), então todo grupo ganha seta. */
  const rotuloGrupo = (nome, aberto) =>
    `<span class="seta-arv">${aberto ? '▾' : '▸'}</span>${nome}`;
  const opcGrupo = (chave, aberto) => ({
    classeExtra: 'expandivel',
    attrs: ` data-chave="${chave}" tabindex="0" role="button" aria-expanded="${aberto}"`
  });

  /* Sublinhas de Receita/Despesa: nível 1 sempre aparece (as mesmas duas —
     Receita Adm/Financeira, Demais Receitas — que já existem em "O fluxo,
     mês a mês" do Resumo). Nível 2 em diante só aparece quando a linha-pai
     foi clicada (`S.simplesAbertos`) — sem isso a página vira um espelho de
     Receitas/Despesas e perde a razão de existir, que é o resumo compacto.

     Nível 1 mantém a cor de receita/despesa (verde/salmão claro, `sub1`) —
     é a MESMA linha aberta ou fechada, então não pode mudar de cor ao
     destrinchar. Nível 2+ usa a classe neutra `grp n1/n2/n3` que a página de
     Receitas/Despesas já usa para o mesmo propósito (indentação por
     profundidade, sem depender de matiz); a natureza-folha usa `nat`, mais
     recuada e mais escura — as três classes já têm CSS pronto, escrito para
     `table.data.nat`, mas os seletores de fundo/recuo não são
     table-específicos, então funcionam aqui de graça. */
  const linhasArvore = (aba, klassBase) => {
    const lista = D.estrutura[aba] || [];
    const out = [];
    const andar = (idxPai, nivelPai) => {
      for (let j = idxPai + 1; j < lista.length; j++) {
        if (lista[j].nivel <= nivelPai) break;
        if (lista[j].nivel !== nivelPai + 1) continue; // só filho DIRETO
        const no = lista[j];
        if (no.tipo === 'grupo') {
          const chave = `${aba}:${j}`;
          const aberto = S.simplesAbertos.has(chave);
          const o = somaGrupo(lista, j, 'orc'), r = somaGrupo(lista, j, 'real');
          const klass = no.nivel === 1 ? `sub1 ${klassBase}` : `grp n${Math.min(no.nivel - 1, 3)}`;
          out.push(linhaFluxo(rotuloGrupo(no.nome, aberto), o, r, klass, opcGrupo(chave, aberto)));
          if (aberto) andar(j, no.nivel);
        } else {
          const n = natDe[no.cod];
          if (n) out.push(linhaFluxo(n.nome, n.orc, n.real, 'nat'));
        }
      }
    };
    andar(0, 0); // índice 0 é sempre a raiz (nível 0) de cada aba
    return out.join('');
  };

  /* Saldo Inicial: no bloco Mês é o saldo no começo do mês ESCOLHIDO (fim do
     mês anterior); no bloco YTD/Ano é o saldo em 1º de janeiro — mesmo fato
     conhecido nos dois lados, por isso Orçado === Realizado ali (não é bug,
     é o único saldo que os dois cenários compartilham de verdade). */
  const linhaSaldoIni = () => {
    const mesO = mes === 1 ? ini : fimOrc[mes - 2];
    const mesR = mes === 1 ? ini : s.saldo_fim[mes - 2];
    return `<tr class="saldo"><td class="l">Saldo Inicial</td>
      ${cel(mesO, 'ini c-orc')}${cel(mesR, 'c-real')}${celTraco()}
      ${cel(ini, 'ini c-orc')}${cel(ini, 'c-real')}${celTraco()}
      ${cel(ini, 'ini c-orc')}${cel(ini, 'c-real')}${celTraco()}</tr>`;
  };
  /* Saldo Final: Mês e YTD descrevem o MESMO instante (fim do mês escolhido),
     por isso saem idênticos — igual ao exemplo da chefe. O bloco Ano projeta
     o fechamento: realizado até o mês escolhido + orçado do que falta. */
  const linhaSaldoFim = () => {
    const O = fimOrc[mes - 1], R = s.saldo_fim[mes - 1];
    const anoRO = R + soma(s.orc_variacao, mes, 12);
    return `<tr class="fechofinal"><td class="l">Saldo Final</td>
      ${cel(O, 'ini c-orc')}${cel(R, 'c-real')}${celTraco()}
      ${cel(O, 'ini c-orc')}${cel(R, 'c-real')}${celTraco()}
      ${cel(fimOrc[11], 'ini c-orc')}${cel(anoRO, 'c-real')}${celTraco()}</tr>`;
  };

  const nomeMes = MESES[mes - 1];
  const opcoesMes = MESES.slice(0, NF).map((m, i) =>
    `<option value="${i + 1}"${i + 1 === mes ? ' selected' : ''}>${m}${PREVIA(i) ? ' (prévia)' : ''}</option>`).join('');

  el.innerHTML = `
  <div class="card">
    <div class="card-title">
      <div><h2>Resumo Simplificado</h2>
      <div class="hint">Totais e subtotais de nível 1 — clique numa linha
      com <span class="seta-arv">▸</span> para destrinchar as naturezas dela.
      Sinal de caixa: entrada <b class="pos">+</b>, saída <b class="neg">−</b>.</div></div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
        <label class="label" for="sel-mes-simples" style="margin:0">Mês de comparação</label>
        <select id="sel-mes-simples">${opcoesMes}</select>
        ${HUB && HUB.ligarCard ? `<button type="button" class="btn-ghost" id="btn-card-trello"
          title="Cria no Trello o card do mês selecionado, com o PDF desta tabela">
          Criar card no Trello</button>` : ''}
      </div>
    </div>
    ${HUB && HUB.ligarCard ? '<div class="sub" id="card-status" style="margin:-4px 0 10px;text-align:right"></div>' : ''}
    <div class="tbl-wrap">
      <table class="data wide fluxo par">
        <thead>
          <tr><th class="l" rowspan="2">&nbsp;</th>
            <th class="mescab ini" colspan="3">${nomeMes}</th>
            <th class="mescab ini" colspan="3">YTD (jan–${nomeMes})</th>
            <th class="mescab ini" colspan="3">Ano ${D.meta.ano} (projeção)</th>
          </tr>
          <tr>
            <th class="sub ini c-orc">orç</th><th class="sub c-real">real</th><th class="sub">Δ k</th>
            <th class="sub ini c-orc">orç</th><th class="sub c-real">real</th><th class="sub">Δ k</th>
            <th class="sub ini c-orc">orç</th><th class="sub c-real">real+orç</th><th class="sub">Δ k</th>
          </tr>
        </thead>
        <tbody>
          ${linhaSaldoIni()}
          ${linhaFluxo('Receita Total', s.orc_receita, s.receita, 'total receita')}
          ${linhasArvore('receitas', 'receita')}
          ${linhaFluxo('Despesa Total', s.orc_despesa, s.despesa, 'total despesa')}
          ${linhasArvore('despesas', 'despesa')}
          ${linhaFluxo('Variação Líquida', s.orc_variacao, s.variacao, 'variacao')}
          ${linhaSaldoFim()}
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:12px">
      <b>YTD</b> soma janeiro até ${nomeMes}. <b>Ano (projeção)</b> soma o que
      já é realizado até ${nomeMes} com o orçado dos meses restantes — é uma
      estimativa de fechamento, não o orçado original do ano inteiro (esse é
      a coluna Orçado ao lado dela). Saldo Inicial/Final não têm Δ porque são
      um ponto no tempo, não uma soma do período.
    </div>
  </div>`;

  const selMes = document.getElementById('sel-mes-simples');
  if (selMes) selMes.addEventListener('change', () => {
    S.mesSimples = parseInt(selMes.value, 10); render();
  });

  /* Botão do Trello (30/09): só existe dentro do Hub, que fornece FPG_HUB
     (tt_fonte.js de lá) — este mesmo arquivo roda solto por file://, onde não há
     sessão para autorizar o pedido. O mês vai como FUNÇÃO porque é lido na hora
     do clique: o card é do mês que está na tela naquele momento. O PDF é gerado
     no Azure a partir do painel PUBLICADO — os mesmos números desta tabela. */
  const btnCard = document.getElementById('btn-card-trello');
  /* `ligarCard` só existe no Hub: a ponte local (fpg_local.js) tem o cadastro, não o card */
  if (btnCard && HUB && HUB.ligarCard) {
    HUB.ligarCard(btnCard, document.getElementById('card-status'), () => mes);
  }

  /* clique por LINHA pra destrinchar (pedido do Leonardo, 25/09) — delegado
     na tabela, igual ao padrão já usado em Receitas/Despesas para o clique
     por célula: a tabela inteira re-renderiza a cada abrir/fechar de
     qualquer forma, então um listener por linha não ganha nada. */
  const tabelaSimples = el.querySelector('table.data.fluxo');
  if (tabelaSimples) {
    const alternar = td => {
      const chave = td.dataset.chave;
      if (S.simplesAbertos.has(chave)) S.simplesAbertos.delete(chave);
      else S.simplesAbertos.add(chave);
      render();
    };
    tabelaSimples.addEventListener('click', e => {
      const td = e.target.closest('td.expandivel');
      if (td) alternar(td);
    });
    tabelaSimples.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const td = e.target.closest('td.expandivel');
      if (td) { e.preventDefault(); alternar(td); }
    });
  }
}

/* ═════════════════ PÁGINAS 2 e 3: RECEITAS / DESPESAS ═════════════════ */

/* Legenda "X de mês" / "X de mês a mês" / "X do ano" — a mesma frase serve
   pros dois detalhes (lançamentos e itens de orçamento), só troca o
   substantivo. Frase INTEIRA condicional, não só o trecho depois de "de":
   "Lançamentos de o ano" saiu errado numa versão anterior porque tentava
   encaixar "o ano" no molde "X de MÊS", que só funciona pra nome de mês. */
function legendaFaixa(substantivo, ini, fim) {
  return ini === fim ? `${substantivo} de ${MESES_LONGO[ini - 1]}`
    : (ini === 1 && fim === 12) ? `${substantivo} do ano`
    : `${substantivo} de ${MESES_LONGO[ini - 1]} a ${MESES_LONGO[fim - 1]}`;
}

/* Linha de natureza + a linha escondida com o detalhe da faixa aberta —
   lançamentos (Realizado) OU itens de orçamento (Orçado), conforme
   `rangeAberto.tipo`.

   MUDOU em 24/09 (pedido da chefe): antes clicava-se na LINHA inteira e o
   detalhe sempre trazia o ANO TODO daquela natureza. Agora o clique é por
   CÉLULA — mês, acumulado ou o total Ano, cada uma vinda de
   `celulas()`/`celFaixa()` — e cada uma abre só o recorte que representa.
   `S.aberta.get(cod)` guarda QUAL recorte está aberto (`{ini,fim,tipo}`,
   meses 1-12); a linha em si não é mais clicável, só informa a contagem.

   MUDOU de novo em 25/09 (pedido da chefe: "fazer pro orçado a mesma coisa
   que fizemos pro realizado") — o Orçado ganhou o mesmo clique, usando
   `orcItensDe` (itens do orçamento, com fornecedor) em vez de `lancDe`
   (lançamentos da API). Só uma natureza-detalhe fica aberta por vez; `tipo`
   decide qual das duas listas desenhar. */
function linhaNatureza(cod, n, morta, marca, celulas, tO, tR, nCols) {
  const lancsAno = lancDe[cod] || [];
  const itensOrcAno = orcItensDe[cod] || [];
  const podeAnoReal = lancsAno.length > 0;
  const rangeAberto = S.aberta.get(cod);   // {ini,fim,tipo} (1-12) ou undefined

  const celAno = (valor, tipo, itensAno, corCls) => {
    const podeAno = itensAno.length > 0;
    const ativa = podeAno && rangeAberto && rangeAberto.tipo === tipo
      && rangeAberto.ini === 1 && rangeAberto.fim === 12;
    const attrs = podeAno
      ? ` data-cod="${cod}" data-ini="1" data-fim="12" data-tipo="${tipo}" tabindex="0" role="button"` : '';
    const nomeItem = tipo === 'orc'
      ? (itensAno.length === 1 ? 'item de orçamento' : 'itens de orçamento')
      : (itensAno.length === 1 ? 'lançamento' : 'lançamentos');
    const titulo = podeAno ? `${itensAno.length} ${nomeItem} no ano — clique para abrir` : '';
    const classes = ['tot', corCls, podeAno ? 'clic' : '', ativa ? 'cel-aberta' : '']
      .filter(Boolean).join(' ');
    return cel(valor, classes, false, titulo, attrs);
  };

  /* O rótulo é o da PLANILHA (decisão de 19/10: as linhas continuam como estão);
     o nome do Bimer vai na dica quando difere — é por ele que se acha o lançamento lá. */
  const dica = n.nome_bimer && n.nome_bimer.toUpperCase() !== (n.nome || '').toUpperCase()
    ? ` title="No Bimer: ${esc(n.nome_bimer)}"` : '';
  const principal = `<tr class="nat ${morta ? 'morta' : ''} ${rangeAberto ? 'open' : ''}" data-cod="${esc(cod)}">
    <td class="l"><span class="nome"${dica}>${cod} ${esc(n.nome)}</span>${marca}
      ${podeAnoReal ? `<span class="cont">${lancsAno.length}</span>` : ''}</td>
    ${celulas(n.orc, n.real, cod)}
    ${celAno(tO, 'orc', itensOrcAno, 'ini c-orc')}${celAno(tR, 'real', lancsAno, 'c-real')}
    ${cel(tR - tO, 'tot ' + cls(tR - tO))}</tr>`;

  if (!rangeAberto) return principal;

  /* GRID, não <table> aninhada (24/09) — table-layout:fixed dentro de uma
     célula colspan de tabela table-layout:auto tem um bug REAL do Chrome:
     medido em isolamento antes de decidir (não só no código daqui), mesmo com
     colgroup e largura inline nos <col>, as colunas "fixas" cresciam
     proporcionalmente juntas e a coluna flexível (observação) ficava quase
     sem espaço — o oposto do pedido. display:grid não passa pelo algoritmo de
     tabela, então não tem esse problema: a coluna com `1fr` realmente absorve
     tudo o que sobra. Por isso as linhas do detalhe são <div>, não <tr>/<td>
     — CSS correspondente em `.lanc*` no index.html.

     CUIDADO ao comentar HTML dentro deste template string: uma crase (`)
     dentro de um comentário <!-- --> FECHA a string JS antes da hora — foi
     assim que uma versão anterior desta função quebrou a página inteira sem
     erro nenhum no console (Chrome só reportava "Script error." genérico). */
  if (rangeAberto.tipo === 'orc') {
    const itens = itensOrcAno.filter(it => soma(it.meses, rangeAberto.ini - 1, rangeAberto.fim) !== 0);
    const legenda = legendaFaixa('Itens do orçamento', rangeAberto.ini, rangeAberto.fim);
    const linhas = itens.map(it => {
      const v = soma(it.meses, rangeAberto.ini - 1, rangeAberto.fim);
      return `
    <div class="lanc-linha">
      <div class="d-tit" title="${(it.descricao || '').replace(/"/g, '&quot;')}">${it.descricao || '—'}</div>
      <div class="d-forn" title="${(it.contraparte || '').replace(/"/g, '&quot;')}">${it.contraparte || '<i>sem contraparte</i>'}</div>
      <div class="d-parc">${it.parcelas}x</div>
      <div class="d-val">${fmt.n(v)}</div>
    </div>`;
    }).join('');
    const total = itens.reduce((s, it) => s + soma(it.meses, rangeAberto.ini - 1, rangeAberto.fim), 0);
    return principal + `<tr class="detalhe"><td colspan="${nCols || 16}">
    <div class="lanc orc">
      <div class="lanc-legenda">${legenda}</div>
      <div class="lanc-cab"><div>descrição</div><div>contraparte</div>
        <div class="d-parc">parcelas</div><div class="d-val">valor</div></div>
      ${linhas || '<div class="lanc-vazio">nenhum item de orçamento neste período</div>'}
      <div class="lanc-rodape"><div>${itens.length} item${itens.length === 1 ? '' : 'ns'} de orçamento</div>
        <div class="d-val">${fmt.n(total)}</div></div>
    </div></td></tr>`;
  }

  const lancs = lancsAno.filter(l => l.mes >= rangeAberto.ini && l.mes <= rangeAberto.fim);
  const legenda = legendaFaixa('Lançamentos', rangeAberto.ini, rangeAberto.fim);

  const linhas = lancs.map(l => `
    <div class="lanc-linha">
      ${/* movimentação manual (o papel da aba Base): sem baixa, marcada */
        l.fonte === 'manual'
          ? `<div class="d-data"><span class="chip-manual" title="Movimentação manual de ${MESES_LONGO[l.mes - 1]} — Movimentações manuais">manual</span></div>`
        /* baixa corrigida no extrator (data errada no Bimer, sem conserto lá) */
        : l.data_baixa_bimer
          ? `<div class="d-data" title="Data corrigida: no Bimer a baixa está em ${dataBr(l.data_baixa_bimer)}/${l.data_baixa_bimer.slice(0, 4)}">${dataBr(l.data_baixa)}*</div>`
          : `<div class="d-data">${dataBr(l.data_baixa)}</div>`}
      <div class="d-tit" title="${(l.titulo || '').replace(/"/g, '&quot;')}">${l.titulo || ''}</div>
      <div class="d-forn" title="${(l.fornecedor || '').replace(/"/g, '&quot;')}">${l.fornecedor || '<i>sem contraparte</i>'}</div>
      <div class="d-obs" title="${(l.observacao || '').replace(/"/g, '&quot;')}">${
        /* de-para: lançamento de outra natureza do Bimer somado nesta linha */
        l.cod_bimer && l.cod_bimer !== l.cod
          ? `<span class="via" title="Natureza ${esc(l.cod_bimer)} no Bimer, somada nesta linha como na planilha">via ${esc(l.cod_bimer)}</span> ` : ''}${esc(l.observacao || '')}</div>
      <div class="d-val">${fmt.n(l.valor)}</div>
    </div>`).join('');

  return principal + `<tr class="detalhe"><td colspan="${nCols || 16}">
    <div class="lanc">
      <div class="lanc-legenda">${legenda}</div>
      <div class="lanc-cab"><div>baixa</div><div>título</div><div>contraparte</div>
        <div>observação</div><div class="d-val">valor</div></div>
      ${linhas || '<div class="lanc-vazio">nenhum lançamento neste período</div>'}
      <div class="lanc-rodape"><div>${lancs.length} lançamento${lancs.length === 1 ? '' : 's'}</div>
        <div class="d-val">${fmt.n(lancs.reduce((s, l) => s + l.valor, 0))}</div></div>
    </div></td></tr>`;
}

/* Sublinhas do Resumo de uma aba — as linhas que a aba `Resumo FPG` puxa
   abaixo de Receita Total e Despesa Total (`='Receitas FPG'!E5` …).

   A aba escolhe à mão (naturezas e grupos de níveis diferentes, fora da ordem da
   aba), então a lista vem pronta em `D.resumo[aba]` — da planilha ou do cadastro.
   Cada linha é uma natureza (`ref.cod`) ou um grupo (`ref.grupo`), este com
   `ref.exceto` opcional (veio do Shiva, onde `Despesas Administrativas` tira os
   Dividendos a Pagar, que o Resumo mostra numa linha própria; a FPG não usa).

   Tudo sai do CONJUNTO de naturezas da linha. Os valores são a soma delas, e
   `recuo` = quantas OUTRAS linhas contêm esse conjunto com folga (no Shiva,
   Administrativas menos dividendos ficava dentro de Despesas - Shiva → 1, e os
   Dividendos a Pagar, fora de todas → 0). Na FPG as sublinhas não se contêm:
   todas com recuo 0. Referência que não acha nada devolve zeros em vez de sumir: linha
   faltando no Resumo é pior que linha zerada, e o extrator já valida. */
function linhasResumo(aba) {
  const lista = (D.estrutura && D.estrutura[aba]) || [];
  const codsDe = ref => {
    if (ref.cod) return lista.some(n => n.tipo === 'natureza' && n.cod === ref.cod) ? [ref.cod] : [];
    const i = lista.findIndex(n => n.tipo === 'grupo' && n.nome === ref.grupo);
    if (i < 0) return [];
    const fora = new Set(ref.exceto || []), cods = [];
    for (let j = i + 1; j < lista.length && lista[j].nivel > lista[i].nivel; j++)
      if (lista[j].tipo === 'natureza' && !fora.has(lista[j].cod)) cods.push(lista[j].cod);
    return cods;
  };
  // SEM arredondar a soma (ver `somaGrupo`): só a exibição arredonda
  const soma = (cods, campo) => {
    const out = new Array(12).fill(0);
    cods.forEach(c => { const n = natDe[c]; if (n) for (let m = 0; m < 12; m++) out[m] += n[campo][m]; });
    return out;
  };
  const out = (D.resumo && D.resumo[aba] || []).map(ln => {
    const cods = codsDe(ln.ref || {});
    return { nome: ln.rotulo, cods: new Set(cods), orc: soma(cods, 'orc'), real: soma(cods, 'real') };
  });
  const contem = (a, b) => a.cods.size > b.cods.size && [...b.cods].every(c => a.cods.has(c));
  out.forEach(g => {
    g.recuo = g.cods.size ? out.filter(o => o !== g && contem(o, g)).length : 0;
  });
  return out;
}

/* soma dos filhos de um nó da estrutura, descendo a árvore */
function somaGrupo(lista, i, campo) {
  const nivel = lista[i].nivel;
  const out = new Array(12).fill(0);
  for (let j = i + 1; j < lista.length; j++) {
    if (lista[j].nivel <= nivel) break;
    if (lista[j].tipo !== 'natureza') continue;
    const n = natDe[lista[j].cod];
    if (!n) continue;
    for (let m = 0; m < 12; m++) out[m] += n[campo][m];
  }
  // SEM arredondar aqui (achado em 24/09, mesma classe do bug já corrigido no
  // Resumo em 21/09): arredondar CADA MÊS a centavos antes de somar oYtd/oAno
  // compunha o erro de arredondamento mês a mês — o orçamento é anual/12, e
  // 8 meses de um valor com fração de centavo, arredondados um a um, somavam
  // 2 centavos a mais que a soma dos valores CHEIOS arredondada uma vez só —
  // e é esta que a própria planilha guarda na célula do acumulado.
  // `fmt.n()` já arredonda para exibição em cada célula; não precisa fazer
  // isso aqui, e fazer aqui é o que causava o erro.
  return out;
}

function pagBloco(el, aba) {
  const lista = D.estrutura[aba] || [];
  const ehReceita = aba === 'receitas';

  /* naturezas do plano que não têm linha em nenhuma aba da planilha */
  const orfas = D.nat.filter(n => !n.na_planilha && n.bloco === (ehReceita ? 'receita' : 'despesa'));


  /* MESES MOSTRADOS: os 12, sempre — mudou em 24/09 (Leonardo perguntou por
     que dezembro sumia em Receitas). Até então, no modo Realizado, set–dez
     ficavam ocultos ("são 4 colunas de 0,00, custam 280px, escondê-las é o
     que faz a tabela caber sem rolar"). Essa justificativa morreu quando as
     colunas de acumulado entraram (21/09): a tabela já rola de qualquer jeito
     desde então, com 8 meses ou com 12 — esconder mês deixou de evitar
     rolagem, só tirava dezembro da tela sem nenhum ganho em troca. */
  const iMeses = MESES.map((_, i) => i);
  const nColunas = S.medida === 'ambos' ? 2 : 1;
  /* nº de blocos de mês exibidos = iMeses.length + 1 acumulado depois de cada
     mês visível que não seja o primeiro (pedido da chefe, 24/09 — mesma regra
     da tabela do Resumo: acumulado de um mês só repetiria o próprio mês). */
  const nBlocosAcum = iMeses.filter((_, k) => k > 0).length;
  const nCols = 1 + (iMeses.length + nBlocosAcum) * nColunas + 3;

  /* colsMes/subMes intercalam MÊS e ACUMULADO-DESDE-O-PRIMEIRO-MÊS-VISÍVEL —
     mesma estrutura da tabela "O fluxo, mês a mês" do Resumo. O acumulado usa
     o primeiro mês da série MOSTRADA como início (não necessariamente
     janeiro: em modo Realizado com o ano começando depois de fechar um mês
     intermediário isso não aconteceria aqui, mas mantém a regra idêntica —
     "iMeses[0]" é janeiro em todo modo hoje, já que nenhum filtra o começo). */
  /* `.ini` marca a PRIMEIRA coluna de cada bloco (mês, acumulado ou o bloco
     Ano) — pedido da chefe, 28/09: "a separação dos meses não está bem
     definida". Ver o mesmo comentário em `pagResumo()`; CSS em index.html. */
  const colsMesArr = [], subMesArr = [];
  iMeses.forEach((i, k) => {
    colsMesArr.push(`<th class="grupo ini ${ABERTO(i) ? 'aberto' : ''}" colspan="${nColunas}">${rotMes(i)}</th>`);
    subMesArr.push(S.medida === 'ambos'
      ? '<th class="sub ini c-orc">orç</th><th class="sub c-real">real</th>' : '<th class="sub ini"></th>');
    if (k > 0) {
      const rotAcum = `${MESES[iMeses[0]]}–${MESES[i]}`;
      colsMesArr.push(`<th class="grupo acum ini ${ABERTO(i) ? 'aberto' : ''}" colspan="${nColunas}">${rotAcum}</th>`);
      subMesArr.push(S.medida === 'ambos'
        ? '<th class="sub acum ini c-orc">orç</th><th class="sub acum c-real">real</th>' : '<th class="sub acum ini"></th>');
    }
  });
  const colsMes = colsMesArr.join('');
  /* a 2ª linha do cabeçalho precisa ocupar TODAS as colunas de mês mesmo sem
     sub-coluna: sem os `th` vazios, os rótulos do bloco Ano escorregam para
     debaixo de jan/fev/mar — o screenshot mostrou, a contagem de células não. */
  const subMes = subMesArr.join('');

  /* Célula de uma FAIXA de meses [ini..fim] (0-indexados, os dois inclusive).
     `cod`, quando passado, torna a célula CLICÁVEL — abre o detalhe filtrado
     por aquela faixa (pedido da chefe, 24/09: antes o clique era na linha
     inteira e sempre mostrava o ano todo; agora é por célula — mês,
     acumulado, ou o total Ano — cada uma com seu recorte). Só marca clicável
     quando HÁ item na faixa: célula sem dado não abre nada vazio.

     Virou clicável tanto no Realizado QUANTO no Orçado em 25/09 (pedido da
     chefe: "fazer pro orçado a mesma coisa que fizemos pro realizado") — as
     duas usam a mesma `montarCel`, só trocando a fonte dos itens
     (`lancDe`/lançamentos × `orcItensDe`/itens de orçamento) e o `tipo`
     gravado em `S.aberta`, que é o que `linhaNatureza` usa pra saber qual
     detalhe desenhar. */
  const celFaixa = (orc, real, ini, fim, aberto, ehAcum, cod) => {
    const vo = orc ? soma(orc, ini, fim + 1) : null;
    const vr = real ? soma(real, ini, fim + 1) : null;
    const acumCls = ehAcum ? 'acum' : '';

    const montarCel = (valor, tipo, itensFaixa, corCls) => {
      const clicavel = cod && itensFaixa.length > 0;
      const range = clicavel ? S.aberta.get(cod) : null;
      const ativa = clicavel && range && range.tipo === tipo
        && range.ini === ini + 1 && range.fim === fim + 1;
      const attrs = clicavel
        ? ` data-cod="${cod}" data-ini="${ini + 1}" data-fim="${fim + 1}" data-tipo="${tipo}" tabindex="0" role="button"`
        : '';
      const nomeItem = tipo === 'orc'
        ? (itensFaixa.length === 1 ? 'item de orçamento' : 'itens de orçamento')
        : (itensFaixa.length === 1 ? 'lançamento' : 'lançamentos');
      const titulo = clicavel ? `${itensFaixa.length} ${nomeItem} — clique para abrir` : '';
      const classes = [corCls, acumCls, clicavel ? 'clic' : '', ativa ? 'cel-aberta' : '']
        .filter(Boolean).join(' ');
      return cel(valor, classes, aberto, titulo, attrs);
    };

    const lancsFaixa = cod ? (lancDe[cod] || []).filter(l => l.mes >= ini + 1 && l.mes <= fim + 1) : [];
    const itensOrcFaixa = cod
      ? (orcItensDe[cod] || []).filter(it => soma(it.meses, ini, fim + 1) !== 0) : [];

    if (S.medida === 'ambos') {
      return montarCel(vo, 'orc', itensOrcFaixa, 'ini c-orc') + montarCel(vr, 'real', lancsFaixa, 'c-real');
    }
    if (S.medida === 'orc') return montarCel(vo, 'orc', itensOrcFaixa, 'ini');
    return montarCel(vr, 'real', lancsFaixa, 'ini');
  };

  /* `cod` opcional: passado pelas linhas de NATUREZA (torna o Realizado
     clicável); omitido pelas linhas de GRUPO, que somam várias naturezas —
     não há UMA natureza para filtrar, então ficam só informativas. */
  const celulas = (orc, real, cod) => {
    const partes = [];
    iMeses.forEach((i, k) => {
      partes.push(celFaixa(orc, real, i, i, ABERTO(i), false, cod));
      if (k > 0) partes.push(celFaixa(orc, real, iMeses[0], i, ABERTO(i), true, cod));
    });
    return partes.join('');
  };

  const linhas = lista.map((no, i) => {
    if (no.tipo === 'grupo') {
      const o = somaGrupo(lista, i, 'orc'), r = somaGrupo(lista, i, 'real');
      const tO = soma(o), tR = soma(r, 0, NF);
      return `<tr class="grp n${Math.min(no.nivel, 3)}">
        <td class="l">${no.nome}</td>${celulas(o, r)}
        ${cel(tO, 'tot ini c-orc')}${cel(tR, 'tot c-real')}${cel(tR - tO, 'tot ' + cls(tR - tO))}</tr>`;
    }
    const n = natDe[no.cod];
    if (!n) return '';
    const morta = !n.tem_orc && !n.tem_mov;
    const tO = soma(n.orc), tR = soma(n.real, 0, NF);
    const marca = no.fora_do_bloco
      ? ` <span class="flag" title="Código de ${ehReceita ? 'pagamento' : 'recebimento'}, mas a linha está na aba ${ehReceita ? 'Receitas' : 'Despesas'} da planilha. Reproduzido onde a planilha põe.">⚠ bloco</span>` : '';
    return linhaNatureza(no.cod, n, morta, marca, celulas, tO, tR, nCols);
  }).join('');

  const linhasOrfas = orfas.map(n => {
    const tO = soma(n.orc), tR = soma(n.real, 0, NF);
    const marca = `<span class="flag" title="Existe no plano de contas e não tem linha em nenhuma aba da planilha.">⚠ sem linha</span>`;
    return linhaNatureza(n.cod, n, !n.tem_orc && !n.tem_mov, marca, celulas, tO, tR, nCols)
      .replace('<tr class="nat', '<tr class="nat orfa');
  }).join('');

  /* KPIs do bloco */
  const raiz = lista.findIndex(n => n.tipo === 'grupo');
  const oTot = raiz >= 0 ? somaGrupo(lista, raiz, 'orc') : new Array(12).fill(0);
  const rTot = raiz >= 0 ? somaGrupo(lista, raiz, 'real') : new Array(12).fill(0);
  const oAno = soma(oTot), rYtd = soma(rTot, 0, NF), oYtd = soma(oTot, 0, NF);

  el.innerHTML = `
  <!-- mesmo arranjo do Resumo: gráfico e KPIs lado a lado, para a tabela
       começar dentro da primeira tela em vez de a 676px num laptop de 748px -->
  <div class="topo-resumo">
  <div class="card card-grafico">
    <div class="card-title"><div><h2>${ehReceita ? 'Entradas' : 'Saídas'} por mês</h2>
      <div class="hint">Orçado × realizado. Os meses a partir de ${MESES[NF] || '—'}
      só têm orçamento.</div></div></div>
    <div id="g-bloco"></div>
  </div>
  <div class="grid-kpi">
    ${kpi(`${ehReceita ? 'Entradas' : 'Saídas'} até ${MESES[NF - 1]}`, fmt.rs(rYtd), null,
        `${seta(rYtd - oYtd)} ${fmt.sig(rYtd - oYtd)} vs orçado`, cls(rYtd - oYtd))}
    ${kpi('Orçado do ano', fmt.rs(oAno),
        `realizado é ${oAno ? fmt.pct(rYtd / oAno * 100) : '—'} do ano`)}
    ${kpi(`Orçado até ${MESES[NF - 1]}`, fmt.rs(oYtd),
        `realizado é ${oYtd ? fmt.pct(rYtd / oYtd * 100) : '—'} do orçado no período`)}
    ${kpi('Maior linha do período', (() => {
        const cands = lista.filter(n => n.tipo === 'natureza' && natDe[n.cod])
          .map(n => natDe[n.cod]).sort((a, b) => Math.abs(soma(b.real, 0, NF)) - Math.abs(soma(a.real, 0, NF)));
        return cands.length ? fmt.rs(soma(cands[0].real, 0, NF)) : '—';
      })(), (() => {
        const cands = lista.filter(n => n.tipo === 'natureza' && natDe[n.cod])
          .map(n => natDe[n.cod]).sort((a, b) => Math.abs(soma(b.real, 0, NF)) - Math.abs(soma(a.real, 0, NF)));
        return cands.length ? cands[0].nome : '';
      })())}
  </div>
  </div>

  <div class="card">
    <div class="card-title">
      <div><h2>Detalhe</h2>
      <div class="hint">Mesma hierarquia da aba <b>${ehReceita ? 'Receitas' : 'Despesas'}</b>
      da planilha. Totais anuais: orçado do ano inteiro, realizado até ${MESES[NF - 1]}.</div></div>
      <div style="display:flex;gap:10px;align-items:center;margin-left:auto">
        ${seg('seg-medida', [{ v: 'ambos', t: 'Ambos' }, { v: 'real', t: 'Realizado' },
                             { v: 'orc', t: 'Orçado' }], S.medida)}
      </div>
    </div>
    <div class="tbl-wrap">
      <table class="data wide nat">
        <thead>
          <tr><th class="l" rowspan="2">Linha</th>${colsMes}<th class="grupo ini" colspan="3">Ano</th></tr>
          <tr>${subMes}<th class="sub ini c-orc">orçado</th><th class="sub c-real">realizado</th><th class="sub">desvio</th></tr>
        </thead>
        <tbody>${linhas}${linhasOrfas}</tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:12px">
      Desvio é <b>realizado − orçado</b>, em sinal de caixa. O cursor de mão
      numa célula <b>Realizado</b> ou <b>Orçado</b> (mês, acumulado ou o
      total Ano) indica que há lançamento ou item de orçamento ali — clique
      para ver só os daquele recorte.
      ${orfas.length ? `<b>${orfas.map(o => o.nome).join('</b> e <b>')}</b>
        ${orfas.length === 1 ? 'existe' : 'existem'} no plano de contas e não
        ${orfas.length === 1 ? 'tem' : 'têm'} linha nesta aba da planilha —
        ${orfas.length === 1 ? 'aparece' : 'aparecem'} aqui no fim para não ${orfas.length === 1 ? 'ficar' : 'ficarem'} invisíveis.` : ''}
    </div>
  </div>`;

  mkChart(document.getElementById('g-bloco'), Object.assign(baseOpt(), {
    legend: { textStyle: { color: C.ink2 }, top: 2, icon: 'roundRect', itemWidth: 12, itemHeight: 12,
      data: ['Orçado', 'Realizado'] },
    xAxis: axis({ type: 'category', data: MESES }),
    yAxis: axis({ type: 'value', axisLabel: { color: C.ink3, formatter: v => fmt.k(v) } }),
    series: [
      { name: 'Orçado', type: 'bar', itemStyle: { color: C.tealDeep }, data: oTot },
      { name: 'Realizado', type: 'bar', itemStyle: { color: C.orange },
        data: rTot.map((v, i) => ({ value: v, itemStyle: { opacity: ABERTO(i) ? .3 : 1 } })) }
    ]
  }));

  bindSeg('seg-medida', v => { S.medida = v; render(); });

  /* Abrir/fechar o detalhe por CÉLULA (pedido da chefe, 24/09) — mês,
     acumulado ou o total Ano, cada uma com seu `data-cod`/`data-ini`/
     `data-fim`/`data-tipo` (gravados por `celFaixa()` e pelo Ano em
     `linhaNatureza()`). Delegação de evento na tabela em vez de um listener
     por célula: são até duas dezenas de células clicáveis por linha, e a
     tabela inteira re-renderiza a cada abrir/fechar de qualquer forma.

     `tipo` entrou em 25/09 (pedido da chefe: "fazer pro orçado a mesma coisa
     que fizemos pro realizado") — clicar no Orçado de uma célula já aberta
     no Realizado (ou vice-versa) TROCA o detalhe em vez de fechar; só fecha
     quando cod+ini+fim+tipo são todos iguais ao que já estava aberto. */
  const tabela = el.querySelector('table.data.nat');
  if (tabela) {
    /* A ROLAGEM DA CAIXA SOBREVIVE ao clique (pedido do Leonardo, 29/10/2026): o render()
       reconstrói a tabela e a caixa voltava ao início (janeiro, topo) — clicar em outubro
       abria o detalhe debaixo de janeiro, e rolar de volta até outubro levava o detalhe
       embora. Agora a caixa volta para onde estava, o detalhe fica fixo na parte visível ao
       rolar para os lados (`.lanc` sticky, CSS), e se ele abrir abaixo do fim visível da
       caixa, ela desce só o necessário. */
    const abrirFaixa = td => {
      const cod = td.dataset.cod;
      const ini = parseInt(td.dataset.ini, 10), fim = parseInt(td.dataset.fim, 10);
      const tipo = td.dataset.tipo;
      const atual = S.aberta.get(cod);
      if (atual && atual.ini === ini && atual.fim === fim && atual.tipo === tipo) S.aberta.delete(cod);
      else S.aberta.set(cod, { ini, fim, tipo });
      const caixa = tabela.closest('.tbl-wrap');
      const pos = caixa ? { x: caixa.scrollLeft, y: caixa.scrollTop } : null;
      render();
      const nova = document.querySelector('table.data.nat');
      const caixaNova = nova && nova.closest('.tbl-wrap');
      if (!pos || !caixaNova) return;
      caixaNova.scrollLeft = pos.x;
      caixaNova.scrollTop = pos.y;
      const linha = nova.querySelector(`tr[data-cod="${cod}"]`);
      const det = linha && linha.nextElementSibling && linha.nextElementSibling.classList.contains('detalhe')
        ? linha.nextElementSibling : null;
      if (!det) return;
      const cab = nova.tHead ? nova.tHead.offsetHeight : 0;
      const fimDet = det.offsetTop + det.offsetHeight;
      const fimVisivel = caixaNova.scrollTop + caixaNova.clientHeight;
      if (fimDet > fimVisivel) {
        // desce até o detalhe caber, sem passar do ponto em que a linha clicada some sob o cabeçalho
        caixaNova.scrollTop = Math.min(fimDet - caixaNova.clientHeight, linha.offsetTop - cab);
      }
    };
    tabela.addEventListener('click', e => {
      const td = e.target.closest('td.clic');
      if (td) abrirFaixa(td);
    });
    tabela.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const td = e.target.closest('td.clic');
      if (td) { e.preventDefault(); abrirFaixa(td); }
    });
  }

  /* Largura do detalhe = largura VISÍVEL da tabela (clientWidth de .tbl-wrap,
     o que cabe na tela antes de rolar), não um número fixo (pedido do
     Leonardo, 24/09: "deixa essa parte do tamanho visível da tabela").
     920px era o que dava numa janela específica; em outra largura de tela ou
     no modo Ambos (mais colunas de acumulado, .tbl-wrap mais estreito em
     proporção) o valor podia sobrar ou faltar de novo. O CSS mantém
     max-width:920px como piso de segurança se por algum motivo o .tbl-wrap
     não for encontrado; aqui o inline style vence e ajusta pro caso real. */
  const lanc = el.querySelector('.lanc');
  if (lanc) {
    const wrap = lanc.closest('.tbl-wrap');
    if (wrap) lanc.style.maxWidth = wrap.clientWidth + 'px';
  }
}

/* ── check com o DRE ──
   Pedido do Leonardo (27/10/2026), como no Controle de Gastos: o fluxo, sem os aportes de
   sócios, contra o total do DRE da FPG, mês a mês — a linha "Fluxo de Caixa - FPG" / "Check
   Final" que a própria planilha já tem. Orçado nos 12 meses; realizado só nos meses com
   export (na prévia o DRE ainda não fechou o mês). Diferença aceita (†) bate, como no
   Confronto. DRE ilegível não derruba o painel: a linha fica com ⚠ e o motivo. */
function linhaDre(par, modo) {
  const d = D.dre;
  if (!d) return '';
  if (!d.disponivel) {
    const t = esc(`DRE não lido: ${d.motivo}`);
    const cel = `<td class="ind ini" title="${t}">·</td>`;
    return `<tr class="confere dre"><td class="l" title="${t}">Confere com o DRE ⚠</td>${
      MESES.map(() => par ? cel + cel : cel).join('')}</tr>`;
  }
  const naturezas = (i, tipo) => d.naturezas.filter(x => x.mes === i + 1 && x.tipo === tipo)
    .map(x => `${x.cod} ${x.nome}: painel ${fmt.n(x.painel)} × DRE ${fmt.n(x.dre)}`);
  const celula = (i, tipo, ini) => {
    const k = ini ? ' ini' : '';
    const v = d[tipo][i];
    if (v == null) {
      const t = (d.sem_dre || []).includes(i + 1) ? 'o DRE ainda não tem o realizado deste mês'
        : 'sem export: o realizado é prévia e o DRE ainda não fechou o mês';
      return `<td class="ind${k}" title="${MESES_LONGO[i]}: ${t}">·</td>`;
    }
    const ac = tipo === 'real' ? (d.aceito[i] || 0) : 0;
    const bate = Math.abs(v - ac) < 0.005, comAceito = bate && Math.abs(ac) >= 0.005;
    const t = [`${MESES_LONGO[i]}, ${tipo === 'orc' ? 'orçado' : 'realizado'}: ` + (bate
      ? (comAceito ? `bate, com a diferença aceita de ${fmt.sig(ac)}` : 'bate com o DRE')
      : `difere em ${fmt.sig(v)}`), ...naturezas(i, tipo)].join('\n');
    return `<td class="ind${k} ${bate ? 'pos' : 'neg'}" title="${esc(t)}">${
      bate ? '✓' + (comAceito ? '<sup>†</sup>' : '') : fmt.sig(v)}</td>`;
  };
  return `<tr class="confere dre"><td class="l" title="${esc(d.arquivo)}">Confere com o DRE</td>${
    MESES.map((_, i) => par ? celula(i, 'orc', true) + celula(i, 'real', false)
                            : celula(i, modo === 'orc' ? 'orc' : 'real', true)).join('')}</tr>`;
}

/* ── registro do HPG ──
   O `FPG - HARAS` (58) é do HPG: a FPG paga despesas do Haras e a família reembolsa, e o par
   zera no mês. Pedido da chefe do Leonardo (26/10/2026): NÃO aparece no fluxo (o extrator já
   o tirou dos números), mas fica registrado — se o Confronto não fechar em zero, é aqui que
   se procura. Desde 27/10/2026 entra também a natureza do Haras sem linha no fluxo, em
   qualquer centro (`centro` de cada lançamento diz o motivo). Bloco FECHADO por padrão no fim
   do Resumo; abre pelo próprio título ou pelo "Ver lançamentos" do alerta no topo.
   Lançamentos da API (em todo mês), não do export. */
function blocoHpg() {
  const H = D.hpg;
  if (!H || !H.lancamentos || !H.lancamentos.length) return '';
  const pm = H.por_mes;
  /* EM ABERTO = o acumulado no último mês com export: pagamento num mês e reembolso no
     seguinte é adiantamento que já fechou (a "reserva" de jul/ago) */
  const ultExp = Math.max(0, ...D.meses.filter(m => m.fonte === 'export').map(m => m.n));
  const aberto = ultExp ? (pm[ultExp - 1].acumulado || 0) : 0;
  const acumCel = pm.map(p => {
    const fonte = (D.meses[p.mes - 1] || {}).fonte;
    if (p.mes > NF) return '<td class="ini na">·</td>';
    const v = p.acumulado || 0;
    return `<td class="ini ${Math.abs(v) >= 0.005 ? cls(v) : ''}">${Math.abs(v) < 0.005 ? '0,00' : fmt.n(v)}${
      fonte === 'api' ? '<span class="previa" title="mês ainda em prévia">*</span>' : ''}</td>`;
  }).join('');
  const mesesCel = pm.map(p => {
    const fonte = (D.meses[p.mes - 1] || {}).fonte;
    const vazio = !p.n;
    const attrs = vazio ? '' : ` data-hpg-mes="${p.mes}" title="Ver os ${p.n} lançamento${p.n === 1 ? '' : 's'} de ${MESES_LONGO[p.mes - 1]}"`;
    const k = ['ini', vazio ? 'na' : 'clic', Math.abs(p.total) >= 0.005 ? cls(p.total) : '',
               S.hpgMes === p.mes && S.hpgFiltro !== 'fora' ? 'cel-aberta' : ''].join(' ');
    return `<td class="${k}"${attrs}>${vazio ? '·' : (Math.abs(p.total) < 0.005 ? '0,00' : fmt.n(p.total))}${
      !vazio && fonte === 'api' ? '<span class="previa" title="mês ainda em prévia">*</span>' : ''}</td>`;
  }).join('');
  /* NOTA DE DÉBITO (23/11/2026, pedido do Leonardo): a lista mostra só o pagamento que NÃO
     entrou na nota de débito do Haras (`nota_debito_haras`) — o que a FPG pagou e não cobrou
     do Condomínio (título na nota com outro valor é rateio antigo: conta como cobrado). O resto (reembolso
     recebido) fica só na soma do mês. Mês sem nota ainda (a do mês sai no fechamento) não se
     julga. */
  const ND = H.nota_debito || { meses: [] };
  const temNota = m => (ND.meses || []).includes(m);
  const naoCobrado = l => l.nota && l.nota.status !== 'cobrado';
  const foraCel = pm.map(p => {
    if (p.mes > NF) return '<td class="ini na">·</td>';
    if (!temNota(p.mes)) return '<td class="ini na" title="a nota de débito deste mês ainda não saiu">·</td>';
    if (!p.fora_n) return '<td class="ini pos" title="tudo cobrado na nota de débito">✓</td>';
    const aberta = S.hpgMes === p.mes && S.hpgFiltro === 'fora';
    return `<td class="ini clic neg${aberta ? ' cel-aberta' : ''}" data-hpg-mes="${p.mes}" data-hpg-filtro="fora"
      title="${p.fora_n} pagamento${p.fora_n === 1 ? '' : 's'} fora da nota de débito">${fmt.n(p.fora_total)}</td>`;
  }).join('');
  /* Duas listas (Leonardo, 23/11/2026): o clique no "Saldo do mês" mostra TODOS os lançamentos
     do mês (pagamentos e reembolsos, o que soma o saldo); o clique em "Fora da nota de débito",
     só os pagamentos que não entraram na nota. Nas duas, o pagamento fora da nota tem a marca. */
  let lista = '';
  if (S.hpgMes) {
    const doMes = H.lancamentos.filter(l => l.mes === S.hpgMes);
    const soFora = S.hpgFiltro === 'fora';
    const ls = soFora ? doMes.filter(naoCobrado) : doMes;
    const nota = l => !naoCobrado(l) ? ''
      : '<span class="chip-nota" title="em nenhuma nota de débito do Haras">fora da nota</span> ';
    const vazio = !soFora ? ''
      : !temNota(S.hpgMes) ? `<div class="empty muted">A nota de débito de ${MESES_LONGO[S.hpgMes - 1]}
          ainda não saiu (${doMes.length} lançamento${doMes.length === 1 ? '' : 's'} no mês, ${fmt.n(
          doMes.reduce((s, l) => s + l.valor, 0))}).</div>`
      : !ls.length ? `<div class="empty muted">Todos os pagamentos de ${MESES_LONGO[S.hpgMes - 1]} entraram na nota
          de débito.</div>` : '';
    lista = `<div class="lanc">
      <div class="lanc-legenda">${soFora
        ? `Pagamentos do HPG em ${MESES_LONGO[S.hpgMes - 1]} que não entraram na nota de débito`
        : `Lançamentos do HPG em ${MESES_LONGO[S.hpgMes - 1]}`}</div>
      ${vazio || `<div class="lanc-cab"><div>baixa</div><div>título</div><div>contraparte</div>
        <div>natureza · observação</div><div class="d-val">valor</div></div>
      ${ls.map(l => `<div class="lanc-linha">
        <div class="d-data">${dataBr(l.data_baixa)}</div>
        <div class="d-tit" title="${esc(l.titulo)}">${esc(l.titulo)}</div>
        <div class="d-forn" title="${esc(l.fornecedor || '')}">${l.fornecedor ? esc(l.fornecedor) : '<i>sem contraparte</i>'}</div>
        <div class="d-obs" title="${esc(l.observacao)}">${nota(l)}<span class="via">${esc(l.origem)} · ${esc(l.centro)} · ${esc(l.cod)} ${esc(l.natureza)}</span> ${esc(l.observacao)}</div>
        <div class="d-val">${fmt.n(l.valor)}</div></div>`).join('')}
      <div class="lanc-rodape"><div>${soFora
        ? `${ls.length} pagamento${ls.length === 1 ? '' : 's'} fora da nota (de ${doMes.length} lançamentos no mês)`
        : `${ls.length} lançamento${ls.length === 1 ? '' : 's'} — fora do fluxo`}</div>
        <div class="d-val">${fmt.n(ls.reduce((s, l) => s + l.valor, 0))}</div></div>`}
    </div>`;
  }
  return `<details class="card hpg" id="hpg-reg"${S.hpgAberto ? ' open' : ''}>
    <summary class="card-title"><div><h2>Registro do HPG — fora do fluxo</h2>
      <div class="hint">Pagamentos do Haras feitos pela FPG e os reembolsos, que zeram no mês
      (${esc(H.centros.join(' e '))}).
      Não entram em nenhum número acima; ficam aqui para mapear um Confronto que não fecha.
      Reembolso no mês seguinte é adiantamento: fica <b>em aberto</b> no acumulado e fecha sozinho.
      ${Math.abs(aberto) >= 0.005 ? `<b class="neg">Em aberto em ${MESES_LONGO[ultExp - 1]}: ${fmt.n(aberto)}.</b>`
        : 'Nada em aberto.'}
      Clique no saldo de um mês para ver todos os lançamentos. A última linha confere com a <b>nota de
      débito do Haras</b> de cada mês: clicando nela, só os pagamentos que não entraram na nota.</div></div></summary>
    <div class="tbl-wrap">
      <table class="data fluxo">
        <thead><tr><th class="l">&nbsp;</th>${MESES.map(m => `<th class="ini">${m}</th>`).join('')}</tr></thead>
        <tbody><tr><td class="l">Saldo do mês</td>${mesesCel}</tr>
          <tr><td class="l">Em aberto (acumulado)</td>${acumCel}</tr>
          <tr><td class="l" title="pagamentos do HPG que não entraram na nota de débito do Haras">Fora da nota de débito</td>${foraCel}</tr></tbody>
      </table>
    </div>
    ${lista}
  </details>`;
}

function ligarHpg(raiz) {
  const reg = raiz.querySelector('#hpg-reg');
  if (!reg) return;
  reg.addEventListener('toggle', () => { S.hpgAberto = reg.open; });
  reg.addEventListener('click', ev => {
    const td = ev.target.closest('td[data-hpg-mes]');
    if (!td) return;
    const m = parseInt(td.dataset.hpgMes, 10);
    const filtro = td.dataset.hpgFiltro || 'todos';
    const mesma = S.hpgMes === m && (S.hpgFiltro || 'todos') === filtro;
    S.hpgMes = mesma ? null : m;
    S.hpgFiltro = filtro;
    S.hpgAberto = true;
    render();
    rolarAteHpg();
  });
}

/* abre o registro no mês pedido (botões de mês da faixa do topo) */
function abrirHpg(mes) {
  // mês com pagamento fora da nota de débito abre direto nele (é o que está em aberto)
  const pm = ((D.hpg || {}).por_mes || [])[mes - 1] || {};
  S.pagina = 'resumo'; S.hpgAberto = true; S.hpgMes = mes; S.hpgFiltro = pm.fora_n ? 'fora' : 'todos';
  render();
  rolarAteHpg();
}

/* rola até o registro DESCONTANDO o cabeçalho fixo do site: com scrollIntoView o título do
   bloco ficava escondido atrás dele (visto no screenshot de 26/10/2026) */
function rolarAteHpg() {
  const r = document.getElementById('hpg-reg');
  if (!r) return;
  const topo = document.querySelector('header, .topbar, .site-header');
  const folga = (topo ? topo.getBoundingClientRect().height : 80) + 12;
  window.scrollTo(0, window.scrollY + r.getBoundingClientRect().top - folga);
}

/* ── avisos ── */
function renderAvisos(el) {
  /* o HPG em aberto já está no Registro do HPG, logo acima, e na faixa do topo — aqui era o
     mesmo recado uma terceira vez (Leonardo, 29/10/2026) */
  const avisos = (D.avisos || []).filter(a => a.tipo !== 'centro-hpg-em-aberto');
  if (!avisos.length) { el.innerHTML = ''; return; }
  const porTipo = {};
  avisos.forEach(a => (porTipo[a.tipo] = porTipo[a.tipo] || []).push(a));
  el.innerHTML = `
  <div class="card">
    <div class="card-title"><div><h2>Avisos da extração</h2>
    <div class="hint">Cada um destes erra <b>para menos</b> — por isso viram aviso
    em vez de silêncio.</div></div></div>
    <div class="notes">${Object.entries(porTipo).map(([t, lst]) => `
      <div class="note ${['baixa-parcial', 'pagina-recusada-pela-api'].includes(t) ? 'alerta' : ''}">
        <span class="ic">⚠</span><div><b>${t}</b> · ${lst.length}×<br>${lst[0].msg}</div></div>`).join('')}
    </div>
  </div>`;
}

/* texto vindo de fora (nome de natureza da API do Bimer) nunca vira HTML */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Naturezas com lançamento que não estão no cadastro (out/2026, cadastro no Hub). Entram
   no total, num grupo "Pendentes" no fim da aba — sumir do total seria pior que aparecer
   fora do lugar —, e este aviso diz o que fazer. No Hub, o botão abre o cadastro. */
function renderPendentes() {
  const el = document.getElementById('banner-slot');
  if (!el) return;
  // as faixas de aviso só no Resumo (Leonardo, 29/10/2026): nas outras abas repetiam o
  // mesmo recado e empurravam a tabela para baixo
  if (S.pagina !== 'resumo') { el.innerHTML = ''; return; }
  const previa = D.meses.filter(m => m.fonte === 'api').map(m => MESES_LONGO[m.n - 1]);
  const txtPrevia = previa.join(', ');
  const faixaPrevia = previa.length ? `<div class="aviso-saldo">
    <span class="ic">ⓘ</span>
    <div><b>${txtPrevia.charAt(0).toUpperCase() + txtPrevia.slice(1)}: prévia.</b> O realizado ${previa.length === 1 ? 'deste mês' : 'destes meses'}
      vem da API do Bimer porque ainda não há o export na pasta “Bases Fluxo de Caixa\\FPG”;
      quando ele chegar, os números passam a ser os do export e podem mudar.</div>
  </div>` : '';
  /* HPG (fora do fluxo): alerta o adiantamento EM ABERTO no último mês com export — o
     acumulado, não o do mês: pagamento num mês e reembolso no seguinte fecha sozinho e não
     alerta (chefe do Leonardo, 26 e 27/10/2026). Mês de PRÉVIA não alerta mais (Leonardo,
     29/10/2026): o gasto é reembolsado quando o mês fecha; os lançamentos seguem no registro.
     O botão leva ao mês em que o adiantamento abriu. */
  const hpg = (D.avisos || []).filter(a => a.tipo === 'centro-hpg-em-aberto');
  const faixaHpg = hpg.length ? `<div class="aviso-saldo alerta aviso-hpg">
    <span class="ic">⚠</span>
    <div><b>Lançamentos do HPG (${esc(D.hpg.centros.join(' e '))}), fora do fluxo:</b>
      ${hpg.map(a => `${fmt.n(a.total)} em aberto desde ${MESES_LONGO[a.desde - 1]}, à espera ${
        a.total < 0 ? 'do reembolso' : 'do pagamento'}${(a.titulos || []).length
        ? ` (${a.titulos.map(esc).join(', ')}, fora da nota de débito)` : ''}`).join('; ')}.
      Não entram nos números; se o Confronto não fechar, comece por eles.</div>
    <div class="hpg-botoes">${hpg.map(a =>
      `<button type="button" class="btn-ghost" data-hpg-ver="${a.desde}" title="${esc(a.msg)}">${MESES[a.desde - 1]}</button>`).join('')}</div>
  </div>` : '';
  const ligarFaixaHpg = () => el.querySelectorAll('[data-hpg-ver]').forEach(b =>
    b.addEventListener('click', () => abrirHpg(parseInt(b.dataset.hpgVer, 10))));
  const p = D.pendentes || [];
  if (!p.length) { el.innerHTML = faixaPrevia + faixaHpg; ligarFaixaHpg(); return; }
  const abrir = HUB && HUB.abrirCadastro;
  el.innerHTML = faixaPrevia + faixaHpg + `<div class="aviso-saldo alerta">
    <span class="ic">⚠</span>
    <div><b>${p.length} natureza${p.length === 1 ? '' : 's'} com lançamento fora do cadastro:</b>
      ${p.map(x => `${esc(x.cod)} ${esc(x.nome)} (${fmt.n(x.valor)})`).join('; ')}.
      ${p.length === 1 ? 'Está' : 'Estão'} no grupo “Pendentes” e ${p.length === 1 ? 'entra' : 'entram'}
      no total — classifique no cadastro de naturezas.</div>
    ${abrir ? '<button type="button" class="btn-ghost" id="btn-pend-cadastro">Classificar</button>' : ''}
  </div>`;
  ligarFaixaHpg();
  const b = document.getElementById('btn-pend-cadastro');
  if (b) b.addEventListener('click', () => HUB.abrirCadastro());
}

/* ── casca ── */
function render() {
  clearCharts();
  renderPendentes();
  const view = document.getElementById('view');
  view.innerHTML = `<div id="b-pag"></div><div id="b-avisos"></div>`;
  const alvo = document.getElementById('b-pag');
  if (S.pagina === 'resumo') pagResumo(alvo);
  else if (S.pagina === 'simples') pagSimplificado(alvo);
  else pagBloco(alvo, S.pagina);
  if (S.pagina === 'resumo') renderAvisos(document.getElementById('b-avisos'));
  document.querySelectorAll('#nav-pag button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === S.pagina));
  congelarCabecalhos(view);
}

/* Cabeçalho congelado (CSS em index.html): a 2ª linha do cabeçalho gruda logo abaixo
   da 1ª, e a altura da 1ª é MEDIDA aqui depois de desenhar — muda com a fonte, o
   modo (Ambos/Realizado/Orçado) e o zoom, então um número fixo erraria. */
function congelarCabecalhos(raiz) {
  raiz.querySelectorAll('table.data').forEach(t => {
    const cab = t.tHead && t.tHead.rows[0];
    if (cab) t.style.setProperty('--h-cab1', cab.getBoundingClientRect().height + 'px');
  });
}
window.addEventListener('resize', () => congelarCabecalhos(document));

/* ═══════════════════ EXPORTAR PDF (29/09, pedido do Leonardo) ═══════════════════

   Voltou a ser PDF depois de testar Excel (ele achou o Excel bom, mas pediu
   pra voltar pro PDF) — mas agora só a página Resumo Simplificado, no MÊS
   JÁ SELECIONADO na tela (não força um mês específico), sempre TOTALMENTE
   destrinchada. Escopo bem menor que a 1ª versão (que também exportava o
   Resumo com o gráfico): essa página não tem canvas nenhum, então não tem
   o problema de capturar gráfico nem de medir duas seções pra achar a
   altura da página — é só uma tabela. */

/* Todo nó `grupo` (nível 1+) de Receitas/Despesas, pra forçar TUDO aberto no
   Resumo Simplificado exportado — mesma chave que `linhasArvore()` usa
   (`aba:índice-na-estrutura`), então basta popular `S.simplesAbertos` com
   elas: nenhuma lógica de render precisa saber que veio de uma exportação. */
function todasAsChavesSimples() {
  const chaves = new Set();
  ['receitas', 'despesas'].forEach(aba => {
    (D.estrutura[aba] || []).forEach((no, j) => {
      if (no.tipo === 'grupo' && no.nivel >= 1) chaves.add(`${aba}:${j}`);
    });
  });
  return chaves;
}

/* A4 deitado, em várias páginas (29/10, pedido do Leonardo) — o mesmo do PDF
   do card (pdf_resumo.py). Antes era 1 página sob medida pra tabela inteira:
   no FPG (95 linhas) virava uma tira que o leitor encolhia até não dar pra ler.
   Mede a largura de verdade e, se a tabela não couber na folha, reduz o
   conteúdo inteiro (`zoom`) — as colunas ficam iguais em toda página. O
   cabeçalho da tabela o Chrome já repete sozinho em cada página (thead). */
function ajustarPaginaImpressao() {
  const el = document.getElementById('pg-imp-simples');
  const t = el && el.querySelector('table');
  const margemMm = 10;
  const util = (297 - 2 * margemMm) * 96 / 25.4; // largura útil da folha, em px CSS
  // na tela a tabela estica até a janela: mede a largura NATURAL dela (+ o
  // padding do card), senão uma janela larga encolheria o PDF à toa
  let largura = 0;
  if (t) {
    const folga = el.scrollWidth - t.offsetWidth; // padding do card em volta da tabela
    const antes = t.style.width;
    t.style.width = 'max-content';
    largura = t.offsetWidth + folga;
    t.style.width = antes;
  }
  const escala = largura > util ? Math.floor(util / largura * 1000) / 1000 : 1;
  let estilo = document.getElementById('estilo-impressao');
  if (!estilo) {
    estilo = document.createElement('style');
    estilo.id = 'estilo-impressao';
    document.head.appendChild(estilo);
  }
  estilo.textContent = `@page{size:A4 landscape;margin:${margemMm}mm}
@media print{#pg-imp-simples{zoom:${escala}}
#pg-imp-simples tr{break-inside:avoid}
#pg-imp-simples tr.quebra{break-before:page}}`;
  return { escala, larguraUtil: util, alturaUtil: (210 - 2 * margemMm) * 96 / 25.4 };
}

/* ONDE QUEBRAR (29/10, pedido do Leonardo) — as MESMAS regras do PDF do card
   (`paginar` em pdf_resumo.py; mudou lá, muda aqui): a receita numa página
   só dela; entre as quebras que cabem, a que parte menos grupos (o nome do
   grupo não fica numa página e as naturezas em outra); grupo maior que uma
   folha repete o nome com "(continuação)" no topo da seguinte. As alturas são
   medidas na tela (a impressão só aplica o zoom); 3% de folga porque, se a
   conta passar de uma linha, o Chrome quebra antes e sobra uma página quase vazia. */
const NIVEL_IMP = { saldo: 0, variacao: 0, saldo_final: 0, total_receita: 0, total_despesa: 0,
  sub1_receita: 1, sub1_despesa: 1, grp1: 2, grp2: 3, grp3: 4, nat: 5 };
const QUEBRA_ANTES_IMP = new Set(['total_despesa']);
const MIN_ULTIMA_IMP = 6, MIN_CHEIA_IMP = 0.4;
const ehTitulo = t => /^(total_|sub1_|grp)/.test(t);

function tipoDaLinha(tr) {
  const c = tr.classList;
  const lado = c.contains('receita') ? 'receita' : 'despesa';
  if (c.contains('fechofinal')) return 'saldo_final';
  if (c.contains('saldo')) return 'saldo';
  if (c.contains('variacao')) return 'variacao';
  if (c.contains('total')) return 'total_' + lado;
  if (c.contains('sub1')) return 'sub1_' + lado;
  for (const n of [1, 2, 3]) if (c.contains('n' + n)) return 'grp' + n;
  return 'nat';
}

function gruposAbertos(tipos) {
  const abertos = [];
  let pilha = [];
  tipos.forEach((t, c) => {
    pilha = pilha.filter(h => NIVEL_IMP[tipos[h]] < NIVEL_IMP[t]);
    abertos.push(pilha);
    if (ehTitulo(t)) pilha = pilha.concat([c]);
  });
  abertos.push([]);
  return abertos;
}

const repeteNoTopo = (tipos, abertos, c) =>
  c < tipos.length && tipos[c] === 'nat' && abertos[c].length ? abertos[c][abertos[c].length - 1] : null;

function paginar(alturas, tipos, cabePrimeira, cabeDemais, reservaFinal) {
  const n = alturas.length, abertos = gruposAbertos(tipos);
  const somar = (a, b) => alturas.slice(a, b).reduce((x, y) => x + y, 0);
  const forcadas = tipos.map((t, i) => (QUEBRA_ANTES_IMP.has(t) && i > 0 ? i : -1)).filter(i => i > 0);
  const minUltima = somar(n - MIN_ULTIMA_IMP, n) + reservaFinal <= cabeDemais ? MIN_ULTIMA_IMP : 1;
  const faixas = [];
  let ini = 0;
  while (ini < n) {
    let cabe = faixas.length ? cabeDemais : cabePrimeira;
    const rep = faixas.length ? repeteNoTopo(tipos, abertos, ini) : null;
    if (rep !== null) cabe -= alturas[rep];
    const limite = forcadas.find(q => q > ini) ?? n;
    if (limite === n && somar(ini, n) + reservaFinal <= cabe) { faixas.push([ini, n]); break; }
    let fim = ini, usado = 0;
    while (fim < limite && (fim === ini || usado + alturas[fim] <= cabe)) usado += alturas[fim++];
    if (!(fim === limite && limite < n)) {
      fim = Math.max(ini + 1, Math.min(fim, n - minUltima));
      const cands = [];
      for (let c = ini + 1; c <= fim; c++) cands.push(c);
      const cheias = cands.filter(c => somar(ini, c) >= MIN_CHEIA_IMP * cabe);
      fim = (cheias.length ? cheias : cands).reduce((melhor, c) =>
        (abertos[c].length < abertos[melhor].length ||
         (abertos[c].length === abertos[melhor].length && c > melhor)) ? c : melhor);
    }
    faixas.push([ini, fim]);
    ini = fim;
  }
  return { faixas, abertos };
}

function paginarImpressao({ escala, larguraUtil, alturaUtil }) {
  const el = document.getElementById('pg-imp-simples');
  const t = el && el.querySelector('table');
  if (!t) return;
  // mede como sai no papel: painel e barra do topo na largura da folha, e a barra
  // sem o menu e os botões (o @media print os esconde). Medindo a barra como está
  // na tela, numa janela estreita ela quebrava em 2 linhas (124px; na folha são 78)
  const barra = document.querySelector('.topbar');
  const sumir = barra ? [...barra.querySelectorAll('#nav-slot, button')] : [];
  const antes = [el.style.width, barra && barra.style.width, sumir.map(x => x.style.display)];
  el.style.width = `${larguraUtil / escala}px`;
  if (barra) barra.style.width = `${larguraUtil}px`;
  sumir.forEach(x => { x.style.display = 'none'; });
  const trs = [...t.tBodies[0].rows];
  const tipos = trs.map(tipoDaLinha);
  const alturas = trs.map(tr => tr.getBoundingClientRect().height);
  const topo = trs[0].getBoundingClientRect().top;
  const fimTabela = t.getBoundingClientRect().bottom;
  const folha = alturaUtil / escala * 0.97;   // altura da folha em px da tabela (antes do zoom)
  // 1ª página: o topo do site (fora do zoom) e o título do card + cabeçalho (dentro).
  // Na impressão só a barra do topo fica acima do painel — menu, faixas e o espaço
  // de `.content` somem; medir `el.top` na tela contava 268px em vez de 78 (medido).
  const site = barra ? barra.getBoundingClientRect().height : 0;
  const { faixas, abertos } = paginar(alturas, tipos,
    folha - site / escala - (topo - el.getBoundingClientRect().top),
    folha - t.tHead.getBoundingClientRect().height,
    el.getBoundingClientRect().bottom - fimTabela);
  el.style.width = antes[0];
  if (barra) barra.style.width = antes[1];
  sumir.forEach((x, i) => { x.style.display = antes[2][i]; });
  faixas.slice(1).forEach(([ini]) => {
    const rep = repeteNoTopo(tipos, abertos, ini);
    if (rep === null) { trs[ini].classList.add('quebra'); return; }
    const cont = trs[rep].cloneNode(true);
    cont.classList.add('quebra', 'continuacao');
    const rot = cont.querySelector('td.l');
    rot.className = 'l';
    ['data-chave', 'tabindex', 'role', 'aria-expanded'].forEach(a => rot.removeAttribute(a));
    rot.textContent = `${trs[rep].querySelector('td.l').textContent.replace(/[▸▾]/g, '').trim()} (continuação)`;
    // só o nome: os valores do grupo já saíram na página anterior
    [...cont.cells].slice(1).forEach(td => { td.textContent = ''; td.className = td.className.replace(/\b(pos|neg|na)\b/g, ''); });
    trs[ini].before(cont);
  });
}

/* Guarda só `S.simplesAbertos` — é o único campo que este export muda (o
   mês continua o que já estava selecionado). Restaurado no `afterprint`,
   que dispara tanto se a pessoa imprimir quanto se cancelar o diálogo. */
let _abertosPreImpressao = null;

function exportarPdfSimplificado() {
  _abertosPreImpressao = S.simplesAbertos;
  S.simplesAbertos = todasAsChavesSimples();

  clearCharts();
  const view = document.getElementById('view');
  view.innerHTML = `<div id="pg-imp-simples"></div>`;
  pagSimplificado(document.getElementById('pg-imp-simples'));

  /* setTimeout, não `requestAnimationFrame` — medido na 1ª versão deste
     recurso: no Chrome headless usado pelos testes deste projeto, rAF nunca
     dispara, então `window.print()` nunca era chamado. */
  setTimeout(() => {
    paginarImpressao(ajustarPaginaImpressao());
    window.print();
  }, 150);
}

window.addEventListener('afterprint', () => {
  if (!_abertosPreImpressao) return;
  S.simplesAbertos = _abertosPreImpressao;
  _abertosPreImpressao = null;
  render();
});

function boot() {
  if (!D) {
    document.getElementById('view').innerHTML =
      `<div class="card"><h2>Sem dados</h2><div class="hint">
       Rode <code>python extrair_fpg.py</code> para gerar
       <code>dados/fluxo_fpg.js</code>.</div></div>`;
    document.getElementById('sub').textContent = 'payload ausente';
    return;
  }
  document.getElementById('nav-slot').innerHTML = seg('nav-pag', PAGINAS, S.pagina);
  bindSeg('nav-pag', v => { S.pagina = v; render(); window.scrollTo(0, 0); });

  const btnExportPdf = document.getElementById('btn-export-pdf');
  if (btnExportPdf) btnExportPdf.addEventListener('click', exportarPdfSimplificado);

  document.getElementById('sub').textContent =
    `${D.meta.ano} · ${D.qual.naturezas} naturezas · ${fmt.int(D.qual.lancamentos)} lançamentos`;
  document.getElementById('chip-fonte-txt').textContent = `extraído em ${D.meta.gerado_em}`;
  const origem = (D.meta.estrutura || {}).origem === 'cadastro'
    ? 'cadastro de naturezas do Hub' : 'abas Receitas/Despesas da planilha';
  document.getElementById('foot-gen').textContent =
    `realizado: ${D.meta.fontes.realizado} · orçado: ${D.meta.fontes.orcado} · saldos: ${D.meta.fontes.saldos}` +
    ` · estrutura: ${origem}`;

  /* "Editar cadastro de naturezas": só quando há onde gravar — no Hub (Supabase) ou servido
     pelo abrir_painel.py (fpg_local.js, arquivo local). Solto por file:// não há. */
  const btnCad = document.getElementById('btn-cadastro');
  if (btnCad) {
    if (HUB && HUB.abrirCadastro) {
      btnCad.hidden = false;
      btnCad.addEventListener('click', () => HUB.abrirCadastro());
    } else btnCad.hidden = true;
  }
  /* "Movimentações manuais" (28/10/2026): mesma regra — só quando há onde gravar */
  const btnMan = document.getElementById('btn-manuais');
  if (btnMan) {
    const n = ((D.manuais || {}).movimentos || []).length;
    if (HUB && HUB.abrirManuais) {
      btnMan.hidden = false;
      if (n) btnMan.textContent = `Movimentações (${n})`;
      btnMan.addEventListener('click', () => HUB.abrirManuais());
    } else btnMan.hidden = true;
  }
  render();
}

boot();
