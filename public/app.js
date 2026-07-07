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
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return secs + 's ago';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    return hrs + 'h ' + (mins % 60) + 'm ago';
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

    const ticketLabel = ticket.ticketName
      ? `#${ticket.ticketName}`
      : ticket.number
        ? `#${ticket.number}`
        : ticket.orderId.slice(-4).toUpperCase();

    const customerLine = ticket.customerName
      ? `<div class="ticket-customer">${escapeHtml(ticket.customerName)}</div>`
      : '';

    const newBadge = fresh ? `<span class="new-badge">NEW</span>` : '';

    const itemsHtml = ticket.items.map(item => {
      const modsHtml = item.modifiers.length
        ? `<ul class="item-modifiers">${item.modifiers.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
        : '';
      const noteHtml = item.note
        ? `<div class="item-note">⚠ ${escapeHtml(item.note)}</div>`
        : '';
      return `
        <div class="line-item">
          <div class="item-main">
            <span class="item-qty">${escapeHtml(item.quantity)}×</span>
            <span class="item-name">${escapeHtml(item.name)}</span>
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

  function renderAll() {
    const pending = tickets.filter(t => !t.delivered).sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    ticketCount.textContent = pending.length;

    const existing = Array.from(container.querySelectorAll('.ticket-card'));
    const existingIds = new Set(existing.map(el => el.dataset.id));
    const pendingIds = new Set(pending.map(t => t.id));

    existing.forEach(el => {
      if (!pendingIds.has(el.dataset.id)) el.remove();
    });

    pending.forEach((ticket, i) => {
      if (!existingIds.has(ticket.id)) {
        const card = buildTicketCard(ticket);
        const allCards = container.querySelectorAll('.ticket-card');
        const insertBefore = allCards[i] || null;
        container.insertBefore(card, insertBefore);
      }
    });

    emptyState.style.display = pending.length === 0 ? 'block' : 'none';
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
        if (!exists) {
          tickets.push(msg.ticket);
          renderAll();
          notifyBarista();
        }
      } else if (msg.type === 'ticket_delivered') {
        tickets = tickets.map(t =>
          t.id === msg.ticketId ? { ...t, delivered: true } : t
        );
        renderAll();
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
  }, 30000);

  async function pollTickets() {
    try {
      const res = await fetch('/api/tickets');
      if (res.status === 401) return;
      const fresh = await res.json();
      let changed = false;
      fresh.forEach(t => {
        if (!tickets.find(e => e.id === t.id)) {
          tickets.push(t);
          changed = true;
          notifyBarista();
        }
      });
      tickets = tickets.map(t => {
        const server = fresh.find(s => s.id === t.id);
        return server || t;
      });
      if (changed) renderAll();
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

  function openModal() {
    mCustomerName.value = '';
    mOrderNote.value = '';
    mItems.innerHTML = '';
    addItemRow(false);
    modalOverlay.classList.add('open');
    mCustomerName.focus();
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
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

  refreshDeliveredCount();
  loadTickets();
  getFreshToken().then(connectSSE);
  setInterval(pollTickets, 8000);
})();
