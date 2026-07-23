/* Luxor P&C Hub — app offline. Dados REAIS embutidos (window.IND_DATA, window.DRE_DATA). */
'use strict';

const C = {
  orange:'#FFA400', orangeDeep:'#E08E00', teal:'#2E97A6', tealDeep:'#1D6E79',
  ink:'#EAF4F4', ink2:'#A7C3C5', ink3:'#6E8C90', pos:'#46B678', neg:'#E5674E',
  warn:'#F2C14E', line:'rgba(255,255,255,.10)'
};
const fmt = {
  pct:v=>v==null?'—':(v>=0?'+':'')+v.toFixed(2).replace('.',',')+'%',
  num:(v,d=4)=>v==null?'—':v.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}),
  mi:v=>(v/1e6).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+' Mi',
  br:d=>{const[y,m,dd]=d.split('-');return dd+'/'+m+'/'+y;},
  mesano:d=>{const[y,m]=d.split('-');return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+m-1]+'/'+y.slice(2);}
};
const cls = v => v==null?'':v>=0?'pos':'neg';

/* ---- ECharts base ---- */
function baseOpt(){return {
  backgroundColor:'transparent',
  textStyle:{fontFamily:'Fakt Pro, system-ui, sans-serif',color:C.ink2},
  grid:{left:64,right:24,top:34,bottom:64},
  tooltip:{trigger:'axis',backgroundColor:'#0b1f24',borderColor:C.line,textStyle:{color:C.ink},
    axisPointer:{lineStyle:{color:C.ink3}}},
  legend:{textStyle:{color:C.ink2},top:2,icon:'roundRect',itemWidth:12,itemHeight:12},
};}
const axis = extra => Object.assign({axisLine:{lineStyle:{color:C.line}},axisLabel:{color:C.ink3},
  splitLine:{lineStyle:{color:C.line}},axisTick:{show:false}},extra||{});
function zoom(){return [
  {type:'inside',throttle:50},
  {type:'slider',height:22,bottom:16,borderColor:C.line,fillerColor:'rgba(255,164,0,.14)',
   handleStyle:{color:C.orange},moveHandleStyle:{color:C.orange},
   dataBackground:{lineStyle:{color:C.ink3},areaStyle:{color:'rgba(167,195,197,.15)'}},
   selectedDataBackground:{lineStyle:{color:C.orange},areaStyle:{color:'rgba(255,164,0,.25)'}},
   textStyle:{color:C.ink3},labelFormatter:''},
];}
const charts=[];
function mkChart(el,opt){const c=echarts.init(el,null,{renderer:'canvas'});c.setOption(opt);charts.push(c);return c;}
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
function clearCharts(){while(charts.length)charts.pop().dispose();}

/* ---- rotas ---- */
const ICON = {
  home:'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', ind:'M3 3v18h18M7 15l3-4 3 3 5-7',
  dre:'M4 20V10M10 20V4M16 20v-7M22 20H2', fluxo:'M3 12h18M3 6h18M3 18h12',
  part:'M12 2a10 10 0 100 20 10 10 0 000-20zM12 12l7-4', plantel:'M4 20V8l8-5 8 5v12M9 20v-6h6v6',
  inad:'M12 3l9 4v6c0 5-4 8-9 9-5-1-9-4-9-9V7z M12 8v4M12 15h.01', proj:'M9 11l3 3 8-8M20 12v7H4V5h11'
};
const ROUTES = [
  {id:'', title:'Início', sub:'Hub de Planejamento & Controle', icon:'home', render:renderHome},
  {id:'indicadores', title:'Indicadores Financeiros', sub:'Cotações e variações por índice', icon:'ind', render:renderIndicadores},
  {id:'dre', title:'DRE — Orçado × Realizado', sub:'Comparativo orçado vs realizado', icon:'dre', render:renderDRE},
  {id:'inadimplencia', title:'Controle de Inadimplência', sub:'', icon:'inad', render:renderInad},
  {id:'projetos', title:'Projetos', sub:'Controle de projetos de automação/BI', icon:'proj', render:renderProjetos},
];
const byId = id => ROUTES.find(r=>r.id===id) || ROUTES[0];

function buildNav(){
  const nav=document.getElementById('nav'); nav.innerHTML='';
  for(const r of ROUTES){
    const a=document.createElement('a'); a.href='#/'+r.id; a.className=r.soon?'locked':'';
    a.innerHTML=`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[r.icon]}"/></svg><span>${r.title}</span>`;
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
  const c=document.getElementById('content'); c.className='content'; c.innerHTML=''; r.render(c); window.scrollTo(0,0);
}

/* ---- helpers UI ---- */
function seg(id,opts,val,cb){
  return `<div class="seg" id="${id}">`+opts.map(o=>`<button data-v="${o}" class="${o===val?'on':''}">${o}</button>`).join('')+`</div>`;
}
function bindSeg(id,cb){const g=document.getElementById(id);g.onclick=e=>{const b=e.target.closest('button');if(!b)return;g.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));cb();};}
const segVal=id=>document.querySelector('#'+id+' button.on').dataset.v;

/* ---- Início ---- */
function renderHome(el){
  const cards=ROUTES.filter(r=>r.id).map(r=>{
    return `<a class="card hover" href="#/${r.id}">
      <div class="card-title"><svg class="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${C.orange}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[r.icon]}"/></svg><h3 style="margin:0">${r.title}</h3></div>
      <div class="desc">${r.sub}</div></a>`;
  }).join('');
  el.innerHTML=`<div class="hero"><h1>Planejamento &amp; Controle</h1>
    <p>Hub central dos dashboards do P&amp;C da Luxor. Versão <b>offline</b> — Indicadores e DRE já com <b>dados reais</b>; demais em migração.</p></div>
    <div class="grid g-3">${cards}</div>`;
}

/* ---- Indicadores Financeiros ---- */
function renderIndicadores(el){
  const D=window.IND_DATA;
  if(!D){el.innerHTML='<div class="empty">Dados não carregados. Rode <code>python tools/build_data.py</code>.</div>';return;}
  const inds=D.indices, def=inds.includes('Dólar')?'Dólar':inds[0];
  const fantasy=new Set(D.fantasy||[]);
  let zoomState=null;         // {start,end} preservado entre trocas de ticker
  el.innerHTML=`
    <div class="toolbar">
      <div class="field"><label>Índice / Fundo</label>
        <select id="ind">${inds.map(f=>`<option ${f===def?'selected':''}>${f}</option>`).join('')}</select></div>
    </div>
    <div class="grid g-4" id="kpis" style="margin-bottom:16px"></div>
    <div class="card">
      <div class="card-title"><h2 id="chTitle">Cotação</h2><span class="muted" id="fant"></span></div>
      <div id="measure" class="measure"></div>
      <div id="chart" class="chart tall"></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-title"><h2>Histórico</h2><span class="muted" id="rowCount"></span></div>
      <div class="tbl-wrap" style="max-height:520px"><table class="data"><thead><tr>
        <th>Data</th><th id="thCota">Cotação</th><th>% Dia</th><th>% MTD</th><th>% QTD</th><th>% YTD</th><th>% 36M</th>
      </tr></thead><tbody id="rows"></tbody></table></div></div>`;

  const measureBox=()=>document.getElementById('measure');
  function clearMeasure(chart){
    measureBox().innerHTML='<span class="hint">Clique e arraste sobre o gráfico para medir a variação do período.</span>';
    if(chart)chart.setOption({series:[{markArea:{data:[]}}]});
  }
  function showMeasure(chart,rows,a,b){
    const lo=Math.min(a,b),hi=Math.max(a,b),p0=rows[lo][1],p1=rows[hi][1],pct=(p1/p0-1)*100;
    measureBox().innerHTML=`<b>${fmt.br(rows[lo][0])} → ${fmt.br(rows[hi][0])}</b>`
      +` · Variação <b class="${cls(pct)}">${fmt.pct(pct)}</b>`
      +` · ${fmt.num(p0)} → ${fmt.num(p1)}`;
    chart.setOption({series:[{markArea:{silent:true,itemStyle:{color:'rgba(255,164,0,.14)'},
      data:[[{xAxis:rows[lo][0]},{xAxis:rows[hi][0]}]]}}]});
  }

  const draw=()=>{
    clearCharts();
    const f=document.getElementById('ind').value;
    const rows=D.rows[f]; // [data,px,dia,mtd,qtr,ytd,m36] asc
    const fant=fantasy.has(f);
    document.getElementById('chTitle').textContent=(fant?'Índice (base 100) — ':'Cotação — ')+f;
    document.getElementById('fant').textContent=fant?'cotação sintética (sem preço de mercado)':'';
    document.getElementById('thCota').textContent=fant?'Índice':'Cotação';
    document.getElementById('rowCount').textContent=rows.length+' pontos · '+fmt.br(rows[0][0])+' a '+fmt.br(rows[rows.length-1][0]);
    const last=rows[rows.length-1];
    document.getElementById('kpis').innerHTML=[
      [fant?'Último índice':'Última cotação',fmt.num(last[1]),fmt.br(last[0]),''],
      ['% Dia',fmt.pct(last[2]),'',cls(last[2])],
      ['% MTD',fmt.pct(last[3]),'',cls(last[3])],
      ['% YTD',fmt.pct(last[5]),'',cls(last[5])],
    ].map(([l,v,s,c])=>`<div class="card kpi"><div class="label">${l}</div><div class="val ${c}">${v}</div><div class="delta">${s||'&nbsp;'}</div></div>`).join('');
    const s0 = zoomState? zoomState.start : (rows.length>180?(1-180/rows.length)*100:0);
    const e0 = zoomState? zoomState.end : 100;
    const chart=mkChart(document.getElementById('chart'),Object.assign(baseOpt(),{
      legend:{show:false},grid:{left:64,right:24,top:18,bottom:64},
      dataZoom:zoom().map(z=>Object.assign(z,{start:s0,end:e0})),
      xAxis:axis({type:'category',data:rows.map(r=>r[0]),boundaryGap:false,axisLabel:{color:C.ink3,formatter:v=>fmt.br(v)}}),
      yAxis:axis({type:'value',scale:true,axisLabel:{color:C.ink3,formatter:v=>v.toFixed(2)}}),
      series:[{name:f,type:'line',smooth:true,symbol:'none',data:rows.map(r=>r[1]),
        lineStyle:{color:C.orange,width:2.2},
        areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(255,164,0,.26)'},{offset:1,color:'rgba(255,164,0,0)'}])}}]
    }));
    chart.on('dataZoom',()=>{const dz=chart.getOption().dataZoom[0];zoomState={start:dz.start,end:dz.end};});
    // medir variação arrastando (estilo Google Finance)
    const zr=chart.getZr(); let measuring=false,startIdx=null;
    const idxAt=e=>{const x=e.offsetX,y=e.offsetY;
      if(!chart.containPixel({gridIndex:0},[x,y]))return null;
      let i=Math.round(chart.convertFromPixel({xAxisIndex:0},x));
      return Math.max(0,Math.min(rows.length-1,i));};
    zr.on('mousedown',e=>{const i=idxAt(e);if(i==null)return;measuring=true;startIdx=i;});
    zr.on('mousemove',e=>{if(!measuring)return;const j=idxAt(e);if(j!=null)showMeasure(chart,rows,startIdx,j);});
    zr.on('mouseup',e=>{if(!measuring)return;measuring=false;const j=idxAt(e);
      if(j!=null&&j!==startIdx)showMeasure(chart,rows,startIdx,j);else clearMeasure(chart);});
    clearMeasure(chart);

    document.getElementById('rows').innerHTML=[...rows].reverse().map(r=>`<tr>
      <td>${fmt.br(r[0])}</td><td>${fmt.num(r[1])}</td>
      <td class="${cls(r[2])}">${fmt.pct(r[2])}</td><td class="${cls(r[3])}">${fmt.pct(r[3])}</td>
      <td class="${cls(r[4])}">${fmt.pct(r[4])}</td><td class="${cls(r[5])}">${fmt.pct(r[5])}</td>
      <td class="${cls(r[6])}">${fmt.pct(r[6])}</td></tr>`).join('');
  };
  document.getElementById('ind').onchange=draw;
  draw();
}

/* ---- DRE ---- */
function renderDRE(el){
  const D=window.DRE_DATA;
  if(!D){el.innerHTML='<div class="empty">Dados não carregados. Rode <code>python tools/build_data.py</code>.</div>';return;}
  const leafSet=new Set(D.naturezas.filter(n=>!n[1]).map(n=>n[0]));
  const NAT_ALL='Todas (líquido)';
  const accOpts=['Todos',...D.acumulados];
  const defModelo=D.modelos.includes('Caixa')?'Caixa':D.modelos[0];
  const defCC=D.centros.includes('HPG')?'HPG':D.centros[0];
  let natMode='leaf';               // 'leaf' = todas (líquido) | 'set' = selecionadas
  const natSel=new Set();
  el.innerHTML=`
    <div class="toolbar">
      <div class="field"><label>Modelo</label>${seg('modelo',D.modelos,defModelo)}</div>
      <div class="field"><label>Centro de Custo</label>${seg('cc',D.centros,defCC)}</div>
      <div class="field"><label>Acumulado</label>
        <select id="acc">${accOpts.map(a=>`<option ${a==='Todos'?'selected':''}>${a}</option>`).join('')}</select></div>
      <div class="field" style="flex:1;min-width:260px"><label>Natureza (múltipla)</label>
        <div class="ms" id="natMs">
          <button type="button" class="ms-btn" id="natBtn"><span class="ms-txt">${NAT_ALL}</span></button>
          <div class="ms-panel" id="natPanel" hidden>
            <div class="ms-head">
              <input type="search" class="ms-search" id="natSearch" placeholder="buscar natureza…">
              <button type="button" class="ms-clear" id="natClear">Limpar</button>
            </div>
            <label class="ms-all"><input type="checkbox" id="natAll" checked> ${NAT_ALL}</label>
            <div class="ms-list" id="natList"></div>
          </div>
        </div></div>
    </div>
    <div class="ms-chips" id="natChips"></div>
    <div class="grid g-3" id="kpis" style="margin-bottom:16px"></div>
    <div class="card"><div class="card-title"><h2>Orçado × Realizado por ano</h2><span class="muted" id="barSub"></span></div><div id="bar" class="chart"></div></div>
    <div class="card" style="margin-top:16px"><div class="card-title"><h2>Comparativo Orçado × Realizado (mensal)</h2><span class="muted">arraste para ajustar período</span></div><div id="line" class="chart tall"></div></div>`;

  // ---- multi-select natureza (chips + limpar) ----
  const natList=document.getElementById('natList'), natBtn=document.getElementById('natBtn');
  const natPanel=document.getElementById('natPanel'), natAll=document.getElementById('natAll');
  const natChips=document.getElementById('natChips'), natTxt=natBtn.querySelector('.ms-txt');
  const cbByName={};
  D.naturezas.forEach(n=>{
    const lab=document.createElement('label');
    const cb=document.createElement('input'); cb.type='checkbox'; cb.value=n[0]; cbByName[n[0]]=cb;
    const txt=document.createElement('span'); txt.className='ms-name'; txt.textContent=n[0];
    lab.appendChild(cb); lab.appendChild(txt);
    if(n[1]){const s=document.createElement('span');s.className='ms-sub';s.textContent='subtotal';lab.appendChild(s);}
    cb.addEventListener('change',()=>{ if(cb.checked)natSel.add(cb.value); else natSel.delete(cb.value); refreshNat(); });
    natList.appendChild(lab);
  });
  function refreshNat(){
    natMode = natSel.size ? 'set' : 'leaf';
    natAll.checked = natSel.size===0;
    natTxt.textContent = natMode==='leaf' ? NAT_ALL : `${natSel.size} selecionada${natSel.size>1?'s':''}`;
    natChips.innerHTML='';
    [...natSel].forEach(name=>{
      const chip=document.createElement('span'); chip.className='chip-sel';
      const s=document.createElement('span'); s.textContent=name; s.title=name; chip.appendChild(s);
      const x=document.createElement('button'); x.type='button'; x.className='chip-x'; x.textContent='×'; x.title='remover';
      x.onclick=()=>{ natSel.delete(name); if(cbByName[name])cbByName[name].checked=false; refreshNat(); };
      chip.appendChild(x); natChips.appendChild(chip);
    });
    draw();
  }
  function clearNat(){ natSel.clear(); natList.querySelectorAll('input').forEach(c=>c.checked=false); refreshNat(); }
  natAll.addEventListener('change',()=>{ if(natAll.checked)clearNat(); else if(natSel.size===0)natAll.checked=true; });
  document.getElementById('natClear').onclick=clearNat;
  natBtn.onclick=()=>{natPanel.hidden=!natPanel.hidden;};
  document.getElementById('natSearch').addEventListener('input',e=>{
    const q=e.target.value.toLowerCase();
    natList.querySelectorAll('label').forEach(l=>{l.style.display=l.textContent.toLowerCase().includes(q)?'':'none';});
  });
  document.addEventListener('click',e=>{if(!document.getElementById('natMs').contains(e.target))natPanel.hidden=true;});

  const draw=()=>{
    clearCharts();
    const m=segVal('modelo'), cc=segVal('cc'), acc=document.getElementById('acc').value;
    const natOk = r => natMode==='leaf' ? leafSet.has(r) : natSel.has(r);
    // barras (ytd): [modelo,cc,acumulado,natureza,ano,cenario,valor]
    const anos=D.anos, byAno={}; anos.forEach(a=>byAno[a]={'Orçado':0,'Realizado':0});
    for(const r of D.ytd.rows){
      if(r[0]!==m||r[1]!==cc)continue;
      if(acc!=='Todos'&&r[2]!==acc)continue;
      if(!natOk(r[3]))continue;
      if(byAno[r[4]])byAno[r[4]][r[5]]+=r[6];
    }
    const orc=anos.map(a=>byAno[a]['Orçado']), rea=anos.map(a=>byAno[a]['Realizado']);
    const totO=orc.reduce((a,b)=>a+b,0), totR=rea.reduce((a,b)=>a+b,0), dev=totR-totO;
    const natDesc = natMode==='leaf'?'líquido':(natSel.size===1?[...natSel][0]:`${natSel.size} naturezas`);
    document.getElementById('barSub').textContent=`${m} · ${cc} · ${acc} · ${natDesc}`;
    document.getElementById('kpis').innerHTML=[
      ['Orçado (acum.)',fmt.mi(totO),''],['Realizado (acum.)',fmt.mi(totR),''],['Desvio (Real − Orç)',fmt.mi(dev),cls(dev)],
    ].map(([l,v,c])=>`<div class="card kpi"><div class="label">${l}</div><div class="val ${c}" style="font-size:22px">${v}</div><div class="delta">&nbsp;</div></div>`).join('');
    mkChart(document.getElementById('bar'),Object.assign(baseOpt(),{
      grid:{left:64,right:24,top:34,bottom:34},
      xAxis:axis({type:'category',data:anos}),
      yAxis:axis({type:'value',axisLabel:{color:C.ink3,formatter:v=>(v/1e6).toFixed(0)+' Mi'}}),
      series:[
        {name:'Orçado',type:'bar',data:orc,itemStyle:{color:C.teal,borderRadius:[3,3,0,0]},barMaxWidth:38,label:{show:true,position:'top',color:C.ink3,formatter:p=>fmt.mi(p.value)}},
        {name:'Realizado',type:'bar',data:rea,itemStyle:{color:C.orange,borderRadius:[3,3,0,0]},barMaxWidth:38,label:{show:true,position:'top',color:C.ink3,formatter:p=>fmt.mi(p.value)}},
      ]
    }));
    // linha (geral): [modelo,cc,natureza,data,orcado,realizado]
    const map=new Map();
    for(const r of D.geral.rows){
      if(r[0]!==m||r[1]!==cc)continue; if(!natOk(r[2]))continue;
      const k=r[3]; const o=map.get(k)||[0,0]; o[0]+=r[4]; o[1]+=r[5]; map.set(k,o);
    }
    const datas=[...map.keys()].sort();
    mkChart(document.getElementById('line'),Object.assign(baseOpt(),{
      dataZoom:zoom(),
      xAxis:axis({type:'category',data:datas,boundaryGap:false,axisLabel:{color:C.ink3,formatter:fmt.mesano}}),
      yAxis:axis({type:'value',axisLabel:{color:C.ink3,formatter:v=>(v/1e6).toFixed(1)+' Mi'}}),
      series:[
        {name:'Orçado',type:'line',smooth:true,symbol:'none',data:datas.map(d=>map.get(d)[0]),lineStyle:{color:C.teal,width:2},itemStyle:{color:C.teal}},
        {name:'Realizado',type:'line',smooth:true,symbol:'none',data:datas.map(d=>map.get(d)[1]),lineStyle:{color:C.orange,width:2.2},itemStyle:{color:C.orange}},
      ]
    }));
  };
  bindSeg('modelo',draw); bindSeg('cc',draw);
  document.getElementById('acc').onchange=draw;
  draw();
}

/* ---- Inadimplência (dashboard real re-skin Luxor, via iframe) ---- */
function renderInad(el){
  el.classList.add('flush');
  el.innerHTML=`<iframe class="embed" src="assets/inadimplencia/dashboard.html" title="Dashboard de Inadimplência"></iframe>`;
}

/* ---- Projetos (app real controle-de-projetos, via iframe) ---- */
function renderProjetos(el){
  el.classList.add('flush');
  el.innerHTML=`<iframe class="embed" src="assets/projetos/index.html" title="Controle de Projetos"></iframe>`;
}

/* ---- sidebar recolhível ---- */
(function collapse(){
  const btn=document.getElementById('collapseBtn'), app=document.querySelector('.app');
  if(localStorage.getItem('pc-collapsed')==='1')app.classList.add('collapsed');
  btn.onclick=()=>{app.classList.toggle('collapsed');
    localStorage.setItem('pc-collapsed',app.classList.contains('collapsed')?'1':'0');
    charts.forEach(c=>c.resize());};
})();

buildNav();
window.addEventListener('hashchange',router);
router();
