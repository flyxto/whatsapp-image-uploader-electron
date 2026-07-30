'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFolder  = null;
let isWatching      = false;
let activeFrame     = null;
const imageCards    = new Map(); // imageId → card element
const cardFilePaths = new Map(); // imageId → filePath (for manual send)
const cardPhones    = new Map(); // imageId → phone number (for search)
const cardImageUrls = new Map(); // imageId → Cloudflare URL
let queueCount      = 0;
let currentTab      = 'all';     // 'all' | 'sent' | 'not-sent'
let eventCreated    = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const folderPathText  = document.getElementById('folder-path-text');
const btnSelect       = document.getElementById('btn-select');
const btnWatch        = document.getElementById('btn-watch');
const btnStop         = document.getElementById('btn-stop');
const btnToggleLog    = document.getElementById('btn-toggle-log');
const btnRetry        = document.getElementById('btn-retry');
const btnClearLog     = document.getElementById('btn-clear-log');
const contentArea     = document.getElementById('content-area');
const queueList       = document.getElementById('queue-list');
const queueCountBadge = document.getElementById('queue-count');
const logOutput       = document.getElementById('log-output');
const dbDot           = document.getElementById('db-dot');
const dbStatusText    = document.getElementById('db-status-text');
const statPending     = document.getElementById('stat-pending');
const statProcessing  = document.getElementById('stat-processing');
const statCompleted   = document.getElementById('stat-completed');
const statFailed      = document.getElementById('stat-failed');

// ── Helpers ───────────────────────────────────────────────────────────────────

function updateWatchButtonState() {
  btnWatch.disabled = !(selectedFolder && eventCreated);
}

function fmtTs(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function formatUserCode(imageId) {
  if (!imageId) return '';
  // Match prefix + 8-digits date + 4-digits code (e.g. CMB202607181024)
  const match = imageId.match(/^([A-Z]+)(\d{8})(\d{4})$/i);
  if (match) {
    return `${match[1]}${match[3]}`;
  }
  return imageId;
}

function statusIcon(status) {
  const map = {
    detected:   '🔍',
    processing: '⚙️',
    uploaded:   '☁️',
    completed:  '✅',
    failed:     '❌',
    'no-match': '⏳',
  };
  return map[status] || '🔲';
}

function statusLabel(status) {
  const map = {
    detected:   'Image detected — looking up user…',
    processing: 'Uploading photo to Cloudflare R2…',
    uploaded:   'Uploaded — sending WhatsApp…',
    completed:  'Done! Photo delivered via WhatsApp.',
    failed:     'Processing failed.',
    'no-match': 'No matching user found in database.',
  };
  return map[status] || status;
}

// ── Log ───────────────────────────────────────────────────────────────────────

function appendLog({ level, message, imageId, ts }) {
  const line = document.createElement('div');
  line.className = 'log-line';

  const tsEl  = document.createElement('span');
  tsEl.className = 'log-ts';
  tsEl.textContent = fmtTs(ts);

  const lvlEl = document.createElement('span');
  lvlEl.className = `log-lvl ${level}`;
  lvlEl.textContent = level.toUpperCase();

  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = message;

  line.appendChild(tsEl);
  line.appendChild(lvlEl);
  line.appendChild(msgEl);

  if (imageId) {
    const idEl = document.createElement('span');
    idEl.className = 'log-id';
    idEl.textContent = `[${formatUserCode(imageId)}]`;
    line.appendChild(idEl);
  }

  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;

  // Cap log at 500 lines
  while (logOutput.children.length > 500) {
    logOutput.removeChild(logOutput.firstChild);
  }
}

// ── Queue cards ───────────────────────────────────────────────────────────────

async function loadImagesList(folderPath) {
  const loader = document.getElementById('loader-overlay');
  if (loader) loader.style.display = 'flex';

  try {
    const images = await window.api.getImages(folderPath);

    // Clear UI state
    queueList.innerHTML = '';
    imageCards.clear();
    cardPhones.clear();
    queueCount = 0;
    queueCountBadge.textContent = '0';

    if (images.length === 0) {
      updateEmptyState();
    } else {
      // images array is sorted oldest-first.
      // Since upsertCard prepends, looping oldest-to-newest will result in the newest being at the top.
      for (const item of images) {
        upsertCard(item.imageId, item.status, item);
      }
    }
    
    refreshStats();
  } catch (err) {
    appendLog({ level: 'error', message: `Failed to load folder images: ${err.message}`, ts: new Date().toISOString() });
  } finally {
    if (loader) {
      // Add a small delay for visual feedback/smooth transition
      setTimeout(() => {
        loader.style.display = 'none';
      }, 300);
    }
  }
}

function updateEmptyState() {
  if (imageCards.size > 0) return;
  
  if (!eventCreated) {
    queueList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" style="font-size: 40px; margin-bottom: 8px;">📅</div>
        <p style="font-size: 14px; font-weight: 500; color: var(--text-secondary); margin-bottom: 16px; max-width: 320px; line-height: 1.6;">No event configured.<br/>Please select an existing event or create a new one.</p>
        <div style="display: flex; gap: 12px; justify-content: center; -webkit-app-region: no-drag;">
          <button class="btn btn-secondary" id="btn-select-event-central">Select Event</button>
          <button class="btn btn-primary" id="btn-create-event-central">Create Event</button>
        </div>
      </div>
    `;
    
    // Bind click to the central buttons
    const btnSelectCentral = document.getElementById('btn-select-event-central');
    const btnCreateCentral = document.getElementById('btn-create-event-central');
    if (btnSelectCentral) btnSelectCentral.onclick = openSelectEventModal;
    if (btnCreateCentral) btnCreateCentral.onclick = openCreateEventModal;
  } else {
    queueList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🖼️</div>
        <p>Waiting for images…<br/>Start watching a folder to begin.</p>
      </div>
    `;
  }
}

function removeEmptyState() {
  const es = queueList.querySelector('.empty-state');
  if (es) es.remove();
}

function upsertCard(imageId, status, extra = {}) {
  let card = imageCards.get(imageId);

  if (!card) {
    // New card
    removeEmptyState();
    card = document.createElement('div');
    card.className = `queue-card ${status}`;

    const dbSaved = ['uploaded', 'no-match', 'completed'].includes(status);

    card.innerHTML = `
      <div class="card-preview" id="cp-${imageId}">
        <span class="card-preview-ph">🖼️</span>
      </div>
      <div class="card-footer">
        <div class="card-id">${formatUserCode(imageId)}</div>
        <div class="card-user" id="cu-${imageId}"></div>
        <div class="card-step" id="cs-${imageId}">${statusLabel(status)}</div>
        <div class="card-status-pill-wrap">
          <span class="status-pill ${status === 'completed' ? 'pill-sent' : 'pill-not-sent'}" id="cpill-${imageId}">
            ${status === 'completed' ? 'Sent' : 'Not Sent'}
          </span>
          <span class="status-pill ${dbSaved ? 'pill-db-uploaded' : 'pill-db-pending'}" id="dbpill-${imageId}" style="margin-left: 6px;">
            ${dbSaved ? 'DB: Saved' : 'DB: Pending'}
          </span>
        </div>
      </div>
      <button class="card-hide-btn ${extra.hide ? 'is-hidden' : ''}" title="${extra.hide ? 'Unhide Photo' : 'Hide Photo'}" id="hide-${imageId}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          ${extra.hide ? 
            '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>' : 
            '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>'}
        </svg>
      </button>
      <button class="card-delete-btn" title="Delete Photo" id="del-${imageId}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    // Prepend so newest is at top
    queueList.insertBefore(card, queueList.firstChild);
    imageCards.set(imageId, card);
    queueCount++;
    queueCountBadge.textContent = queueCount;
  } else {
    // Update existing
    card.className = `queue-card ${status}`;
    const stepEl = document.getElementById(`cs-${imageId}`);
    if (stepEl) stepEl.textContent = statusLabel(status);
    const pill = document.getElementById(`cpill-${imageId}`);
    if (pill) {
      if (status === 'completed') {
        pill.className = 'status-pill pill-sent';
        pill.textContent = 'Sent';
      } else {
        pill.className = 'status-pill pill-not-sent';
        pill.textContent = 'Not Sent';
      }
    }
    const dbPill = document.getElementById(`dbpill-${imageId}`);
    if (dbPill) {
      const dbSaved = ['uploaded', 'no-match', 'completed'].includes(status);
      dbPill.className = `status-pill ${dbSaved ? 'pill-db-uploaded' : 'pill-db-pending'}`;
      dbPill.textContent = dbSaved ? 'DB: Saved' : 'DB: Pending';
    }
  }

  // Set preview thumbnail if provided
  if (extra.previewUrl) {
    const previewEl = document.getElementById(`cp-${imageId}`);
    if (previewEl) {
      previewEl.innerHTML = `<img src="${extra.previewUrl}" alt="Photo preview" class="card-preview-img" />`;
    }
  }


  // Update user info if provided (from normal processing path)
  if (extra.user) {
    const userEl = document.getElementById(`cu-${imageId}`);
    if (userEl) userEl.textContent = `${extra.user.phone}`;
    if (extra.user.phone) cardPhones.set(imageId, extra.user.phone);
  }

  // Store phone from skip/completed events (restart path or manual send path)
  if (extra.phone && !cardPhones.has(imageId)) {
    cardPhones.set(imageId, extra.phone);
    const userEl = document.getElementById(`cu-${imageId}`);
    if (userEl && !userEl.textContent) userEl.textContent = extra.phone;
  }

  // Show image URL if completed
  if (extra.imageUrl) {
    cardImageUrls.set(imageId, extra.imageUrl);
    const urlEl = document.getElementById(`curl-${imageId}`);
    if (urlEl) urlEl.textContent = extra.imageUrl;
  }

  // Show error
  if (extra.error) {
    const stepEl = document.getElementById(`cs-${imageId}`);
    if (stepEl) stepEl.textContent = `❌ ${extra.error}`;
  }

  // Store filePath for manual send
  if (extra.filePath) {
    cardFilePaths.set(imageId, extra.filePath);
  }

  // Make preview clickable for no-match / failed / completed cards (re-send)
  const isSendable = (status === 'no-match' || status === 'failed' || status === 'completed' || status === 'pending' || status === 'uploaded');
  const previewEl  = document.getElementById(`cp-${imageId}`);
  if (previewEl) {
    if (isSendable && cardFilePaths.has(imageId)) {
      if (!activeFrame) {
        previewEl.classList.remove('card-preview-clickable');
        previewEl.title = '⚠️ Please select an active frame first';
        previewEl.onclick = () => {
          alert('⚠️ Please select an active frame in the "Frames" tab first before sending!');
        };
      } else {
        previewEl.classList.add('card-preview-clickable');
        previewEl.title = '📲 Click to send manually';
        previewEl.onclick = () => openManualModal(imageId);
      }
    } else {
      previewEl.classList.remove('card-preview-clickable');
      previewEl.title = '';
      previewEl.onclick = null;
    }
  }

  // Update tab counts
  let completedCount = 0;
  for (const card of imageCards.values()) {
    if (card.classList.contains('completed')) completedCount++;
  }
  document.getElementById('tab-count-all').textContent = imageCards.size;
  document.getElementById('tab-count-sent').textContent = completedCount;
  document.getElementById('tab-count-not-sent').textContent = imageCards.size - completedCount;

  // Bind delete button click
  const deleteBtn = card.querySelector('.card-delete-btn');
  if (deleteBtn) {
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      openDeleteModal(imageId);
    };
  }

  // Bind hide button click
  const hideBtn = card.querySelector('.card-hide-btn');
  if (hideBtn) {
    hideBtn.onclick = async (e) => {
      e.stopPropagation();
      const isCurrentlyHidden = hideBtn.classList.contains('is-hidden');
      const newState = !isCurrentlyHidden;
      
      try {
        const result = await window.api.toggleHideImage(imageId, newState);
        if (result.success) {
          if (newState) {
            hideBtn.classList.add('is-hidden');
            hideBtn.title = 'Unhide Photo';
            hideBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
          } else {
            hideBtn.classList.remove('is-hidden');
            hideBtn.title = 'Hide Photo';
            hideBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
          }
        } else {
          alert(`Failed to hide/unhide image: ${result.error || 'Unknown error'}`);
        }
      } catch (err) {
        alert(`Error hiding/unhiding image: ${err.message}`);
      }
    };
  }

  // Re-apply current tab filter (in case a card's status changed and needs to be hidden)
  applySearch();
}

function updateCardActions() {
  for (const [imageId, card] of imageCards.entries()) {
    const previewEl = document.getElementById(`cp-${imageId}`);
    if (previewEl && cardFilePaths.has(imageId)) {
      const isCompleted = card.classList.contains('completed');
      const isFailed    = card.classList.contains('failed');
      const isNoMatch   = card.classList.contains('no-match');
      const isPending   = card.classList.contains('pending');
      const isUploaded  = card.classList.contains('uploaded');
      const isSendable  = isCompleted || isFailed || isNoMatch || isPending || isUploaded;

      if (isSendable) {
        if (!activeFrame) {
          previewEl.classList.remove('card-preview-clickable');
          previewEl.title = '⚠️ Please select an active frame first';
          previewEl.onclick = () => {
            alert('⚠️ Please select an active frame in the "Frames" tab first before sending!');
          };
        } else {
          previewEl.classList.add('card-preview-clickable');
          previewEl.title = '📲 Click to send manually';
          previewEl.onclick = () => openManualModal(imageId);
        }
      }
    }
  }
}


// ── Stats refresh ─────────────────────────────────────────────────────────────

function refreshStats() {
  let pending = 0;
  let processing = 0;
  let completed = 0;
  let failed = 0;

  for (const card of imageCards.values()) {
    if (card.classList.contains('completed')) {
      completed++;
    } else if (card.classList.contains('failed')) {
      failed++;
    } else if (card.classList.contains('processing')) {
      processing++;
    } else {
      // Anything else (detected, uploaded, no-match, etc) is "pending"
      pending++;
    }
  }

  statPending.textContent    = pending;
  statProcessing.textContent = processing;
  statCompleted.textContent  = completed;
  statFailed.textContent     = failed;
}

// Poll stats every 5 s
setInterval(refreshStats, 5000);

// ── IPC listeners ─────────────────────────────────────────────────────────────

window.api.onLog((data) => appendLog(data));

window.api.onDbStatus(({ connected, error }) => {
  dbDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  dbStatusText.textContent = connected ? 'Connected' : (error ? 'Error' : 'Disconnected');
  if (connected) {
    refreshStats();
    populateSidebarEvents();
  }
});

window.api.onImageStatus(({ imageId, status, user, imageUrl, error, previewUrl, filePath, phone, hide }) => {
  upsertCard(imageId, status, { user, imageUrl, error, previewUrl, filePath, phone, hide });
  refreshStats();
});

// ── Manual Send Modal ─────────────────────────────────────────────────────────────

const manualModal    = document.getElementById('manual-modal');
const modalPhoneInput = document.getElementById('modal-phone');
const modalPreviewImg = document.getElementById('modal-preview-img');
const modalPhotoIdTxt = document.getElementById('modal-photo-id-text');
const modalPhotoUrlWrap = document.getElementById('modal-photo-url-wrap');
const modalPhotoUrlLink = document.getElementById('modal-photo-url-link');
const modalQrBtn     = document.getElementById('modal-qr-btn');
const modalError      = document.getElementById('modal-error');
const modalSendBtn    = document.getElementById('modal-send');

let activeManualImageId = null;

function openManualModal(imageId) {
  activeManualImageId = imageId;
  modalPhotoIdTxt.textContent = formatUserCode(imageId);
  modalPhoneInput.value = '';

  const imageUrl = cardImageUrls.get(imageId);
  if (imageUrl) {
    modalPhotoUrlLink.href = imageUrl;
    modalPhotoUrlLink.textContent = imageUrl;
    modalPhotoUrlWrap.style.display = 'flex';
    modalQrBtn.style.display = 'inline-flex';
  } else {
    modalPhotoUrlWrap.style.display = 'none';
    modalQrBtn.style.display = 'none';
  }

  // Show the complete image with better quality (local file:// URL)
  const filePath = cardFilePaths.get(imageId);
  if (filePath) {
    modalPreviewImg.src = `file://${filePath.replace(/\\/g, '/')}`;
  } else {
    const previewEl = document.getElementById(`cp-${imageId}`);
    const thumbImg  = previewEl?.querySelector('img');
    modalPreviewImg.src = thumbImg?.src || '';
  }

  if (!activeFrame) {
    modalError.textContent = 'Please select an active frame in the "Frames" tab first.';
    modalError.style.display = 'block';
    modalSendBtn.disabled = true;
    modalSendBtn.textContent = 'Upload & Send (Disabled)';
    modalPhoneInput.disabled = true;
  } else {
    modalError.style.display = 'none';
    modalSendBtn.disabled = false;
    modalSendBtn.textContent = 'Upload & Send';
    modalPhoneInput.disabled = false;
  }

  manualModal.style.display = 'flex';
  if (activeFrame) {
    setTimeout(() => modalPhoneInput.focus(), 50);
  }
}

function closeManualModal() {
  manualModal.style.display = 'none';
  activeManualImageId = null;
}

// ── QR Code Modal ─────────────────────────────────────────────────────────────
const qrModal       = document.getElementById('qr-modal');
const qrCodeImg     = document.getElementById('qr-code-img');
const qrPhotoIdTxt  = document.getElementById('qr-photo-id-text');
const qrModalClose  = document.getElementById('qr-modal-close');
const qrModalDone   = document.getElementById('qr-modal-done');

modalQrBtn.addEventListener('click', async () => {
  if (!activeManualImageId) return;
  const imageUrl = cardImageUrls.get(activeManualImageId);
  if (!imageUrl) return;

  qrPhotoIdTxt.textContent = formatUserCode(activeManualImageId);
  qrCodeImg.src = '';

  const res = await window.api.generateQrCode(imageUrl);
  if (res.ok) {
    qrCodeImg.src = res.dataUrl;
    qrModal.style.display = 'flex';
  } else {
    alert(`Failed to generate QR code: ${res.error}`);
  }
});

function closeQrModal() {
  qrModal.style.display = 'none';
}

qrModalClose.addEventListener('click', closeQrModal);
qrModalDone.addEventListener('click', closeQrModal);
qrModal.addEventListener('click', (e) => { if (e.target === qrModal) closeQrModal(); });

document.getElementById('modal-close').addEventListener('click', closeManualModal);
document.getElementById('modal-cancel').addEventListener('click', closeManualModal);
manualModal.addEventListener('click', (e) => { if (e.target === manualModal) closeManualModal(); });

modalSendBtn.addEventListener('click', async () => {
  const phone = modalPhoneInput.value.trim();
  if (!phone) {
    modalError.textContent = 'Please enter a WhatsApp number.';
    modalError.style.display = 'block';
    return;
  }
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length < 7 || cleaned.length > 15) {
    modalError.textContent = 'Enter a valid number with country code (e.g. +94771234567).';
    modalError.style.display = 'block';
    return;
  }

  modalError.style.display = 'none';
  modalSendBtn.disabled = true;
  modalSendBtn.textContent = 'Uploading...';

  const imageId = activeManualImageId;
  const filePath = cardFilePaths.get(imageId);

  appendLog({ level: 'info', message: `📤 Manual send: ${imageId} → ${phone}`, ts: new Date().toISOString() });

  const result = await window.api.manualSend({ filePath, phone, imageId });

  if (result.ok) {
    // Store phone so it's searchable
    cardPhones.set(imageId, phone);
    const userEl = document.getElementById(`cu-${imageId}`);
    if (userEl) userEl.textContent = phone;
    closeManualModal();
    appendLog({ level: 'info', message: `✅ Manually sent to ${phone}`, ts: new Date().toISOString() });

  } else {
    modalError.textContent = result.error;
    modalError.style.display = 'block';
    modalSendBtn.disabled = false;
    modalSendBtn.textContent = 'Upload & Send';
  }
});

// Limit to 10 digits and strip non-digits in real-time
modalPhoneInput.addEventListener('input', () => {
  let value = modalPhoneInput.value.replace(/\D/g, '');
  if (value.length > 10) {
    value = value.slice(0, 10);
  }
  modalPhoneInput.value = value;
});

// Allow Enter key to submit
modalPhoneInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalSendBtn.click();
});

// ── Delete Confirmation Modal ───────────────────────────────────────────────────

const deleteModal        = document.getElementById('delete-modal');
const deletePhotoIdTxt   = document.getElementById('delete-photo-id-text');
const deleteModalCancel  = document.getElementById('delete-modal-cancel');
const deleteModalConfirm = document.getElementById('delete-modal-confirm');

let activeDeleteImageId = null;

function openDeleteModal(imageId) {
  activeDeleteImageId = imageId;
  deletePhotoIdTxt.textContent = formatUserCode(imageId);

  // Populate phone or display 'No user registered'
  const phone = cardPhones.get(imageId);
  const phoneTxt = document.getElementById('delete-photo-phone');
  if (phoneTxt) {
    phoneTxt.textContent = phone ? `📲 ${phone}` : 'No user matched yet';
  }

  // Populate preview thumbnail
  const deletePreviewImg = document.getElementById('delete-preview-img');
  if (deletePreviewImg) {
    const previewEl = document.getElementById(`cp-${imageId}`);
    const thumbImg  = previewEl?.querySelector('img');
    deletePreviewImg.src = thumbImg?.src || '';
  }

  deleteModal.style.display = 'flex';
}

function closeDeleteModal() {
  deleteModal.style.display = 'none';
  activeDeleteImageId = null;
}

deleteModalCancel.addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });

deleteModalConfirm.addEventListener('click', async () => {
  if (!activeDeleteImageId) return;

  const imageId = activeDeleteImageId;
  deleteModalConfirm.disabled = true;
  deleteModalConfirm.textContent = 'Deleting...';

  try {
    const result = await window.api.deleteImage(imageId);
    if (result.success) {
      // Remove card from UI
      const card = imageCards.get(imageId);
      if (card) {
        card.remove();
        imageCards.delete(imageId);
        cardFilePaths.delete(imageId);
        cardPhones.delete(imageId);
        queueCount--;
        queueCountBadge.textContent = queueCount;
      }
      
      closeDeleteModal();
      appendLog({ level: 'info', message: `🗑️ Successfully deleted photo and database record for ${imageId}`, ts: new Date().toISOString() });
      
      // Show empty state if queue is now empty
      if (imageCards.size === 0) {
        updateEmptyState();
      }
      
      refreshStats();
    } else {
      alert(`Failed to delete image: ${result.error || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`Error deleting image: ${err.message}`);
  } finally {
    deleteModalConfirm.disabled = false;
    deleteModalConfirm.textContent = 'Delete';
  }
});

// ── Event Creation Modal ─────────────────────────────────────────────────────────

const sidebarEventSelect = document.getElementById('sidebar-event-select');

// Hides/disabled select when watching to prevent midway changes
function updateSidebarSelectState() {
  if (sidebarEventSelect) {
    sidebarEventSelect.disabled = isWatching;
  }
  if (btnSelect) {
    btnSelect.disabled = isWatching;
  }
}

let isPopulatingSidebarEvents = false;

async function populateSidebarEvents() {
  if (!sidebarEventSelect) return;
  if (isPopulatingSidebarEvents) return;
  isPopulatingSidebarEvents = true;

  try {
    const [config, events] = await Promise.all([
      window.api.getEventConfig().catch(() => ({})),
      window.api.getAllEvents().catch(() => [])
    ]);

    const activePrefix = (config.eventPrefix || '').toUpperCase();

    // Reset innerHTML synchronously right before appending
    sidebarEventSelect.innerHTML = `
      <option value="">-- No Active Event --</option>
      <option value="__create_new__">+ Create New Event...</option>
    `;

    let foundActive = false;
    if (events && events.length > 0) {
      const seen = new Set();
      for (const ev of events) {
        if (!ev || !ev.eventPrefix) continue;
        const prefixUpper = ev.eventPrefix.toUpperCase();
        if (seen.has(prefixUpper)) continue;
        seen.add(prefixUpper);

        const opt = document.createElement('option');
        opt.value = prefixUpper;
        opt.textContent = `${ev.eventName} (${prefixUpper})`;
        opt.setAttribute('data-name', ev.eventName);
        if (prefixUpper === activePrefix) {
          foundActive = true;
        }
        sidebarEventSelect.appendChild(opt);
      }
    }

    if (foundActive && activePrefix) {
      sidebarEventSelect.value = activePrefix;
      eventCreated = true;
    } else {
      sidebarEventSelect.value = '';
      eventCreated = false;
    }

    updateWatchButtonState();
    updateSidebarSelectState();
    updateEmptyState();
  } catch (err) {
    console.warn('Failed to load events for sidebar:', err);
  } finally {
    isPopulatingSidebarEvents = false;
  }
}

async function updateSidebarEvent(eventName, eventPrefix) {
  if (eventName !== undefined && eventPrefix !== undefined) {
    try {
      await window.api.saveEventConfig({ eventName, eventPrefix });
    } catch (_) {}
  }
  await populateSidebarEvents();
}

// Handle change directly on sidebar dropdown selection
if (sidebarEventSelect) {
  sidebarEventSelect.addEventListener('change', async () => {
    const val = sidebarEventSelect.value;
    if (val === '__create_new__') {
      openCreateEventModal();
      // Reset sidebar selection back to empty or saved config
      try {
        const cfg = await window.api.getEventConfig();
        sidebarEventSelect.value = cfg.eventPrefix ? cfg.eventPrefix.toUpperCase() : '';
      } catch (_) {
        sidebarEventSelect.value = '';
      }
      return;
    }

    if (!val) {
      // Deactivate event config
      try {
        await window.api.saveEventConfig({ eventName: '', eventPrefix: '' });
        eventCreated = false;
        updateWatchButtonState();
        updateEmptyState();
        appendLog({ level: 'info', message: '📂 Active event cleared', ts: new Date().toISOString() });
      } catch (err) {
        alert(`Failed to clear event: ${err.message}`);
      }
      return;
    }

    const selectedOption = sidebarEventSelect.options[sidebarEventSelect.selectedIndex];
    const eventPrefix = selectedOption.value;
    const eventName = selectedOption.getAttribute('data-name');

    try {
      await window.api.saveEventConfig({ eventName, eventPrefix });
      eventCreated = true;
      
      updateWatchButtonState();
      updateEmptyState();
      appendLog({ level: 'info', message: `📂 Switched active event to: "${eventName}" [${eventPrefix}]`, ts: new Date().toISOString() });
    } catch (err) {
      alert(`Failed to switch event: ${err.message}`);
    }
  });
}

// ── Create Event Modal ──
const eventCreateModal   = document.getElementById('event-create-modal');
const eventCreateTitle   = document.getElementById('event-create-title');
const eventCreatePrefix  = document.getElementById('event-create-prefix');
const eventCreateError   = document.getElementById('event-create-error');
const eventCreateCancel  = document.getElementById('event-create-cancel');
const eventCreateConfirm = document.getElementById('event-create-confirm');

function openCreateEventModal() {
  eventCreateError.style.display = 'none';
  eventCreateError.textContent = '';
  
  // Pre-populate fields with currently saved event config if available
  window.api.getEventConfig().then(config => {
    eventCreateTitle.value = config.eventName || '';
    eventCreatePrefix.value = config.eventPrefix || '';
  }).catch(() => {});

  eventCreateModal.style.display = 'flex';
  setTimeout(() => eventCreateTitle.focus(), 50);
}

function closeCreateEventModal() {
  eventCreateModal.style.display = 'none';
}

eventCreateCancel.addEventListener('click', closeCreateEventModal);
eventCreateModal.addEventListener('click', (e) => { if (e.target === eventCreateModal) closeCreateEventModal(); });

eventCreateConfirm.addEventListener('click', async () => {
  const eventName = eventCreateTitle.value.trim();
  const eventPrefix = eventCreatePrefix.value.trim().toUpperCase();

  if (!eventName || !eventPrefix) {
    eventCreateError.textContent = 'Please fill out both Event Title and Prefix.';
    eventCreateError.style.display = 'block';
    return;
  }

  eventCreateError.style.display = 'none';
  eventCreateConfirm.disabled = true;
  eventCreateConfirm.textContent = 'Creating...';

  try {
    // Fetch all events and check if the prefix already exists
    const events = await window.api.getAllEvents();
    const prefixExists = events.some(ev => ev.eventPrefix && ev.eventPrefix.toUpperCase() === eventPrefix);
    if (prefixExists) {
      eventCreateError.textContent = `Event prefix "${eventPrefix}" already exists. Please choose a different prefix.`;
      eventCreateError.style.display = 'block';
      return;
    }

    await window.api.saveEventConfig({ eventName, eventPrefix });
    eventCreated = true;
    
    updateWatchButtonState();

    // Update empty state view
    updateEmptyState();

    // Update sidebar display
    updateSidebarEvent(eventName, eventPrefix);

    appendLog({ level: 'info', message: `📅 Event created: "${eventName}" [${eventPrefix}]`, ts: new Date().toISOString() });
    closeCreateEventModal();
  } catch (err) {
    eventCreateError.textContent = `Failed to save: ${err.message}`;
    eventCreateError.style.display = 'block';
  } finally {
    eventCreateConfirm.disabled = false;
    eventCreateConfirm.textContent = 'Create';
  }
});

// ── Select Event Modal ──
const eventSelectModal   = document.getElementById('event-select-modal');
const eventSelectDropdown= document.getElementById('event-select-dropdown');
const eventSelectError   = document.getElementById('event-select-error');
const eventSelectCancel  = document.getElementById('event-select-cancel');
const eventSelectConfirm = document.getElementById('event-select-confirm');

async function openSelectEventModal() {
  eventSelectError.style.display = 'none';
  eventSelectError.textContent = '';
  
  // Populate existing events dropdown from MongoDB
  try {
    const events = await window.api.getAllEvents();
    eventSelectDropdown.innerHTML = '<option value="">-- Choose an Event --</option>';
    
    if (events && events.length > 0) {
      const seen = new Set();
      for (const ev of events) {
        if (!ev || !ev.eventPrefix) continue;
        const prefixUpper = ev.eventPrefix.toUpperCase();
        if (seen.has(prefixUpper)) continue;
        seen.add(prefixUpper);

        const opt = document.createElement('option');
        opt.value = prefixUpper;
        opt.textContent = `${ev.eventName} (${prefixUpper})`;
        opt.setAttribute('data-name', ev.eventName);
        eventSelectDropdown.appendChild(opt);
      }
    } else {
      eventSelectDropdown.innerHTML = '<option value="">No existing events in database.</option>';
    }
  } catch (err) {
    console.warn('Failed to load existing events:', err);
    eventSelectDropdown.innerHTML = '<option value="">Failed to load events.</option>';
  }

  // Highlight currently active event prefix in dropdown if possible
  try {
    const config = await window.api.getEventConfig();
    if (config.eventPrefix) {
      eventSelectDropdown.value = config.eventPrefix.toUpperCase();
    }
  } catch (_) {}

  eventSelectModal.style.display = 'flex';
}

function closeSelectEventModal() {
  eventSelectModal.style.display = 'none';
}

eventSelectCancel.addEventListener('click', closeSelectEventModal);
eventSelectModal.addEventListener('click', (e) => { if (e.target === eventSelectModal) closeSelectEventModal(); });

eventSelectConfirm.addEventListener('click', async () => {
  const selectedOption = eventSelectDropdown.options[eventSelectDropdown.selectedIndex];
  if (!selectedOption || !selectedOption.value) {
    eventSelectError.textContent = 'Please choose a valid event.';
    eventSelectError.style.display = 'block';
    return;
  }

  const eventPrefix = selectedOption.value;
  const eventName = selectedOption.getAttribute('data-name');

  eventSelectError.style.display = 'none';
  eventSelectConfirm.disabled = true;
  eventSelectConfirm.textContent = 'Selecting...';

  try {
    await window.api.saveEventConfig({ eventName, eventPrefix });
    eventCreated = true;
    
    updateWatchButtonState();

    // Update empty state view
    updateEmptyState();

    // Update sidebar display
    updateSidebarEvent(eventName, eventPrefix);

    appendLog({ level: 'info', message: `📂 Switched active event: "${eventName}" [${eventPrefix}]`, ts: new Date().toISOString() });
    closeSelectEventModal();
  } catch (err) {
    eventSelectError.textContent = `Failed to select event: ${err.message}`;
    eventSelectError.style.display = 'block';
  } finally {
    eventSelectConfirm.disabled = false;
    eventSelectConfirm.textContent = 'Select';
  }
});

// ── Button handlers ───────────────────────────────────────────────────────────

btnSelect.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  selectedFolder = folder;
  folderPathText.textContent = folder;
  updateWatchButtonState();
  appendLog({ level: 'info', message: `Folder selected: ${folder}`, ts: new Date().toISOString() });
  await loadImagesList(folder);
});

btnWatch.addEventListener('click', async () => {
  if (!selectedFolder) return;
  await window.api.startWatch(selectedFolder);
  isWatching = true;
  updateSidebarSelectState();
  document.body.classList.add('watching');
  btnWatch.style.display = 'none';
  btnStop.style.display  = 'inline-flex';
  appendLog({ level: 'info', message: '👁️  Watching started', ts: new Date().toISOString() });
  await loadImagesList(selectedFolder);
});

btnStop.addEventListener('click', async () => {
  await window.api.stopWatch();
  isWatching = false;
  updateSidebarSelectState();
  document.body.classList.remove('watching');
  btnStop.style.display  = 'none';
  btnWatch.style.display = 'inline-flex';
  appendLog({ level: 'info', message: '🛑 Watching stopped', ts: new Date().toISOString() });
});

btnRetry.addEventListener('click', async () => {
  const result = await window.api.retryFailed();
  if (result.error) {
    appendLog({ level: 'error', message: result.error, ts: new Date().toISOString() });
  } else {
    appendLog({ level: 'info', message: `🔄 Reset ${result.count} failed records to pending`, ts: new Date().toISOString() });
    refreshStats();
  }
});

// ── Search / filter ───────────────────────────────────────────────────────────

const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
let noResultsEl   = null;

function applySearch(query) {
  const q = (typeof query === 'string' ? query : searchInput.value).toLowerCase().trim();
  let visibleCount = 0;

  for (const [imageId, card] of imageCards.entries()) {
    // 1. Tab filter check
    const status = Array.from(card.classList).find(c => c !== 'queue-card' && c !== 'search-hidden' && c !== 'tab-hidden');
    let tabMatch = true;
    if (currentTab === 'sent') {
      tabMatch = (status === 'completed');
    } else if (currentTab === 'not-sent') {
      tabMatch = (status !== 'completed');
    }
    card.classList.toggle('tab-hidden', !tabMatch);

    // 2. Text search check
    const phone = cardPhones.get(imageId) || '';
    const searchMatch = !q
      || imageId.toLowerCase().includes(q)
      || phone.replace(/\D/g, '').includes(q.replace(/\D/g, ''))
      || phone.toLowerCase().includes(q);
    card.classList.toggle('search-hidden', !searchMatch);

    if (tabMatch && searchMatch) visibleCount++;
  }

  // Show/hide no-results message
  if (noResultsEl) noResultsEl.remove();
  noResultsEl = null;
  if (visibleCount === 0 && imageCards.size > 0) {
    noResultsEl = document.createElement('div');
    noResultsEl.className = 'no-results';
    
    if (q) {
      noResultsEl.innerHTML = `<div class="no-results-icon">🔍</div><p>No photos matching <strong>"${q}"</strong></p>`;
    } else {
       const tabName = currentTab === 'sent' ? 'Sent' : 'Not Sent';
       noResultsEl.innerHTML = `<div class="no-results-icon">📁</div><p>No <strong>${tabName}</strong> photos yet.</p>`;
    }
    queueList.appendChild(noResultsEl);
  }
}

// Tab Switcher logic
const tabBtns = document.querySelectorAll('.tab-btn');
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    // Update active state
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Set filter and apply
    currentTab = btn.dataset.filter;
    applySearch();
  });
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value;
  searchClear.style.display = q ? 'inline-flex' : 'none';
  applySearch(q);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.style.display = 'none';
  applySearch('');
  searchInput.focus();
});

// Allow Escape key to clear search
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') searchClear.click();
});

btnClearLog.addEventListener('click', () => { logOutput.innerHTML = ''; });

btnToggleLog.addEventListener('click', () => {
  const visible = contentArea.classList.toggle('log-visible');
  btnToggleLog.textContent = visible ? '📋 Hide Log' : '📋 Log';
  btnToggleLog.style.color = visible ? 'var(--accent)' : '';
});



// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const dbStatus = await window.api.getDbStatus();
  if (dbStatus.connected) {
    dbDot.className  = 'status-dot connected';
    dbStatusText.textContent = 'Connected';
    refreshStats();
  }

  // Get active frame status on start
  try {
    const { activeFrame: initialActiveFrame } = await window.api.getFrames();
    activeFrame = initialActiveFrame;
  } catch (err) {
    console.warn('Failed to get initial active frame:', err);
  }

  // Load Event Config and populate sidebar on startup
  try {
    await populateSidebarEvents();
  } catch (err) {
    console.warn('Failed to load event config:', err);
  }

  // Update empty state on startup
  updateEmptyState();

  // Restore last-used folder from config
  const saved = await window.api.getSavedFolder();
  if (saved) {
    selectedFolder = saved;
    folderPathText.textContent = saved;
    appendLog({ level: 'info', message: `📁 Restored folder: ${saved}`, ts: new Date().toISOString() });

    // Load initial images
    await loadImagesList(saved);

    // Sync UI if the backend is already watching the folder (e.g. after a page reload)
    const isAlreadyWatching = await window.api.isWatching();
    if (isAlreadyWatching) {
      isWatching = true;
      document.body.classList.add('watching');
      btnWatch.style.display = 'none';
      btnStop.style.display  = 'inline-flex';
      appendLog({ level: 'info', message: '👁️  Resumed watching session', ts: new Date().toISOString() });
    }
  }

  updateWatchButtonState();
  updateSidebarSelectState();
  updateCardActions();
  appendLog({ level: 'info', message: '🚀 WhatsApp Booth Uploader ready', ts: new Date().toISOString() });
})();

// ── Navigation & Frames ────────────────────────────────────────────────────────

const navQueue = document.getElementById('nav-queue');
const navFrames = document.getElementById('nav-frames');
const panelQueue = document.getElementById('panel-queue');
const panelFrames = document.getElementById('panel-frames');
const btnUploadFrame = document.getElementById('btn-upload-frame');
const framesList = document.getElementById('frames-list');

if (navQueue && navFrames) {
  navQueue.addEventListener('click', () => {
    navQueue.classList.add('active');
    navFrames.classList.remove('active');
    panelQueue.style.display = 'flex';
    panelFrames.style.display = 'none';
  });

  navFrames.addEventListener('click', () => {
    navFrames.classList.add('active');
    navQueue.classList.remove('active');
    panelFrames.style.display = 'flex';
    panelQueue.style.display = 'none';
    loadFrames();
  });
}

if (btnUploadFrame) {
  btnUploadFrame.addEventListener('click', async () => {
    const newFrame = await window.api.uploadFrame();
    if (newFrame) loadFrames();
  });
}

async function loadFrames() {
  if (!framesList) return;
  const { frames, activeFrame: backendActiveFrame, framesDir } = await window.api.getFrames();
  activeFrame = backendActiveFrame;
  framesList.innerHTML = '';
  
  if (frames.length === 0) {
    framesList.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">🖼️</div>
        <p>No frames uploaded yet.</p>
      </div>
    `;
    updateCardActions();
    return;
  }
  
  frames.forEach(frame => {
    const isActive = frame === activeFrame;
    const card = document.createElement('div');
    card.className = `queue-card frame-card ${isActive ? 'active-frame' : ''}`;
    
    card.style.cursor = 'pointer';
    card.title = 'Click to set as active';
    
    // File URL for local image
    const fileUrl = `file://${framesDir}/${frame}`;
    
    card.innerHTML = `
      <div class="card-preview frame-preview">
        <img src="${fileUrl}" style="width:100%; height:100%; object-fit:contain; z-index:1;" />
      </div>
      <div class="card-footer" style="display:flex; justify-content:space-between; align-items:center;">
        <div class="card-id" style="text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${frame}</div>
        <button class="btn btn-ghost btn-delete-frame" style="color:var(--error); padding:4px 8px; font-size:12px;">Delete</button>
      </div>
    `;
    
    // Make entire card clickable to set active
    card.addEventListener('click', async () => {
      await window.api.setActiveFrame(isActive ? null : frame); // toggle off if already active
      loadFrames();
    });
    
    // Delete btn
    card.querySelector('.btn-delete-frame').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete frame ${frame}?`)) {
        await window.api.deleteFrame(frame);
        loadFrames();
      }
    });
    
    framesList.appendChild(card);
  });
  updateCardActions();
}

