/* app.js — Supplier Tracker (split files, hard-coded config in HTML) */
(function(){
  const $ = (id)=>document.getElementById(id);
  const authError = $('authError');
  const showErr = (t)=>{ if(!authError) return; authError.textContent=t||''; authError.classList.remove('hidden'); };
  const hideErr = ()=>{ if(!authError) return; authError.textContent=''; authError.classList.add('hidden'); };

  if (!window.supabase){ showErr('Supabase JS not loaded.'); return; }
  if (!window.__SUPABASE_URL__ || !window.__SUPABASE_ANON_KEY__){
    showErr('Missing Supabase keys. Paste them in BOTH index.html + orderpage.html hard-coded config.');
    return;
  }

  const supa = window.supabase.createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON_KEY__);
  const BUCKET = window.__ATTACHMENTS_BUCKET__ || 'order_attachments';

  const userChip = $('userChip');
  const btnLogout = $('btnLogout');
  const btnRefresh = $('btnRefresh');
  const orderList = $('orderList');
  const countLabel = $('countLabel');

  const form = $('orderForm');
  const formTitle = $('formTitle');
  const formMsg = $('formMsg');
  const btnClear = $('btnClear');
  const btnSave = $('btnSave');

  const inputCustomer = $('customer_name');
  const inputFb = $('fb_profile');
  const inputDetails = $('order_details');
  const inputAttach = $('attachment');
  const inputStatus = $('status');
  const inputDate = $('order_date');
  const inputDelivery = $('delivery_method');
  const inputPaidProd = $('paid_product');
  const inputPaidShip = $('paid_shipping');
  const inputNotes = $('notes');

  const search = $('search');
  const statusFilter = $('statusFilter');
  const dateFilter = $('dateFilter');
  const tabs = document.querySelectorAll('#tabs .tab');

  const adminDash = $('adminOnlyDashboard');
  const kpiTotal = $('kpiTotal');
  const kpiPaid = $('kpiPaid');
  const kpiPending = $('kpiPending');

  let orders = [];
  let editingId = null;
  let activeTab = 'all';

  const money = (n)=>'₱'+Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});

  const todayYMD = ()=>{
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const sumNum = (arr, key)=>arr.reduce((acc,o)=>acc + Number(o?.[key]||0), 0);

  function statusCounts(list){
    const acc = { pending:0, processing:0, shipped:0, delivered:0, cancelled:0 };
    for (const o of list){
      const s = String(o.status||'pending').toLowerCase();
      if (acc[s] !== undefined) acc[s] += 1;
    }
    return acc;
  }

  function groupByDate(list){
    const map = new Map(); // date -> {count, customers:Set, prod, ship}
    for (const o of list){
      const d = o.order_date || null;
      if (!d) continue;
      if (!map.has(d)){
        map.set(d, { count:0, customers:new Set(), prod:0, ship:0 });
      }
      const row = map.get(d);
      row.count += 1;
      row.customers.add(String(o.customer_name||'').trim().toLowerCase());
      row.prod += Number(o.paid_product||0);
      row.ship += Number(o.paid_shipping||0);
    }
    return map;
  }


  async function ensureSession(){
    hideErr();
    const { data: { session }, error } = await supa.auth.getSession();
    if (error){ showErr(error.message); return null; }
    if (!session){ location.replace('./index.html'); return null; }

    const email = session.user?.email || 'Logged in';
    if (userChip) userChip.textContent = email;

    const allow = Array.isArray(window.__ADMIN_EMAILS__) ? window.__ADMIN_EMAILS__ : [];
    const isAdmin = allow.map(x=>String(x).toLowerCase()).includes(String(email).toLowerCase());
    if (adminDash) adminDash.classList.toggle('hidden', !isAdmin);

    return session;
  }

  async function logout(){
    await supa.auth.signOut();
    location.replace('./index.html');
  }

  function handleDeliveryChange(){
    if (!inputDelivery || !inputPaidShip) return;
    if (inputDelivery.value === 'walkin'){
      inputPaidShip.value = '0';
      inputPaidShip.disabled = true;
    } else {
      inputPaidShip.disabled = false;
    }
  }

  function resetForm(){
    editingId = null;
    if (formTitle) formTitle.textContent = 'New Order';
    form.reset();
    if (inputStatus) inputStatus.value = 'pending';
    if (inputDelivery) inputDelivery.value = 'jnt';
    handleDeliveryChange();
    if (formMsg) formMsg.textContent = '—';
  }

  async function uploadAttachment(file){
    if (!file) return null;
    const ext = (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
    const path = `orders/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;
    const { error } = await supa.storage.from(BUCKET).upload(path, file, {
      cacheControl:'3600',
      upsert:false,
      contentType:file.type||'image/jpeg'
    });
    if (error) throw error;

    const { data } = supa.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || path;
  }

  async function loadOrders(){
    if (!await ensureSession()) return;

    const { data, error } = await supa
      .from('orders')
      .select('*')
      .order('last_updated', { ascending:false });

    if (error){
      showErr('Failed to load orders: ' + (error.message||error));
      return;
    }

    orders = Array.isArray(data) ? data : [];
    rebuildDateOptions();
    render();
  }

  function rebuildDateOptions(){
    if (!dateFilter) return;
    const current = dateFilter.value || 'all';
    const set = new Set();
    for (const o of orders){ if (o.order_date) set.add(o.order_date); }
    const sorted = Array.from(set).sort((a,b)=>String(b).localeCompare(String(a)));
    dateFilter.innerHTML =
      '<option value="all">All Dates</option>' +
      sorted.map(d=>`<option value="${d}">${d}</option>`).join('');
    dateFilter.value = sorted.includes(current) ? current : 'all';
  }

  function filtered(){
    const q = (search?.value||'').trim().toLowerCase();
    const st = statusFilter?.value || 'all';
    const dt = dateFilter?.value || 'all';

    return orders.filter(o=>{
      if (activeTab !== 'all' && String(o.delivery_method||'').toLowerCase() !== activeTab) return false;
      if (st !== 'all' && String(o.status||'').toLowerCase() !== st) return false;
      if (dt !== 'all' && String(o.order_date||'') !== dt) return false;
      if (!q) return true;
      const hay = [o.order_id,o.customer_name,o.fb_profile,o.order_details,o.notes]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  
  function renderKPIs(){
    // Total orders
    if (kpiTotal) kpiTotal.textContent = String(orders.length);

    // Revenue breakdown
    const product = sumNum(orders, 'paid_product');
    const ship = sumNum(orders, 'paid_shipping');
    const total = product + ship;

    const kpiProductRev = document.getElementById('kpiProductRev');
    const kpiShipRev = document.getElementById('kpiShipRev');
    const kpiTotalRev = document.getElementById('kpiTotalRev');

    if (kpiProductRev) kpiProductRev.textContent = money(product);
    if (kpiShipRev) kpiShipRev.textContent = money(ship);
    if (kpiTotalRev) kpiTotalRev.textContent = money(total);

    // Today metrics (based on order_date)
    const t = todayYMD();
    const todayOrders = orders.filter(o=>String(o.order_date||'') === t);

    const kpiOrdersToday = document.getElementById('kpiOrdersToday');
    const kpiCustomersToday = document.getElementById('kpiCustomersToday');
    const kpiRevenueToday = document.getElementById('kpiRevenueToday');

    const uniqCustomers = new Set(
      todayOrders.map(o=>String(o.customer_name||'').trim().toLowerCase()).filter(Boolean)
    );
    const todayTotal = sumNum(todayOrders,'paid_product') + sumNum(todayOrders,'paid_shipping');

    if (kpiOrdersToday) kpiOrdersToday.textContent = String(todayOrders.length);
    if (kpiCustomersToday) kpiCustomersToday.textContent = String(uniqCustomers.size);
    if (kpiRevenueToday) kpiRevenueToday.textContent = money(todayTotal);

    // Status counts
    const st = statusCounts(orders);
    const setText = (id, val)=>{ const el=document.getElementById(id); if(el) el.textContent=String(val); };
    setText('stPending', st.pending);
    setText('stProcessing', st.processing);
    setText('stShipped', st.shipped);
    setText('stDelivered', st.delivered);
    setText('stCancelled', st.cancelled);

    // Sales by day (7/14/30)
    const daysSelect = document.getElementById('daysSelect');
    const daysLabel = document.getElementById('daysLabel');
    const body = document.getElementById('salesTableBody');
    if (!daysSelect || !daysLabel || !body) return;

    const days = Number(daysSelect.value || 7);
    daysLabel.textContent = String(days);

    const byDate = groupByDate(orders);

    // Build last N days rows (including 0 days)
    const rows = [];
    const now = new Date();
    for (let i=0; i<days; i++){
      const d = new Date(now);
      d.setDate(now.getDate()-i);
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      const key = `${y}-${m}-${dd}`;

      const rec = byDate.get(key) || { count:0, customers:new Set(), prod:0, ship:0 };
      rows.push({
        date: key,
        orders: rec.count,
        customers: rec.customers.size || 0,
        prod: rec.prod || 0,
        ship: rec.ship || 0,
        total: (rec.prod || 0) + (rec.ship || 0)
      });
    }

    body.innerHTML = rows.map(r=>`
      <tr>
        <td style="padding:10px;border-bottom:1px solid rgba(35,48,85,.35)">${r.date}</td>
        <td style="padding:10px;text-align:right;border-bottom:1px solid rgba(35,48,85,.35)">${r.orders}</td>
        <td style="padding:10px;text-align:right;border-bottom:1px solid rgba(35,48,85,.35)">${r.customers}</td>
        <td style="padding:10px;text-align:right;border-bottom:1px solid rgba(35,48,85,.35)">${money(r.prod)}</td>
        <td style="padding:10px;text-align:right;border-bottom:1px solid rgba(35,48,85,.35)">${money(r.ship)}</td>
        <td style="padding:10px;text-align:right;border-bottom:1px solid rgba(35,48,85,.35)">${money(r.total)}</td>
      </tr>
    `).join('');
  }

  function render(){
    const list = filtered();
    if (countLabel) countLabel.textContent = `${list.length} order${list.length===1?'':'s'}`;
    renderKPIs();

    if (!orderList) return;
    orderList.innerHTML = '';
    for (const o of list){
      const li = document.createElement('li');
      li.className = 'orderCard';

      const head = document.createElement('div');
      head.className = 'orderHead';

      const name = document.createElement('div');
      name.className = 'orderName';
      name.textContent = o.customer_name || '(No name)';

      const badges = document.createElement('div');
      badges.className = 'orderBadges';

      const mkPill = (text, cls='')=>{
        const s = document.createElement('span');
        s.className = 'pill ' + cls;
        s.textContent = text;
        return s;
      };

      const st = String(o.status || 'pending').toLowerCase();
      badges.appendChild(mkPill(st.toUpperCase(), 'status ' + st));
      badges.appendChild(mkPill('🚚 ' + String(o.delivery_method || 'jnt').toUpperCase(), ''));
      if (o.order_id) badges.appendChild(mkPill(o.order_id, 'accent'));

      head.appendChild(name);
      head.appendChild(badges);

      const meta = document.createElement('div');
      meta.className = 'orderMeta';

      const metaBits = [];
      if (o.order_date) metaBits.push('📅 ' + o.order_date);
      metaBits.push('💰 ' + money(Number(o.paid_product||0) + Number(o.paid_shipping||0)));
      if (o.fb_profile) metaBits.push('🔗 FB: ' + String(o.fb_profile).replace(/^https?:\/\//,''));

      meta.textContent = metaBits.join(' • ');

      const body = document.createElement('div');
      body.className = 'orderBody';

      const pre = document.createElement('pre');
      pre.textContent = (o.order_details || '').trim();
      body.appendChild(pre);

      const actions = document.createElement('div');
      actions.className = 'orderActions';

      if (o.attachment_url){
        const a = document.createElement('a');
        a.className = 'btn';
        a.href = o.attachment_url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'View';
        actions.appendChild(a);
      }

      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', ()=>startEdit(o));
      actions.appendChild(edit);

      const del = document.createElement('button');
      del.className = 'btn danger';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', ()=>deleteOrder(o));
      actions.appendChild(del);

      li.appendChild(head);
      li.appendChild(meta);
      li.appendChild(body);
      li.appendChild(actions);

      orderList.appendChild(li);
    }
}

  function startEdit(o){
    editingId = o.id;
    if (formTitle) formTitle.textContent = `Edit Order (${o.order_id || o.id})`;
    inputCustomer.value = o.customer_name || '';
    inputFb.value = o.fb_profile || '';
    inputDetails.value = o.order_details || '';
    inputStatus.value = o.status || 'pending';
    inputDate.value = o.order_date || '';
    inputDelivery.value = (o.delivery_method || 'jnt');
    inputPaidProd.value = String(o.paid_product ?? '');
    inputPaidShip.value = String(o.paid_shipping ?? '');
    inputNotes.value = o.notes || '';
    handleDeliveryChange();
  }

  async function deleteOrder(o){
    if (!confirm(`Delete order ${o.order_id || o.id}?`)) return;
    const { error } = await supa.from('orders').delete().eq('id', o.id);
    if (error){ alert(error.message || 'Delete failed'); return; }
    await loadOrders();
    resetForm();
  }

  async function saveOrder(ev){
    ev.preventDefault();
    if (formMsg) formMsg.textContent = 'Saving…';
    btnSave.disabled = true;

    try{
      if (!await ensureSession()) return;

      const payload = {
        customer_name: inputCustomer.value.trim(),
        fb_profile: inputFb.value.trim() || null,
        order_details: inputDetails.value.trim(),
        paid_product: Number(inputPaidProd.value || 0),
        paid_shipping: Number(inputPaidShip.value || 0),
        status: inputStatus.value,
        order_date: inputDate.value || null,
        notes: inputNotes.value.trim() || null,
        delivery_method: inputDelivery.value
      };

      if (payload.delivery_method === 'walkin') payload.paid_shipping = 0;

      const file = inputAttach?.files?.[0] || null;
      if (file){ payload.attachment_url = await uploadAttachment(file); }

      let error;
      if (editingId){
        ({ error } = await supa.from('orders').update(payload).eq('id', editingId));
      } else {
        ({ error } = await supa.from('orders').insert(payload));
      }

      if (error) throw error;

      if (formMsg) formMsg.textContent = 'Saved ✅';
      await loadOrders();
      resetForm();
    } catch(e){
      showErr(e?.message || String(e));
      if (formMsg) formMsg.textContent = 'Save failed';
    } finally {
      btnSave.disabled = false;
      if (inputAttach) inputAttach.value = '';
    }
  }

  function setActiveTab(val){
    activeTab = val;
    tabs.forEach(t=>t.classList.toggle('active', t.dataset.tab === val));
    render();
  }

  async function init(){
    if (!await ensureSession()) return;

    if (btnLogout) btnLogout.addEventListener('click', logout);
    if (btnRefresh) btnRefresh.addEventListener('click', loadOrders);
    if (btnClear) btnClear.addEventListener('click', resetForm);
    if (form) form.addEventListener('submit', saveOrder);

    if (inputDelivery) inputDelivery.addEventListener('change', handleDeliveryChange);
    handleDeliveryChange();

    if (search) search.addEventListener('input', render);
    if (statusFilter) statusFilter.addEventListener('change', render);
    if (dateFilter) dateFilter.addEventListener('change', render);

    const daysSelect = document.getElementById('daysSelect');
    if (daysSelect) daysSelect.addEventListener('change', render);

    tabs.forEach(t=>t.addEventListener('click', ()=>setActiveTab(t.dataset.tab)));

    supa.auth.onAuthStateChange((event)=>{
      if (event==='SIGNED_OUT') location.replace('./index.html');
    });

    await loadOrders();
    resetForm();
  }

  init();
})();