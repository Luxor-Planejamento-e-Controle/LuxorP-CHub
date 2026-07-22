/* Luxor P&C Hub — app offline (dados de exemplo). Sem fetch: tudo inline p/ abrir via file://. */
'use strict';

/* ----------------------------------------------------------------- paleta */
const C = {
  orange:'#FFA400', orangeDeep:'#E08E00', teal:'#2E97A6', tealDeep:'#1D6E79',
  ink:'#EAF4F4', ink2:'#A7C3C5', ink3:'#6E8C90', pos:'#46B678', neg:'#E5674E',
  warn:'#F2C14E', line:'rgba(255,255,255,.10)', surface:'#143840'
};
const fmt = {
  pct:v=>(v>=0?'+':'')+v.toFixed(2).replace('.',',')+'%',
  num:(v,d=4)=>v.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}),
  mi:v=>(v/1e6).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+' Mi'
};
const cls = v => v>=0?'pos':'neg';

/* --------------------------------------------------------- dados exemplo */
// Indicadores — cada fundo: linhas [data, cota, dia, mtd, qtd, ytd, m36]
const IND = {
  'Dólar': [
    ['30/04/2026',4.9886,-0.20,-4.42,-4.42,-9.34,-0.24],['29/04/2026',4.9985,0.21,-4.23,-4.23,-9.16,-0.04],
    ['28/04/2026',4.9878,0.36,-4.44,-4.44,-9.35,-0.26],['27/04/2026',4.9700,-0.76,-4.78,-4.78,-9.68,-0.90],
    ['24/04/2026',5.0083,1.10,-4.04,-4.04,-8.98,-1.01],['23/04/2026',4.9539,-0.23,-5.09,-5.09,-9.97,-1.90],
    ['22/04/2026',4.9653,-0.38,-4.87,-4.87,-9.76,-1.67],['20/04/2026',4.9844,0.30,-4.50,-4.50,-9.41,-1.29],
    ['17/04/2026',4.9695,-0.62,-4.79,-4.79,-9.68,0.55],['16/04/2026',5.0007,0.16,-4.19,-4.19,-9.12,1.12],
    ['15/04/2026',4.9928,0.24,-4.34,-4.34,-9.26,0.96],['14/04/2026',4.9806,-0.87,-4.58,-4.58,-9.48,0.71],
    ['13/04/2026',5.0244,0.03,-3.74,-3.74,-8.69,2.34],['10/04/2026',5.0229,-1.16,-3.76,-3.76,-8.71,-1.19],
    ['09/04/2026',5.0821,-0.15,-2.63,-2.63,-7.64,0.27],['08/04/2026',5.0899,-1.41,-2.48,-2.48,-7.50,0.43],
    ['07/04/2026',5.1625,0.18,-1.09,-1.09,-6.18,1.86],['06/04/2026',5.1532,-0.24,-1.27,-1.27,-6.35,1.68],
  ],
  'Mangalarga': [
    ['30/04/2026',2.4555,1.11,2.99,2.99,-9.74,31.66],['29/04/2026',2.4285,0.25,1.86,1.86,-10.73,30.21],
    ['28/04/2026',2.4225,-0.36,1.61,1.61,-10.95,29.89],['27/04/2026',2.4312,-0.33,1.97,1.97,-10.63,31.22],
    ['24/04/2026',2.4394,0.85,2.31,2.31,-10.33,30.15],['23/04/2026',2.4188,-0.32,1.45,1.45,-11.09,29.02],
    ['22/04/2026',2.4267,-0.36,1.78,1.78,-10.80,29.44],['20/04/2026',2.4354,-0.32,2.15,2.15,-10.48,29.90],
    ['17/04/2026',2.4432,0.56,2.47,2.47,-10.19,32.68],['16/04/2026',2.4296,-0.14,1.90,1.90,-10.69,32.09],
    ['15/04/2026',2.4331,0.51,2.05,2.05,-10.57,32.28],['14/04/2026',2.4207,0.88,1.53,1.53,-11.02,31.61],
    ['13/04/2026',2.3997,0.48,0.65,0.65,-11.79,30.12],['10/04/2026',2.3883,-0.95,0.17,0.17,-12.21,27.19],
    ['09/04/2026',2.4111,-1.30,1.13,1.13,-11.37,28.82],['08/04/2026',2.4429,1.95,2.46,2.46,-10.21,30.52],
    ['07/04/2026',2.3962,0.22,0.50,0.50,-11.92,28.02],['06/04/2026',2.3908,0.36,0.28,0.28,-12.12,27.74],
  ],
  'Lipizzaner': [
    ['30/04/2026',3.1420,0.42,1.85,1.85,4.12,18.90],['29/04/2026',3.1288,0.18,1.61,1.61,3.68,18.44],
    ['28/04/2026',3.1232,-0.22,1.43,1.43,3.49,18.02],['27/04/2026',3.1301,0.31,1.66,1.66,3.72,18.51],
    ['24/04/2026',3.1204,0.55,1.34,1.34,3.39,17.88],['23/04/2026',3.1033,-0.19,1.09,1.09,2.97,17.10],
    ['22/04/2026',3.1092,-0.28,1.28,1.28,3.18,17.44],['20/04/2026',3.1179,0.24,1.55,1.55,3.48,17.90],
    ['17/04/2026',3.1104,0.36,1.27,1.27,3.19,18.02],['16/04/2026',3.0992,0.14,0.90,0.90,2.81,17.55],
  ],
  'Maratona': [
    ['30/04/2026',1.8842,-0.31,-0.85,-0.85,-2.14,9.66],['29/04/2026',1.8901,0.21,-0.54,-0.54,-1.84,9.91],
    ['28/04/2026',1.8862,-0.16,-0.75,-0.75,-2.04,9.62],['27/04/2026',1.8892,0.28,-0.59,-0.59,-1.88,9.88],
    ['24/04/2026',1.8839,0.35,-0.87,-0.87,-2.15,9.42],['23/04/2026',1.8773,-0.19,-1.22,-1.22,-2.49,8.90],
    ['22/04/2026',1.8809,-0.24,-1.03,-1.03,-2.31,9.14],['20/04/2026',1.8854,0.30,-0.79,-0.79,-2.08,9.60],
  ],
  'HMX': [
    ['30/04/2026',5.6120,0.66,3.15,3.15,7.42,41.20],['29/04/2026',5.5752,0.28,2.48,2.48,6.72,40.10],
    ['28/04/2026',5.5596,-0.36,2.19,2.19,6.42,39.62],['27/04/2026',5.5797,0.31,2.56,2.56,6.80,40.31],
    ['24/04/2026',5.5625,0.85,2.24,2.24,6.47,39.15],['23/04/2026',5.5157,-0.32,1.39,1.39,5.58,37.90],
    ['22/04/2026',5.5334,-0.36,1.71,1.71,5.92,38.44],['20/04/2026',5.5534,0.30,2.08,2.08,6.30,39.10],
  ],
};

// DRE — Orçado x Realizado por ano, por Modelo + Centro de Custo (valores negativos = resultado, em R$)
const DRE_YEAR = {
  'Caixa': {
    'FPG': { anos:['2023','2024','2025','2026'], orcado:[-11.2e6,-12.2e6,-8.0e6,-5.1e6], realizado:[-13.6e6,-12.8e6,-10.2e6,-7.5e6] },
    'HPG': { anos:['2023','2024','2025','2026'], orcado:[-6.4e6,-7.1e6,-5.2e6,-3.3e6], realizado:[-7.8e6,-7.9e6,-6.1e6,-4.4e6] },
  },
  'Competência': {
    'FPG': { anos:['2023','2024','2025','2026'], orcado:[-10.4e6,-11.6e6,-7.5e6,-4.8e6], realizado:[-12.1e6,-12.0e6,-9.4e6,-6.9e6] },
    'HPG': { anos:['2023','2024','2025','2026'], orcado:[-5.9e6,-6.7e6,-4.9e6,-3.0e6], realizado:[-7.0e6,-7.2e6,-5.6e6,-4.0e6] },
  },
};
// série YTD mensal (mock) — Orçado vs Realizado
const DRE_YTD_MONTHS = ['jan/25','fev/25','mar/25','abr/25','mai/25','jun/25','jul/25','ago/25','set/25','out/25','nov/25','dez/25','jan/26','fev/26','mar/26','abr/26'];
function dreYtdSeries(modelo,cc){
  const seed = (modelo==='Caixa'?1:1.12)*(cc==='FPG'?1:0.6);
  const orc=[], rea=[];
  const base=[-155,-232,-500,-682,-774,-559,-392,-416,-523,-479,-903,-1076,-724,-893,-986,-873];
  const rlz=[-336,-128,-277,-88,-147,-615,-1110,-330,-479,-375,-195,-748,-871,-1022,-937,-871];
  for(let i=0;i<DRE_YTD_MONTHS.length;i++){orc.push(Math.round(base[i]*seed*1000));rea.push(Math.round(rlz[i]*seed*1000));}
  return {orc,rea};
}

/* ------------------------------------------------------------- ECharts base */
function baseOpt(){
  return {
    backgroundColor:'transparent',
    textStyle:{fontFamily:'Fakt Pro, system-ui, sans-serif',color:C.ink2},
    grid:{left:56,right:22,top:34,bottom:38},
    tooltip:{trigger:'axis',backgroundColor:'#0b1f24',borderColor:C.line,textStyle:{color:C.ink},
      axisPointer:{lineStyle:{color:C.ink3},crossStyle:{color:C.ink3}}},
    legend:{textStyle:{color:C.ink2},top:2,icon:'roundRect',itemWidth:12,itemHeight:12},
  };
}
const axisCommon = {axisLine:{lineStyle:{color:C.line}},axisLabel:{color:C.ink3},splitLine:{lineStyle:{color:C.line}},axisTick:{show:false}};
const charts=[];
function mkChart(el,opt){const c=echarts.init(el,null,{renderer:'canvas'});c.setOption(opt);charts.push(c);return c;}
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
function clearCharts(){while(charts.length)charts.pop().dispose();}

/* ------------------------------------------------------------------- rotas */
const ICON = {
  home:'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  ind:'M3 3v18h18M7 15l3-4 3 3 5-7',
  dre:'M4 20V10M10 20V4M16 20v-7M22 20H2',
  fluxo:'M3 12h18M3 6h18M3 18h12',
  part:'M12 2a10 10 0 100 20 10 10 0 000-20zM12 12l7-4',
  plantel:'M4 20V8l8-5 8 5v12M9 20v-6h6v6',
  inad:'M12 3l9 4v6c0 5-4 8-9 9-5-1-9-4-9-9V7z M12 8v4M12 15h.01',
  proj:'M9 11l3 3 8-8M20 12v7H4V5h11'
};
const ROUTES = [
  {id:'', title:'Início', sub:'Hub de Planejamento & Controle', icon:'home', render:renderHome},
  {group:'Financeiro'},
  {id:'indicadores', title:'Indicadores Financeiros', sub:'Cotações e variações por fundo', icon:'ind', render:renderIndicadores},
  {id:'dre', title:'DRE — Orçado × Realizado', sub:'Comparativo orçado vs realizado', icon:'dre', render:renderDRE},
  {id:'fluxo-caixa', title:'Fluxo de Caixa', sub:'Em breve', icon:'fluxo', soon:true, render:soon},
  {id:'participacoes', title:'Participações', sub:'Em breve', icon:'part', soon:true, render:soon},
  {id:'plantel-vendas', title:'Plantel / Vendas HPG', sub:'Em breve', icon:'plantel', soon:true, render:soon},
  {group:'Controladoria'},
  {id:'inadimplencia', title:'Inadimplência', sub:'Acesso restrito · dado sensível', icon:'inad', pii:true, render:renderInad},
  {id:'projetos', title:'Projetos', sub:'Em breve · migrar do controle-de-projetos', icon:'proj', soon:true, render:soon},
];
const byId = id => ROUTES.find(r=>r.id===id) || ROUTES[0];

function buildNav(){
  const nav=document.getElementById('nav');
  nav.innerHTML='';
  for(const r of ROUTES){
    if(r.group){const l=document.createElement('div');l.className='nav-label';l.textContent=r.group;nav.appendChild(l);continue;}
    const a=document.createElement('a');
    a.href='#/'+r.id;
    a.className=(r.soon?'locked ':'')+'';
    a.innerHTML=`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[r.icon]}"/></svg><span>${r.title}</span>`
      +(r.pii?'<span class="badge">PII</span>':r.soon?'<span class="badge">soon</span>':'');
    nav.appendChild(a);
  }
}

function router(){
  clearCharts();
  const id=(location.hash.replace(/^#\/?/,'')||'');
  const r=byId(id);
  document.getElementById('pageTitle').textContent=r.title;
  document.getElementById('pageSub').textContent=r.sub;
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#/'+id));
  document.getElementById('content').innerHTML='';
  r.render(document.getElementById('content'));
  window.scrollTo(0,0);
}

/* --------------------------------------------------------------- páginas */
function renderHome(el){
  const cards = ROUTES.filter(r=>!r.group && r.id!=='').map(r=>{
    const tag = r.pii?'<span class="pill pii">PII</span>':r.soon?'<span class="pill soon">em breve</span>':'<span class="pill live">disponível</span>';
    return `<a class="card hover" href="#/${r.id}">
      <div class="card-title"><svg class="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${C.orange}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[r.icon]}"/></svg><h3 style="margin:0">${r.title}</h3></div>
      <div class="desc">${r.sub}</div><div style="margin-top:12px">${tag}</div></a>`;
  }).join('');
  el.innerHTML=`
    <div class="hero">
      <h1>Planejamento &amp; Controle</h1>
      <p>Hub central dos dashboards do P&amp;C da Luxor. Esta é a versão <b>offline de demonstração</b> — dados de exemplo, para validar a identidade visual e a navegação antes de plugar as fontes reais.</p>
    </div>
    <div class="banner">⚠ Versão offline · dados fictícios · sem login/backend. Só demonstração de UI.</div>
    <div class="section-label">Dashboards</div>
    <div class="grid g-3">${cards}</div>`;
}

function renderIndicadores(el){
  const funds=Object.keys(IND);
  el.innerHTML=`
    <div class="toolbar">
      <div class="field"><label>Fundo / Indicador</label>
        <select id="fund">${funds.map(f=>`<option>${f}</option>`).join('')}</select></div>
      <div class="field"><label>Período</label>
        <select id="per"><option>Últimos pregões</option><option>YTD</option><option>36 meses</option></select></div>
    </div>
    <div class="grid g-4" id="kpis" style="margin-bottom:16px"></div>
    <div class="card"><div class="card-title"><h2 id="chTitle">Cotação</h2></div><div id="chart" class="chart"></div></div>
    <div class="card" style="margin-top:16px"><div class="card-title"><h2>Histórico</h2></div>
      <div class="tbl-wrap"><table class="data"><thead><tr>
        <th>Data</th><th>Cotação</th><th>% Dia</th><th>% MTD</th><th>% QTD</th><th>% YTD</th><th>% 36M</th>
      </tr></thead><tbody id="rows"></tbody></table></div></div>`;
  const draw=()=>{
    const f=document.getElementById('fund').value;
    const rows=IND[f];
    document.getElementById('chTitle').textContent='Cotação — '+f;
    // KPIs (linha mais recente)
    const [,cota,dia,mtd,,ytd]=rows[0];
    document.getElementById('kpis').innerHTML=[
      ['Última cotação',fmt.num(cota),rows[0][0],''],
      ['% Dia',fmt.pct(dia),'',cls(dia)],
      ['% MTD',fmt.pct(mtd),'',cls(mtd)],
      ['% YTD',fmt.pct(ytd),'',cls(ytd)],
    ].map(([lab,val,sub,c])=>`<div class="card kpi"><div class="label">${lab}</div><div class="val ${c}">${val}</div><div class="delta">${sub||'&nbsp;'}</div></div>`).join('');
    // chart (ordem cronológica)
    const chrono=[...rows].reverse();
    mkChart(document.getElementById('chart'),Object.assign(baseOpt(),{
      legend:{show:false},grid:{left:56,right:22,top:18,bottom:38},
      xAxis:Object.assign({type:'category',data:chrono.map(r=>r[0]),boundaryGap:false},axisCommon),
      yAxis:Object.assign({type:'value',scale:true,axisLabel:{color:C.ink3,formatter:v=>v.toFixed(2)}},axisCommon),
      series:[{name:f,type:'line',smooth:true,symbol:'none',data:chrono.map(r=>r[1]),
        lineStyle:{color:C.orange,width:2.4},
        areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(255,164,0,.28)'},{offset:1,color:'rgba(255,164,0,0)'}])}}]
    }));
    // tabela
    document.getElementById('rows').innerHTML=rows.map(r=>`<tr>
      <td>${r[0]}</td><td>${fmt.num(r[1])}</td>
      <td class="${cls(r[2])}">${fmt.pct(r[2])}</td><td class="${cls(r[3])}">${fmt.pct(r[3])}</td>
      <td class="${cls(r[4])}">${fmt.pct(r[4])}</td><td class="${cls(r[5])}">${fmt.pct(r[5])}</td>
      <td class="${cls(r[6])}">${fmt.pct(r[6])}</td></tr>`).join('');
  };
  document.getElementById('fund').onchange=()=>{clearCharts();draw();};
  draw();
}

function renderDRE(el){
  el.innerHTML=`
    <div class="toolbar">
      <div class="field"><label>Modelo</label>
        <div class="seg" id="modelo"><button data-v="Caixa" class="on">Caixa</button><button data-v="Competência">Competência</button></div></div>
      <div class="field"><label>Centro de Custo</label>
        <div class="seg" id="cc"><button data-v="FPG" class="on">FPG</button><button data-v="HPG">HPG</button></div></div>
    </div>
    <div class="grid g-4" id="kpis" style="margin-bottom:16px"></div>
    <div class="card"><div class="card-title"><h2>Orçado × Realizado por ano</h2></div><div id="bar" class="chart"></div></div>
    <div class="card" style="margin-top:16px"><div class="card-title"><h2>Comparativo YTD (mensal)</h2></div><div id="ytd" class="chart"></div></div>`;
  const seg=(gid,cb)=>{const g=document.getElementById(gid);g.onclick=e=>{const b=e.target.closest('button');if(!b)return;g.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));cb();};};
  const draw=()=>{
    clearCharts();
    const modelo=document.querySelector('#modelo button.on').dataset.v;
    const cc=document.querySelector('#cc button.on').dataset.v;
    const d=DRE_YEAR[modelo][cc];
    const totO=d.orcado.reduce((a,b)=>a+b,0), totR=d.realizado.reduce((a,b)=>a+b,0);
    const desvio=totR-totO;
    document.getElementById('kpis').innerHTML=[
      ['Orçado (acum.)',fmt.mi(totO),'',''],
      ['Realizado (acum.)',fmt.mi(totR),'',''],
      ['Desvio',fmt.mi(desvio),'',cls(desvio)],
      ['Modelo · CC',modelo+' · '+cc,'',''],
    ].map(([lab,val,sub,c])=>`<div class="card kpi"><div class="label">${lab}</div><div class="val ${c}" style="font-size:22px">${val}</div><div class="delta">${sub||'&nbsp;'}</div></div>`).join('');
    mkChart(document.getElementById('bar'),Object.assign(baseOpt(),{
      xAxis:Object.assign({type:'category',data:d.anos},axisCommon),
      yAxis:Object.assign({type:'value',axisLabel:{color:C.ink3,formatter:v=>(v/1e6).toFixed(0)+' Mi'}},axisCommon),
      series:[
        {name:'Orçado',type:'bar',data:d.orcado,itemStyle:{color:C.teal,borderRadius:[3,3,0,0]},barMaxWidth:34,
         label:{show:true,position:'bottom',color:C.ink3,formatter:p=>fmt.mi(p.value)}},
        {name:'Realizado',type:'bar',data:d.realizado,itemStyle:{color:C.orange,borderRadius:[3,3,0,0]},barMaxWidth:34,
         label:{show:true,position:'bottom',color:C.ink3,formatter:p=>fmt.mi(p.value)}},
      ]
    }));
    const s=dreYtdSeries(modelo,cc);
    mkChart(document.getElementById('ytd'),Object.assign(baseOpt(),{
      xAxis:Object.assign({type:'category',data:DRE_YTD_MONTHS,boundaryGap:false},axisCommon),
      yAxis:Object.assign({type:'value',axisLabel:{color:C.ink3,formatter:v=>(v/1e6).toFixed(1)+' Mi'}},axisCommon),
      series:[
        {name:'Orçado',type:'line',smooth:true,symbol:'circle',symbolSize:5,data:s.orc,lineStyle:{color:C.teal,width:2},itemStyle:{color:C.teal}},
        {name:'Realizado',type:'line',smooth:true,symbol:'circle',symbolSize:5,data:s.rea,lineStyle:{color:C.orange,width:2},itemStyle:{color:C.orange}},
      ]
    }));
  };
  seg('modelo',draw); seg('cc',draw); draw();
}

function renderInad(el){
  el.innerHTML=`
    <div class="banner" style="background:rgba(229,103,78,.14);border-color:rgba(229,103,78,.4)">
      🔒 Dado pessoal (LGPD). No hub real, esta tela exige liberação do admin por usuário + auditoria de acesso. Aqui: só agregados fictícios.</div>
    <div class="grid g-4" style="margin-bottom:16px">
      ${[['Total em aberto','R$ 4,82 Mi',''],['Títulos vencidos','312','neg'],['Ticket médio','R$ 15,4 mil',''],['> 90 dias','R$ 1,10 Mi','neg']]
        .map(([l,v,c])=>`<div class="card kpi"><div class="label">${l}</div><div class="val ${c}" style="font-size:22px">${v}</div><div class="delta">&nbsp;</div></div>`).join('')}
    </div>
    <div class="grid g-2">
      <div class="card"><div class="card-title"><h2>Por faixa de atraso</h2></div><div id="faixa" class="chart"></div></div>
      <div class="card"><div class="card-title"><h2>Evolução do saldo em aberto</h2></div><div id="evol" class="chart"></div></div>
    </div>`;
  const faixas=['A vencer','Até 7d','8–30d','31–60d','61–90d','91–120d','121–180d','181–365d','+365d'];
  const vals=[1.9e6,.42e6,.55e6,.31e6,.26e6,.22e6,.18e6,.55e6,.43e6];
  mkChart(document.getElementById('faixa'),Object.assign(baseOpt(),{
    grid:{left:70,right:22,top:20,bottom:60},legend:{show:false},
    xAxis:Object.assign({type:'category',data:faixas,axisLabel:{color:C.ink3,rotate:35}},axisCommon),
    yAxis:Object.assign({type:'value',axisLabel:{color:C.ink3,formatter:v=>(v/1e6).toFixed(1)+'M'}},axisCommon),
    series:[{type:'bar',data:vals,itemStyle:{color:p=>p.dataIndex===0?C.teal:C.neg,borderRadius:[3,3,0,0]},barMaxWidth:30}]
  }));
  const meses=['nov','dez','jan','fev','mar','abr'];
  mkChart(document.getElementById('evol'),Object.assign(baseOpt(),{
    grid:{left:70,right:22,top:20,bottom:38},legend:{show:false},
    xAxis:Object.assign({type:'category',data:meses,boundaryGap:false},axisCommon),
    yAxis:Object.assign({type:'value',axisLabel:{color:C.ink3,formatter:v=>(v/1e6).toFixed(1)+'M'}},axisCommon),
    series:[{type:'line',smooth:true,symbol:'circle',symbolSize:6,data:[5.6e6,5.3e6,5.1e6,4.9e6,4.95e6,4.82e6],
      lineStyle:{color:C.orange,width:2.4},itemStyle:{color:C.orange},
      areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(255,164,0,.25)'},{offset:1,color:'rgba(255,164,0,0)'}])}}]
  }));
}

function soon(el){
  el.innerHTML=`<div class="empty"><div class="big">🚧</div>
    <div style="font-size:16px;color:var(--ink-2);margin-bottom:6px">Em construção</div>
    <div>Este dashboard entra numa próxima fase do hub.</div></div>`;
}

/* ------------------------------------------------------------------ init */
buildNav();
window.addEventListener('hashchange',router);
router();
