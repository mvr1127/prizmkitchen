(function () {
  'use strict';

  let tickets = [];
  let eventSource = null;
  let reconnectTimer = null;

  const container = document.getElementById('ticketsContainer');
  const emptyState = document.getElementById('emptyState');
  const ticketCount = document.getElementById('ticketCount');
  const statusDot = document.getElementById('statusDot');
  const testBtn = document.getElementById('testBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const timersToggle = document.getElementById('timersToggle');
  const hotCount = document.getElementById('hotCount');
  const icedCount = document.getElementById('icedCount');
  const hotMilkList = document.getElementById('hotMilkList');
  const icedMilkList = document.getElementById('icedMilkList');
  const itemRequests = new Set();
  let timersVisible = true;

  try {
    timersVisible = window.localStorage.getItem('timersVisible') !== 'false';
  } catch (_) {}

  function updateTimerVisibility() {
    document.body.classList.toggle('timers-hidden', !timersVisible);
    timersToggle.textContent = timersVisible ? 'Timers: On' : 'Timers: Off';
    timersToggle.setAttribute('aria-pressed', String(timersVisible));
  }

  updateTimerVisibility();
  timersToggle.addEventListener('click', () => {
    timersVisible = !timersVisible;
    updateTimerVisibility();
    try {
      window.localStorage.setItem('timersVisible', String(timersVisible));
    } catch (_) {}
  });

  function isDevMode() {
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  }

  if (isDevMode()) {
    testBtn.style.display = 'inline-block';
  }

  testBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/test-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (_) {}
  });

  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  function setStatus(state) {
    statusDot.className = 'status-dot ' + state;
    statusDot.title = state.charAt(0).toUpperCase() + state.slice(1);
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getAgeText(iso) {
    const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    const mins = Math.floor(secs / 60);
    return mins + ':' + String(secs % 60).padStart(2, '0');
  }

  function isNew(iso) {
    return (Date.now() - new Date(iso).getTime()) < 120000;
  }

  function isUrgent(iso) {
    return (Date.now() - new Date(iso).getTime()) > 600000;
  }

  function buildTicketCard(ticket) {
    const age = getAgeText(ticket.receivedAt);
    const urgent = isUrgent(ticket.receivedAt);
    const fresh = isNew(ticket.receivedAt);

    const card = document.createElement('div');
    card.className = 'ticket-card' + (fresh ? ' new' : '');
    card.dataset.id = ticket.id;
    card.dataset.snapshot = JSON.stringify(ticket);

    const ticketLabel = ticket.ticketName
      ? `#${ticket.ticketName}`
      : ticket.number
        ? `#${ticket.number}`
        : ticket.orderId.slice(-4).toUpperCase();

    const customerLine = ticket.customerName
      ? `<div class="ticket-customer">${escapeHtml(ticket.customerName)}</div>`
      : '';

    const newBadge = fresh ? `<span class="new-badge">NEW</span>` : '';

    const itemsHtml = ticket.items.map((item, index) => {
      const modsHtml = item.modifiers.length
        ? `<ul class="item-modifiers">${item.modifiers.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
        : '';
      const noteHtml = item.note
        ? `<div class="item-note">⚠ ${escapeHtml(item.note)}</div>`
        : '';
      return `
        <div class="line-item${item.delivered ? ' done' : ''}">
          <div class="item-main">
            <span class="item-qty">${escapeHtml(item.quantity)}×</span>
            <button class="item-name" type="button" aria-label="View recipe for ${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>
            <button class="btn-item-deliver" type="button" data-index="${index}" aria-label="${item.delivered ? 'Undo' : 'Mark'} ${escapeHtml(item.name)}${item.delivered ? '' : ' done'}">${item.delivered ? 'Undo' : 'Done'}</button>
          </div>
          ${modsHtml}
          ${noteHtml}
        </div>`;
    }).join('');

    card.innerHTML = `
      <div class="ticket-header">
        <div class="ticket-id-block">
          <div class="ticket-number">${escapeHtml(ticketLabel)}${newBadge}</div>
          ${customerLine}
        </div>
        <div class="ticket-meta">
          <div class="ticket-time">${formatTime(ticket.createdAt)}</div>
          <div class="ticket-age${urgent ? ' urgent' : ''}">${age}</div>
        </div>
      </div>
      <div class="ticket-items">
        ${ticket.orderNote ? `<div class="order-note">📋 ${escapeHtml(ticket.orderNote)}</div>` : ''}
        ${itemsHtml}
      </div>
      <div class="ticket-footer">
        <button class="btn-deliver" data-id="${ticket.id}">✓ Delivered</button>
      </div>`;

    card.querySelectorAll('.item-name').forEach((button, index) => {
      button.addEventListener('click', () => openRecipeView(ticket.items[index].name));
    });
    card.querySelectorAll('.btn-item-deliver').forEach(button => {
      button.addEventListener('click', () => toggleItem(ticket.id, Number(button.dataset.index)));
    });
    card.querySelector('.btn-deliver').addEventListener('click', () => deliverTicket(ticket.id));
    return card;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function milkType(modifiers) {
    const text = (modifiers || []).join(' ').toLowerCase();
    if (/\b(oat|oatmilk)\b/.test(text)) return 'Oat';
    if (/\b(almond|almondmilk)\b/.test(text)) return 'Almond';
    if (/\b(soy|soymilk)\b/.test(text)) return 'Soy';
    if (/\b(coconut|coconutmilk)\b/.test(text)) return 'Coconut';
    if (/\b(nonfat|non-fat|skim)\b/.test(text)) return 'Nonfat';
    if (/(^|\s)2\s*%/.test(text)) return '2%';
    if (/\b(half\s*(?:and|&)\s*half|breve)\b/.test(text)) return 'Half & Half';
    return 'Whole';
  }

  function renderPrepSummary(pending) {
    const groups = { hot: new Map(), iced: new Map() };
    const totals = { hot: 0, iced: 0 };
    pending.forEach(ticket => ticket.items.forEach(item => {
      if (item.delivered) return;
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) return;
      const temperature = (item.modifiers || []).some(modifier => /\biced\b/i.test(modifier)) ? 'iced' : 'hot';
      const milk = milkType(item.modifiers);
      totals[temperature] += quantity;
      groups[temperature].set(milk, (groups[temperature].get(milk) || 0) + quantity);
    }));
    hotCount.textContent = totals.hot;
    icedCount.textContent = totals.iced;
    [['hot', hotMilkList], ['iced', icedMilkList]].forEach(([temperature, list]) => {
      list.replaceChildren();
      if (!totals[temperature]) {
        const empty = document.createElement('span');
        empty.textContent = 'No drinks pending';
        list.appendChild(empty);
      } else {
        Array.from(groups[temperature]).sort(([a], [b]) => a.localeCompare(b)).forEach(([milk, quantity]) => {
          const label = document.createElement('span');
          label.textContent = `${quantity} ${milk}`;
          list.appendChild(label);
        });
      }
    });
  }

  function renderAll() {
    const pending = tickets.filter(t => !t.delivered).sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    ticketCount.textContent = pending.length;
    renderPrepSummary(pending);

    const existing = Array.from(container.querySelectorAll('.ticket-card'));
    const pendingIds = new Set(pending.map(t => t.id));

    existing.forEach(el => {
      if (!pendingIds.has(el.dataset.id)) el.remove();
    });

    pending.forEach((ticket, i) => {
      const current = Array.from(container.querySelectorAll('.ticket-card')).find(el => el.dataset.id === ticket.id);
      if (current && current.dataset.snapshot === JSON.stringify(ticket)) return;
      const card = buildTicketCard(ticket);
      if (current) current.replaceWith(card);
      else container.insertBefore(card, container.querySelectorAll('.ticket-card')[i] || null);
    });

    emptyState.style.display = pending.length === 0 ? 'block' : 'none';
  }

  async function toggleItem(id, index) {
    const key = `${id}:${index}`;
    if (itemRequests.has(key)) return;
    itemRequests.add(key);
    const card = Array.from(container.querySelectorAll('.ticket-card')).find(el => el.dataset.id === id);
    const button = card?.querySelectorAll('.btn-item-deliver')[index];
    if (button) button.disabled = true;
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(id)}/items/${index}/toggle`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      const { ticket } = await res.json();
      tickets = tickets.map(t => t.id === id ? ticket : t);
      renderAll();
    } catch (_) {
      if (button) button.disabled = false;
      alert('Could not update item. Please try again.');
    } finally {
      itemRequests.delete(key);
    }
  }

  async function deliverTicket(id) {
    const card = container.querySelector(`[data-id="${id}"]`);
    if (card) card.classList.add('delivering');

    try {
      const res = await fetch(`/api/tickets/${id}/deliver`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      tickets = tickets.map(t => t.id === id ? { ...t, delivered: true } : t);
      renderAll();
      refreshDeliveredCount();
      if (deliveredOpen) loadDelivered();
    } catch (_) {
      if (card) card.classList.remove('delivering');
      alert('Could not mark ticket as delivered. Please try again.');
    }
  }

  async function loadTickets() {
    try {
      const res = await fetch('/api/tickets');
      if (res.status === 401) { window.location.href = '/login'; return; }
      tickets = await res.json();
      renderAll();
    } catch (_) {}
  }

  let sseToken = window.__SSE_TOKEN__ || '';

  async function getFreshToken() {
    try {
      const res = await fetch('/api/token');
      if (res.ok) {
        const data = await res.json();
        sseToken = data.sseToken || sseToken;
      }
    } catch (_) {}
  }

  function connectSSE() {
    if (eventSource) eventSource.close();

    const url = `/api/events?token=${encodeURIComponent(sseToken)}`;
    eventSource = new EventSource(url);

    eventSource.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }

      if (msg.type === 'connected') {
        setStatus('connected');
      } else if (msg.type === 'new_ticket') {
        const exists = tickets.find(t => t.id === msg.ticket.id);
        if (exists) tickets = tickets.map(t => t.id === msg.ticket.id ? msg.ticket : t);
        else tickets.push(msg.ticket);
        renderAll();
        if (!exists) notifyBarista();
        refreshDeliveredCount();
        if (deliveredOpen) loadDelivered();
      } else if (msg.type === 'ticket_updated') {
        tickets = tickets.map(t => t.id === msg.ticket.id ? msg.ticket : t);
        renderAll();
      } else if (msg.type === 'ticket_delivered') {
        tickets = tickets.map(t =>
          t.id === msg.ticketId ? { ...t, delivered: true } : t
        );
        renderAll();
        refreshDeliveredCount();
        if (deliveredOpen) loadDelivered();
      }
    });

    eventSource.onerror = () => {
      setStatus('error');
      eventSource.close();
      reconnectTimer = setTimeout(async () => {
        await getFreshToken();
        connectSSE();
      }, 5000);
    };

    eventSource.onopen = () => setStatus('connected');
  }

  function notifyBarista() {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('New Order', { body: 'A new order has arrived.', icon: '' });
    }
  }

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  setInterval(() => {
    container.querySelectorAll('.ticket-card').forEach(card => {
      const id = card.dataset.id;
      const ticket = tickets.find(t => t.id === id);
      if (!ticket) return;
      const ageEl = card.querySelector('.ticket-age');
      if (ageEl) {
        ageEl.textContent = getAgeText(ticket.receivedAt);
        ageEl.className = 'ticket-age' + (isUrgent(ticket.receivedAt) ? ' urgent' : '');
      }
      if (isNew(ticket.receivedAt)) {
        card.classList.add('new');
      } else {
        card.classList.remove('new');
      }
    });
  }, 1000);

  async function pollTickets() {
    try {
      const res = await fetch('/api/tickets');
      if (res.status === 401) return;
      const fresh = await res.json();
      const previous = tickets.filter(t => !t.delivered);
      if (JSON.stringify(previous) !== JSON.stringify(fresh)) {
        if (fresh.some(t => !previous.some(e => e.id === t.id))) notifyBarista();
        tickets = fresh;
        renderAll();
        refreshDeliveredCount();
        if (deliveredOpen) loadDelivered();
      }
    } catch (_) {}
  }

  const deliveredToggle = document.getElementById('deliveredToggle');
  const deliveredList = document.getElementById('deliveredList');
  const deliveredCount = document.getElementById('deliveredCount');
  const toggleArrow = document.getElementById('toggleArrow');

  let deliveredTickets = [];
  let deliveredOpen = false;

  deliveredToggle.addEventListener('click', () => {
    deliveredOpen = !deliveredOpen;
    deliveredList.style.display = deliveredOpen ? 'grid' : 'none';
    toggleArrow.classList.toggle('open', deliveredOpen);
    if (deliveredOpen) loadDelivered();
  });

  async function loadDelivered() {
    try {
      const res = await fetch('/api/tickets/delivered');
      if (!res.ok) return;
      deliveredTickets = await res.json();
      renderDelivered();
    } catch (_) {}
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderDelivered() {
    deliveredCount.textContent = deliveredTickets.length;
    deliveredList.innerHTML = '';
    deliveredTickets.forEach(ticket => {
      const ticketLabel = ticket.ticketName
        ? `#${ticket.ticketName}`
        : ticket.number
          ? `#${ticket.number}`
          : ticket.id.slice(-4).toUpperCase();

      const itemsSummary = ticket.items.map(i =>
        `${i.quantity}× ${escapeHtml(i.name)}`
      ).join(', ');

      const card = document.createElement('div');
      card.className = 'delivered-card';
      card.innerHTML = `
        <div class="delivered-card-header">
          <span class="delivered-num">${escapeHtml(ticketLabel)}</span>
          ${ticket.customerName ? `<span class="delivered-customer">${escapeHtml(ticket.customerName)}</span>` : ''}
          <span class="delivered-time">${ticket.deliveredAt ? formatDateTime(ticket.deliveredAt) : ''}</span>
        </div>
        <div class="delivered-items">${itemsSummary}</div>
        ${ticket.orderNote ? `<div class="delivered-note">📋 ${escapeHtml(ticket.orderNote)}</div>` : ''}
        <button class="btn-restore" data-id="${ticket.id}">↩ Restore</button>`;

      card.querySelector('.btn-restore').addEventListener('click', () => restoreTicket(ticket.id));
      deliveredList.appendChild(card);
    });
  }

  async function restoreTicket(id) {
    try {
      const res = await fetch(`/api/tickets/${id}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      deliveredTickets = deliveredTickets.filter(t => t.id !== id);
      renderDelivered();
      await loadTickets();
    } catch (_) {
      alert('Could not restore ticket. Please try again.');
    }
  }

  function refreshDeliveredCount() {
    fetch('/api/tickets/delivered')
      .then(r => r.ok ? r.json() : [])
      .then(data => { deliveredCount.textContent = data.length; })
      .catch(() => {});
  }

  const modalOverlay = document.getElementById('modalOverlay');
  const newOrderBtn = document.getElementById('newOrderBtn');
  const modalClose = document.getElementById('modalClose');
  const modalCancel = document.getElementById('modalCancel');
  const modalSubmit = document.getElementById('modalSubmit');
  const addItemBtn = document.getElementById('addItemBtn');
  const mItems = document.getElementById('mItems');
  const mCustomerName = document.getElementById('mCustomerName');
  const mOrderNote = document.getElementById('mOrderNote');

  function addItemRow(focusName) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <button class="btn-remove-item" type="button" title="Remove item">✕</button>
      <div class="item-row-top">
        <input type="text" class="item-name-input" placeholder="Item name" autocomplete="off">
        <input type="number" class="item-qty-input" value="1" min="1" max="99">
      </div>
      <input type="text" class="item-mods-input" placeholder="Modifiers, e.g. oat milk, extra shot" autocomplete="off">`;
    row.querySelector('.btn-remove-item').addEventListener('click', () => {
      if (mItems.querySelectorAll('.item-row').length > 1) row.remove();
    });
    mItems.appendChild(row);
    if (focusName) row.querySelector('.item-name-input').focus();
  }

  let activeDialog = null;
  let dialogTrigger = null;

  function showDialog(overlay, focusTarget) {
    dialogTrigger = document.activeElement;
    activeDialog = overlay;
    overlay.classList.add('open');
    document.body.classList.add('dialog-open');
    (focusTarget || overlay.querySelector('[role="dialog"]')).focus();
  }

  function hideDialog(overlay) {
    if (activeDialog !== overlay) return;
    overlay.classList.remove('open');
    activeDialog = null;
    document.body.classList.remove('dialog-open');
    if (dialogTrigger && dialogTrigger.isConnected) dialogTrigger.focus();
    dialogTrigger = null;
  }

  document.addEventListener('keydown', (event) => {
    if (!activeDialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      hideDialog(activeDialog);
    } else if (event.key === 'Tab') {
      const focusable = Array.from(activeDialog.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !activeDialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !activeDialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  function openModal() {
    mCustomerName.value = '';
    mOrderNote.value = '';
    mItems.innerHTML = '';
    addItemRow(false);
    showDialog(modalOverlay, mCustomerName);
  }

  function closeModal() {
    hideDialog(modalOverlay);
  }

  newOrderBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
  addItemBtn.addEventListener('click', () => addItemRow(true));

  modalSubmit.addEventListener('click', async () => {
    const itemRows = mItems.querySelectorAll('.item-row');
    const items = [];
    let valid = true;

    itemRows.forEach(row => {
      const name = row.querySelector('.item-name-input').value.trim();
      const qty = row.querySelector('.item-qty-input').value.trim();
      const mods = row.querySelector('.item-mods-input').value.trim();
      if (!name) { valid = false; row.querySelector('.item-name-input').focus(); return; }
      items.push({
        name,
        quantity: qty || '1',
        modifiers: mods ? mods.split(',').map(s => s.trim()).filter(Boolean) : []
      });
    });

    if (!valid || items.length === 0) return;

    modalSubmit.disabled = true;
    try {
      const res = await fetch('/api/tickets/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: mCustomerName.value.trim(),
          orderNote: mOrderNote.value.trim(),
          items
        })
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      tickets.push(data.ticket);
      renderAll();
      closeModal();
    } catch (_) {
      alert('Could not create order. Please try again.');
    } finally {
      modalSubmit.disabled = false;
    }
  });

  const recipeViewOverlay = document.getElementById('recipeViewOverlay');
  const recipeViewTitle = document.getElementById('recipeViewTitle');
  const recipeViewInstructions = document.getElementById('recipeViewInstructions');
  const recipesOverlay = document.getElementById('recipesOverlay');
  const recipesList = document.getElementById('recipesList');
  const recipesFeedback = document.getElementById('recipesFeedback');
  const recipeForm = document.getElementById('recipeForm');
  const recipeName = document.getElementById('recipeName');
  const recipeInstructions = document.getElementById('recipeInstructions');
  const recipeSave = document.getElementById('recipeSave');
  const recipeCancelEdit = document.getElementById('recipeCancelEdit');
  const recipeFormTitle = document.getElementById('recipeFormTitle');
  const squareItems = document.getElementById('squareItems');
  const squareItemsStatus = document.getElementById('squareItemsStatus');
  const refreshSquareItems = document.getElementById('refreshSquareItems');
  let recipes = [];
  let editingName = null;
  let recipeRequest = 0;
  let recipesLoadRequest = 0;
  let squareLoadRequest = 0;

  function normalizedName(name) {
    return String(name).trim().toLocaleLowerCase();
  }

  async function loadRecipes() {
    const request = ++recipesLoadRequest;
    const response = await fetch('/api/recipes');
    if (!response.ok) throw new Error('Could not load recipes');
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid recipes');
    if (request === recipesLoadRequest) recipes = data;
    return data;
  }

  function syncSquareSelection() {
    const match = Array.from(squareItems.options).find(option =>
      option.value && normalizedName(option.value) === normalizedName(recipeName.value)
    );
    squareItems.value = match ? match.value : '';
  }

  async function loadSquareItems() {
    const request = ++squareLoadRequest;
    squareItems.disabled = true;
    refreshSquareItems.disabled = true;
    squareItemsStatus.textContent = 'Loading Square items…';
    try {
      const response = await fetch('/api/square/items', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load Square items');
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error('Invalid Square items');
      if (request !== squareLoadRequest || activeDialog !== recipesOverlay) return;
      squareItems.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = items.length ? 'Select a Square item…' : 'No Square items found';
      squareItems.appendChild(placeholder);
      items.forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        squareItems.appendChild(option);
      });
      squareItems.disabled = items.length === 0;
      syncSquareSelection();
      squareItemsStatus.textContent = items.length
        ? `${items.length} Square items available.`
        : 'No Square items found. Enter a name manually.';
    } catch (_) {
      if (request !== squareLoadRequest || activeDialog !== recipesOverlay) return;
      squareItems.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.textContent = 'Square items unavailable';
      squareItems.appendChild(placeholder);
      squareItemsStatus.textContent = 'Could not load Square items. Enter a name manually or try refreshing.';
    } finally {
      if (request === squareLoadRequest) refreshSquareItems.disabled = false;
    }
  }

  async function openRecipeView(name) {
    const request = ++recipeRequest;
    recipeViewTitle.textContent = name;
    recipeViewInstructions.textContent = 'Loading recipe…';
    showDialog(recipeViewOverlay, document.getElementById('recipeViewClose'));
    try {
      const current = await loadRecipes();
      if (request !== recipeRequest || activeDialog !== recipeViewOverlay) return;
      const recipe = current.find(entry => normalizedName(entry.name) === normalizedName(name));
      recipeViewInstructions.textContent = recipe ? recipe.instructions : 'No recipe saved for this drink yet.';
    } catch (_) {
      if (request === recipeRequest && activeDialog === recipeViewOverlay) {
        recipeViewInstructions.textContent = 'Could not load recipes. Please try again.';
      }
    }
  }

  function resetRecipeForm() {
    editingName = null;
    recipeForm.reset();
    recipeFormTitle.textContent = 'Add a recipe';
    recipeSave.textContent = 'Save recipe';
    recipeCancelEdit.hidden = true;
  }

  function renderRecipes() {
    recipesList.replaceChildren();
    if (!recipes.length) {
      const empty = document.createElement('p');
      empty.className = 'recipes-empty';
      empty.textContent = 'No recipes saved yet. Add the first one below.';
      recipesList.appendChild(empty);
      return;
    }
    recipes.forEach(recipe => {
      const row = document.createElement('div');
      row.className = 'recipe-list-row';
      const details = document.createElement('div');
      details.className = 'recipe-list-details';
      const title = document.createElement('strong');
      title.textContent = recipe.name;
      const preview = document.createElement('span');
      preview.textContent = recipe.instructions;
      details.append(title, preview);
      const actions = document.createElement('div');
      actions.className = 'recipe-list-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${recipe.name}`);
      edit.addEventListener('click', () => {
        editingName = recipe.name;
        recipeName.value = recipe.name;
        syncSquareSelection();
        recipeInstructions.value = recipe.instructions;
        recipeFormTitle.textContent = 'Edit recipe';
        recipeSave.textContent = 'Update recipe';
        recipeCancelEdit.hidden = false;
        recipesFeedback.textContent = '';
        recipeName.focus();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'recipe-delete';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${recipe.name}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Delete the recipe for ${recipe.name}?`)) return;
        remove.disabled = true;
        recipesFeedback.textContent = '';
        try {
          const response = await fetch(`/api/recipes/${encodeURIComponent(recipe.name)}`, { method: 'DELETE' });
          if (!response.ok) throw new Error('Delete failed');
          if (editingName && normalizedName(editingName) === normalizedName(recipe.name)) resetRecipeForm();
          await loadRecipes();
          renderRecipes();
          recipesFeedback.textContent = 'Recipe deleted.';
          recipeName.focus();
        } catch (_) {
          recipesFeedback.textContent = 'Could not delete recipe. Please try again.';
          remove.disabled = false;
        }
      });
      actions.append(edit, remove);
      row.append(details, actions);
      recipesList.appendChild(row);
    });
  }

  document.getElementById('recipesBtn').addEventListener('click', async () => {
    resetRecipeForm();
    recipesFeedback.textContent = 'Loading recipes…';
    recipesList.replaceChildren();
    showDialog(recipesOverlay, document.getElementById('recipesClose'));
    loadSquareItems();
    try {
      await loadRecipes();
      if (activeDialog !== recipesOverlay) return;
      recipesFeedback.textContent = '';
      renderRecipes();
    } catch (_) {
      if (activeDialog === recipesOverlay) recipesFeedback.textContent = 'Could not load recipes. Please close and try again.';
    }
  });

  refreshSquareItems.addEventListener('click', loadSquareItems);
  squareItems.addEventListener('change', () => {
    if (!squareItems.value) return;
    recipeName.value = squareItems.value;
    recipeInstructions.focus();
  });
  recipeName.addEventListener('input', syncSquareSelection);

  recipeCancelEdit.addEventListener('click', () => {
    resetRecipeForm();
    recipeName.focus();
  });

  recipeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = recipeName.value.trim();
    const instructions = recipeInstructions.value.trim();
    if (!name || !instructions) {
      recipesFeedback.textContent = 'Enter a drink name and instructions.';
      (!name ? recipeName : recipeInstructions).focus();
      return;
    }
    const match = recipes.find(recipe => normalizedName(recipe.name) === normalizedName(name));
    if (match && (!editingName || normalizedName(editingName) !== normalizedName(match.name))) {
      recipesFeedback.textContent = 'A recipe with this name already exists. Edit it instead.';
      recipeName.focus();
      return;
    }
    recipeSave.disabled = true;
    recipesFeedback.textContent = 'Saving recipe…';
    try {
      const response = await fetch(`/api/recipes/${encodeURIComponent(editingName || name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, instructions })
      });
      if (!response.ok) throw new Error('Save failed');
      await loadRecipes();
      renderRecipes();
      resetRecipeForm();
      recipesFeedback.textContent = 'Recipe saved.';
      recipeName.focus();
    } catch (_) {
      recipesFeedback.textContent = 'Could not save recipe. Please try again.';
    } finally {
      recipeSave.disabled = false;
    }
  });

  document.getElementById('recipeViewClose').addEventListener('click', () => hideDialog(recipeViewOverlay));
  document.getElementById('recipesClose').addEventListener('click', () => hideDialog(recipesOverlay));
  [recipeViewOverlay, recipesOverlay].forEach(overlay => {
    overlay.addEventListener('click', event => {
      if (event.target === overlay) hideDialog(overlay);
    });
  });

  loadRecipes().catch(() => {});
  refreshDeliveredCount();
  loadTickets();
  getFreshToken().then(connectSSE);
  setInterval(pollTickets, 8000);
})();
