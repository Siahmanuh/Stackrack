(function(){
  "use strict";

  const API = 'api.php';

  let budgets        = [];
  let selectedId     = null;
  let unlockedAch    = new Set();

  // ---- API --------------------------------------------------------
  async function apiFetch(action, body = null) {
    const opts = body
      ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action,...body}) }
      : { method:'GET' };
    const res  = await fetch(API, opts);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    return data;
  }

  async function loadBudgets() {
    const data = await apiFetch();
    budgets    = data.budgets || [];
    if (budgets.length && !budgets.find(b => b.id === selectedId)) {
      selectedId = budgets[0].id;
    }
  }

  // ---- Helpers ----------------------------------------------------
  const money      = n  => { const v=Number(n)||0; return (v<0?"-":"")+"$"+Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,","); };
  const esc        = s  => { const d=document.createElement("div"); d.textContent=String(s); return d.innerHTML; };
  const spentOf    = b  => b.spendHistory.reduce((s,t)=>s+Number(t.amount),0);
  const activeB    = () => budgets.filter(b=>!b.checked);
  const selectedB  = () => budgets.find(b=>b.id===selectedId) || null;
  const lifetimeSpent = () => budgets.reduce((s,b)=>s+spentOf(b),0);

  // ---- Budget selector --------------------------------------------
  function renderSelector() {
    const el = document.getElementById("budgetSelector");
    if (!el) return;
    el.innerHTML = '<option value="">-- Select a budget --</option>' +
      budgets.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');
    if (selectedId && budgets.some(b=>b.id===selectedId)) {
      el.value = selectedId;
    } else if (budgets.length) {
      el.value  = budgets[0].id;
      selectedId = budgets[0].id;
    } else {
      el.value  = "";
      selectedId = null;
    }
  }

  // ---- Totals — scoped to selected budget -------------------------
  function renderTotals() {
    const sel     = selectedB();
    const has     = !!sel;
    const spent   = has ? spentOf(sel)            : 0;
    const budgeted= has ? Number(sel.limit)        : 0;
    const remain  = budgeted - spent;

    [['totalSpent',spent,false],['totalBudgeted',budgeted,false],['totalRemaining',remain,true]]
      .forEach(([id,val,isRemain],i)=>{
        const card = document.querySelectorAll(".total-card")[i];
        const body = card.querySelector(".card-body");
        const el   = document.getElementById(id);
        body.style.display = has ? "none"  : "flex";
        el.style.display   = has ? "block" : "none";
        el.textContent     = money(val);
        if (isRemain) { el.classList.toggle("neg",val<0); el.classList.toggle("pos",val>=0); }
      });
  }

  // ---- Budget list ------------------------------------------------
  function renderBudgets() {
    const list = document.getElementById("budgetList");
    if (!budgets.length) {
      list.innerHTML = '<div class="budget-empty-note">No budgets yet.</div>';
      return;
    }
    list.innerHTML = budgets.map(b => {
      const s   = spentOf(b);
      const pct = b.limit>0 ? Math.min(s/b.limit*100,100) : 0;
      const over= !b.checked && s>b.limit;
      const sel = b.id===selectedId;
      return `
<div class="budget-row${b.checked?" checked":""}${sel?" selected":""}" data-id="${b.id}">
  <input type="checkbox" class="row-check" data-action="check" data-id="${b.id}"${b.checked?" checked":""}>
  <span class="budget-row-name" data-action="select" data-id="${b.id}">${esc(b.name)}</span>
  <div class="budget-row-bar-wrap">
    <div class="bar-track"><div class="bar-fill${over?" over":""}" style="width:${pct}%"></div></div>
    <div class="bar-sub">${money(s)} / ${money(b.limit)}${over?` <span class="over-tag">over ${money(s-b.limit)}</span>`:""}</div>
  </div>
  <div class="row-spend-wrap">
    <input type="number" class="spend-input" data-id="${b.id}" placeholder="$" min="0" step="0.01">
    <button class="spend-btn" data-action="spend" data-id="${b.id}">+</button>
  </div>
  <button class="remove-btn" data-action="remove" data-id="${b.id}">×</button>
</div>`;
    }).join("");
  }

  // ---- Graph — per selected budget, transactions over time --------
  function renderGraph() {
    const area  = document.getElementById("graphArea");
    const empty = document.getElementById("graphEmpty");
    const old   = area.querySelector("svg.graph-svg");
    if (old) old.remove();

    const b = selectedB();
    if (!b || !b.spendHistory.length) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    const W=area.offsetWidth||280, H=area.offsetHeight||180, pad=18;
    const history = b.spendHistory;
    const limit   = Number(b.limit) || 1;
    const amounts = history.map(t=>Number(t.amount));
    const yMax    = Math.max(...amounts, limit) * 1.1 || 1;

    const pts = amounts.map((amt,i)=>({
      x:   pad+(i/Math.max(amounts.length-1,1))*(W-pad*2),
      y:   (H-pad)-(amt/yMax)*(H-pad*2),
      amt
    }));
    if (pts.length===1) { pts.unshift({x:pad,y:pts[0].y,amt:pts[0].amt}); }

    const ns  = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns,"svg");
    svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
    svg.setAttribute("width","100%"); svg.setAttribute("height","100%");
    svg.classList.add("graph-svg");
    svg.style.cssText="position:absolute;top:0;left:0;";

    // Baseline
    const baseline = document.createElementNS(ns,"line");
    baseline.setAttribute("x1",pad); baseline.setAttribute("y1",H-pad);
    baseline.setAttribute("x2",W-pad); baseline.setAttribute("y2",H-pad);
    baseline.setAttribute("stroke","#5b8ecf22"); baseline.setAttribute("stroke-width","1");
    baseline.setAttribute("stroke-dasharray","4,4");
    svg.appendChild(baseline);

    // Budget limit line
    const limitY   = (H-pad)-(limit/yMax)*(H-pad*2);
    const limitLine= document.createElementNS(ns,"line");
    limitLine.setAttribute("x1",pad); limitLine.setAttribute("y1",limitY);
    limitLine.setAttribute("x2",W-pad); limitLine.setAttribute("y2",limitY);
    limitLine.setAttribute("stroke","#c49ab855"); limitLine.setAttribute("stroke-width","1.5");
    limitLine.setAttribute("stroke-dasharray","6,4");
    svg.appendChild(limitLine);

    // Fill under line
    const fillPts = [{x:pts[0].x,y:H-pad},...pts,{x:pts[pts.length-1].x,y:H-pad}];
    const fill    = document.createElementNS(ns,"path");
    fill.setAttribute("d", fillPts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
    fill.setAttribute("fill","#7eadcf22");
    svg.appendChild(fill);

    // Spend line
    const path = document.createElementNS(ns,"path");
    path.setAttribute("d", pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
    path.setAttribute("fill","none"); path.setAttribute("stroke","#7eadcf"); path.setAttribute("stroke-width","2");
    svg.appendChild(path);

    // Dots with tooltips
    pts.forEach(p=>{
      const c = document.createElementNS(ns,"circle");
      c.setAttribute("cx",p.x); c.setAttribute("cy",p.y);
      c.setAttribute("r","4"); c.setAttribute("fill","#7eadcf");
      c.setAttribute("cursor","default");
      const title = document.createElementNS(ns,"title");
      title.textContent = money(p.amt);
      c.appendChild(title);
      svg.appendChild(c);
    });

    area.appendChild(svg);
  }

  // ---- Achievements -----------------------------------------------
  const ACH_DEFS = [
    { id:"spent_100",    label:"Spent $100",        icon:"💵", check:()=>lifetimeSpent()>=100   },
    { id:"spent_500",    label:"Spent $500",        icon:"💴", check:()=>lifetimeSpent()>=500   },
    { id:"spent_1k",     label:"Spent $1,000",      icon:"💳", check:()=>lifetimeSpent()>=1000  },
    { id:"spent_2500",   label:"Spent $2,500",      icon:"💰", check:()=>lifetimeSpent()>=2500  },
    { id:"spent_5k",     label:"Spent $5,000",      icon:"🏦", check:()=>lifetimeSpent()>=5000  },
    { id:"spent_10k",    label:"Spent $10,000",     icon:"🤑", check:()=>lifetimeSpent()>=10000 },
    { id:"first_budget", label:"First budget",      icon:"📋", check:()=>budgets.length>=1      },
    { id:"all_checked",  label:"All done",          icon:"✅", check:()=>budgets.length>0 && budgets.every(b=>b.checked) },
    { id:"under_limit",  label:"Under every limit", icon:"🎯", check:()=>budgets.length>0 && activeB().every(b=>spentOf(b)<=b.limit) },
  ];

  function renderAchievements() {
    ACH_DEFS.forEach(a=>{ if(a.check()) unlockedAch.add(a.id); });
    const earned = ACH_DEFS.filter(a=>unlockedAch.has(a.id));
    const row    = document.getElementById("achievementsRow");
    row.innerHTML = earned.length
      ? earned.map(a=>`<div class="ach-badge earned" title="${a.label}">${a.icon}</div>`).join("")
      : '<span class="ach-none">None yet.</span>';
  }

  // ---- Master render ----------------------------------------------
  function renderAll() {
    renderSelector();
    renderTotals();
    renderBudgets();
    renderGraph();
    renderAchievements();
  }

  // ---- Events -----------------------------------------------------
  document.getElementById("budgetForm").addEventListener("submit", async function(e) {
    e.preventDefault();
    const name  = document.getElementById("budgetName").value.trim();
    const limit = parseFloat(document.getElementById("budgetLimit").value);
    const date  = document.getElementById("budgetDate").value.trim(); // optional
    if (!name || isNaN(limit) || limit <= 0) return;

    let data;
    try {
      data = await apiFetch('add_budget', {name, limit, date: date || null});
    } catch(err) {
      console.error('add_budget failed:', err.message);
      alert('Could not save budget: ' + err.message);
      return;
    }
    budgets.push({id: data.id, name, limit, date_label: date || null, checked: false, spendHistory: []});
    if (!selectedId) selectedId = data.id;
    this.reset();
    renderAll();
  });

  document.getElementById("budgetSelector")?.addEventListener("change", function() {
    selectedId = this.value || null;
    renderAll();
  });

  document.getElementById("budgetList").addEventListener("click", async function(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const b      = budgets.find(x => x.id === btn.dataset.id);

    if (action === "select") {
      selectedId = btn.dataset.id;
      renderAll();
      return;
    }

    if (action === "spend") {
      const inp = document.querySelector(`.spend-input[data-id="${btn.dataset.id}"]`);
      const amt = parseFloat(inp?.value);
      if (!b || isNaN(amt) || amt <= 0) return;
      try {
        await apiFetch('add_spend', {budget_id: b.id, amount: amt});
        b.spendHistory.push({amount: amt, timestamp: Date.now()});
        inp.value = "";
        renderAll();
      } catch(err) {
        console.error('add_spend failed:', err.message);
        alert('Could not save spend: ' + err.message);
      }
      return;
    }

    if (action === "remove") {
      if (!b) return;
      try {
        await apiFetch('remove_budget', {budget_id: b.id});
        budgets = budgets.filter(x => x.id !== b.id);
        if (selectedId === b.id) selectedId = budgets.length ? budgets[0].id : null;
        renderAll();
      } catch(err) {
        console.error('remove_budget failed:', err.message);
        alert('Could not remove budget: ' + err.message);
      }
      return;
    }
  });

  document.getElementById("budgetList").addEventListener("change", async function(e) {
    const el = e.target.closest("[data-action='check']");
    if (!el) return;
    const b = budgets.find(x => x.id === el.dataset.id);
    if (!b) return;
    b.checked = el.checked;
    try {
      await apiFetch('set_checked', {budget_id: b.id, checked: b.checked});
      renderAll();
    } catch(err) {
      console.error('set_checked failed:', err.message);
      b.checked = !b.checked; // revert
      renderAll();
    }
  });

  // ---- Init -------------------------------------------------------
  loadBudgets().then(renderAll).catch(e=>console.error('Load failed:',e));

})();