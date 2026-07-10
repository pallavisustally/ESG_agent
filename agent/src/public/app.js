document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  // Theme toggle (Gemini light/dark)
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  const savedTheme = localStorage.getItem('sustally-theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  if (themeIcon) themeIcon.setAttribute('data-lucide', savedTheme === 'dark' ? 'sun' : 'moon');

  themeToggleBtn?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('sustally-theme', next);
    if (themeIcon) {
      themeIcon.setAttribute('data-lucide', next === 'dark' ? 'sun' : 'moon');
      lucide.createIcons();
    }
  });

  // Initialize Markdown-it
  const md = window.markdownit({
    html: true,
    linkify: false,
    typographer: true
  });

  function escapeHtmlAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function normalizeSmartQuotes(text) {
    return String(text || '')
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
  }

  function buildCitationHtml(page, url) {
    const safeUrl = escapeHtmlAttr(url);
    const pageLabel = page ? `p. ${page}` : '';
    if (!safeUrl) {
      return pageLabel
        ? `<span class="metric-citation">${pageLabel}</span>`
        : '';
    }
    return `<span class="metric-citation">${pageLabel}${pageLabel ? ' ' : ''}<a href="${safeUrl}" class="citation-source-link" target="_blank" rel="noopener noreferrer">source</a></span>`;
  }

  /** Hide PDF URLs — show only p. N and a clickable "source" label. */
  function prepareCitationsForDisplay(text) {
    let out = normalizeSmartQuotes(text);

    out = out.replace(/p\.\s*(\d+)\s*\[source\]\(([^)]+)\)/gi, (_, page, url) =>
      buildCitationHtml(page, url.trim())
    );

    out = out.replace(/\[p\.\s*(\d+)\]\(([^)]+)\)/gi, (_, page, url) =>
      buildCitationHtml(page, url.trim())
    );

    out = out.replace(/\[source\]\(([^)]+)\)/gi, (_, url) =>
      buildCitationHtml(null, url.trim())
    );

    out = out.replace(/\[report\]\(([^)]+)\)/gi, (_, url) =>
      buildCitationHtml(null, url.trim())
    );

    // Repair broken HTML citations where href was stripped earlier
    out = out.replace(
      /p\.\s*(\d+)\s*<a\s+href="\s*"\s+class=["']citation-source-link["'][^>]*>source<\/a>/gi,
      (_, page) => `<span class="metric-citation">p. ${page} <span class="citation-missing">source</span></span>`
    );

    out = out.replace(/\n##\s*Sources[\s\S]*$/i, '');
    out = out.replace(/^\s*-\s*https?:\/\/\S+\.pdf\S*\s*$/gim, '');

    // Protect href values, then strip only bare PDF URLs in plain text
    const hrefSlots = [];
    out = out.replace(/href="([^"]*)"/gi, (match, url) => {
      const token = `__CITE_HREF_${hrefSlots.length}__`;
      hrefSlots.push(url);
      return `href="${token}"`;
    });
    out = out.replace(/(?<![="'\[(])\bhttps?:\/\/[^\s<>\)]+\.pdf[^\s<>\)]*/gi, '');
    hrefSlots.forEach((url, i) => {
      out = out.split(`__CITE_HREF_${i}__`).join(url);
    });

    return out;
  }

  /** During streaming, mask markdown citation syntax so URLs never flash on screen. */
  function maskCitationsForStreaming(text) {
    return String(text || '')
      .replace(/p\.\s*(\d+)\s*\[source\]\([^)]*\)?/gi, 'p. $1 source')
      .replace(/\[p\.\s*(\d+)\]\([^)]*\)?/gi, 'p. $1 source')
      .replace(/\[source\]\([^)]*\)?/gi, 'source')
      .replace(/\[report\]\([^)]*\)?/gi, 'source')
      .replace(/https?:\/\/\S+\.pdf\S*/gi, '')
      .replace(/\n##\s*Sources[\s\S]*$/i, '');
  }

  function enhanceCitationLinks(root) {
    root.querySelectorAll('a[href]').forEach((anchor) => {
      const href = (anchor.getAttribute('href') || '').trim();
      const label = anchor.textContent.trim().toLowerCase();

      if (!href || href === '#' || /^class=/i.test(href)) {
        const pageMatch = anchor.parentElement?.textContent?.match(/p\.\s*(\d+)/i);
        const fallback = document.createElement('span');
        fallback.className = 'citation-missing';
        fallback.textContent = pageMatch ? `p. ${pageMatch[1]} source` : 'source';
        anchor.replaceWith(fallback);
        return;
      }

      if (!/\.pdf/i.test(href) && label !== 'source' && label !== 'report') return;

      anchor.classList.add('citation-source-link');
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      if (label === 'source' || label === 'report') {
        anchor.textContent = 'source';
      }

      if (!anchor.closest('.metric-citation')) {
        const pageText = anchor.previousSibling?.textContent?.match(/p\.\s*\d+/i)?.[0] || '';
        const wrap = document.createElement('span');
        wrap.className = 'metric-citation';
        if (pageText && anchor.previousSibling?.nodeType === Node.TEXT_NODE) {
          anchor.previousSibling.textContent = anchor.previousSibling.textContent.replace(/p\.\s*\d+\s*$/i, '').trimEnd();
          wrap.appendChild(document.createTextNode(`${pageText} `));
        }
        anchor.parentNode.insertBefore(wrap, anchor);
        wrap.appendChild(anchor);
      }
    });
  }

  // State Variables
  // Guests: sessionStorage only (temporary per tab — new localhost tab = fresh chat).
  // Signed-in: localStorage cache + server persistence.
  const SIGNED_IN_SESSIONS_KEY = 'sustally_sessions';
  const GUEST_SESSIONS_KEY = 'sustally_guest_sessions';

  let sessions = [];
  let currentSessionId = null;
  let chatHistory = [];
  let isThinking = false;
  let dragCounter = 0;
  let currentUser = null;
  let authEnabled = false;
  let firebaseAuth = null;

  function isSignedIn() {
    return Boolean(currentUser);
  }

  function readGuestSessions() {
    try {
      return JSON.parse(sessionStorage.getItem(GUEST_SESSIONS_KEY)) || [];
    } catch {
      return [];
    }
  }

  function readSignedInSessionsCache() {
    try {
      return JSON.parse(localStorage.getItem(SIGNED_IN_SESSIONS_KEY)) || [];
    } catch {
      return [];
    }
  }

  function persistSessionsLocally() {
    if (isSignedIn()) {
      localStorage.setItem(SIGNED_IN_SESSIONS_KEY, JSON.stringify(sessions));
      return;
    }
    sessionStorage.setItem(GUEST_SESSIONS_KEY, JSON.stringify(sessions));
  }

  function clearGuestSessions() {
    sessionStorage.removeItem(GUEST_SESSIONS_KEY);
  }

  function resetToGuestFreshChat() {
    currentUser = null;
    sessions = [];
    clearGuestSessions();
    startNewChat();
    updateAuthUI();
    renderSessionList();
  }

  // DOM Elements
  const fileInput = document.getElementById('fileInput');
  const attachBtn = document.getElementById('attachBtn');
  const uploadProgressContainer = document.getElementById('uploadProgressContainer');
  const uploadStatusText = document.getElementById('uploadStatusText');
  const uploadPercentage = document.getElementById('uploadPercentage');
  const progressFill = document.getElementById('progressFill');
  const chatContainer = document.getElementById('chatContainer');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const agentStatusText = document.getElementById('agentStatusText');
  const agentLogsPanel = document.getElementById('agentLogsPanel');
  const closeLogsBtn = document.getElementById('closeLogsBtn');
  const logsContent = document.getElementById('logsContent');

  // New DOM Elements for UI Upgrade
  const newChatBtn = document.getElementById('newChatBtn');
  const chatHistoryList = document.getElementById('chatHistoryList');
  const viewReportsBtn = document.getElementById('viewReportsBtn');
  const reportsModal = document.getElementById('reportsModal');
  const closeReportsModalBtn = document.getElementById('closeReportsModalBtn');
  const reportsTableBody = document.getElementById('reportsTableBody');
  const reportsCountText = document.getElementById('reportsCount');
  const dragDropOverlay = document.getElementById('dragDropOverlay');
  const confirmDialog = document.getElementById('confirmDialog');
  const confirmDialogTitle = document.getElementById('confirmDialogTitle');
  const confirmDialogMessage = document.getElementById('confirmDialogMessage');
  const confirmDialogCancel = document.getElementById('confirmDialogCancel');
  const confirmDialogConfirm = document.getElementById('confirmDialogConfirm');

  // Mobile navigation selectors
  const menuToggleBtn = document.getElementById('menuToggleBtn');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const sidebar = document.querySelector('.sidebar');

  // Auth UI elements
  const signInBtn = document.getElementById('signInBtn');
  const userProfileMenu = document.getElementById('userProfileMenu');
  const userProfileBtn = document.getElementById('userProfileBtn');
  const userProfileName = document.getElementById('userProfileName');
  const userProfileDropdown = document.getElementById('userProfileDropdown');
  const userAvatar = document.getElementById('userAvatar');
  const userAvatarLarge = document.getElementById('userAvatarLarge');
  const userName = document.getElementById('userName');
  const userEmail = document.getElementById('userEmail');
  const signOutBtn = document.getElementById('signOutBtn');

  // Configuration state loaded from the server
  let serverConfig = {
    defaultModel: 'qwen2.5:7b',
    ollamaHost: 'http://localhost:11434',
    provider: 'ollama',
    firebase: null,
    authEnabled: false,
  };

  function closeProfileDropdown() {
    userProfileDropdown?.classList.add('hidden');
    userProfileBtn?.setAttribute('aria-expanded', 'false');
  }

  function updateAuthUI() {
    if (currentUser) {
      signInBtn?.classList.add('hidden');
      userProfileMenu?.classList.remove('hidden');

      const avatarUrl = currentUser.picture || '';
      const fallbackName = currentUser.name || currentUser.email || 'User';

      if (userAvatar) {
        userAvatar.src = avatarUrl;
        userAvatar.alt = fallbackName;
        userAvatar.onerror = () => {
          userAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=4285F4&color=fff&size=64`;
        };
      }
      if (userAvatarLarge) {
        userAvatarLarge.src = avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=4285F4&color=fff&size=80`;
        userAvatarLarge.alt = fallbackName;
      }
      if (userProfileName) {
        userProfileName.textContent = currentUser.name || currentUser.email || 'Profile';
      }
      if (userName) userName.textContent = currentUser.name || 'Signed in';
      if (userEmail) userEmail.textContent = currentUser.email || '';
    } else {
      userProfileMenu?.classList.add('hidden');
      closeProfileDropdown();
      if (userProfileName) {
        userProfileName.textContent = '';
      }
      if (authEnabled) {
        signInBtn?.classList.remove('hidden');
      } else {
        signInBtn?.classList.add('hidden');
      }
    }
  }

  function initFirebaseAuth() {
    if (!authEnabled || !serverConfig.firebase || typeof firebase === 'undefined') {
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(serverConfig.firebase);
    }
    firebaseAuth = firebase.auth();
  }

  async function completeSignIn(userPayload) {
    currentUser = userPayload;

    // Prefer in-tab guest chats; also pick up any legacy localStorage guest history once.
    const guestSessions = readGuestSessions();
    const legacyLocal = readSignedInSessionsCache();
    const toMigrate = guestSessions.length > 0 ? guestSessions : legacyLocal;

    if (toMigrate.length > 0) {
      const migrateRes = await fetch('/api/sessions/migrate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: toMigrate }),
      });
      const migrateData = await migrateRes.json();
      if (migrateRes.ok && migrateData.success) {
        sessions = migrateData.sessions || [];
        persistSessionsLocally();
      } else {
        await loadSessionsFromServer();
      }
    } else {
      await loadSessionsFromServer();
    }

    clearGuestSessions();
    updateAuthUI();
    renderSessionList();

    if (sessions.length > 0) {
      loadSession(sessions[0].id);
    } else {
      startNewChat();
    }
  }

  async function exchangeFirebaseToken(idToken) {
    const res = await fetch('/api/auth/firebase', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Sign-in failed.');
    }
    await completeSignIn(data.user);
  }

  async function signInWithGoogle() {
    if (!firebaseAuth) {
      throw new Error('Firebase is not initialized.');
    }

    signInBtn.disabled = true;
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const result = await firebaseAuth.signInWithPopup(provider);
      const idToken = await result.user.getIdToken();
      await exchangeFirebaseToken(idToken);
    } finally {
      signInBtn.disabled = false;
    }
  }

  async function loadSessionsFromServer() {
    const res = await fetch('/api/sessions', { credentials: 'include' });
    if (!res.ok) return;

    const data = await res.json();
    if (data.success && Array.isArray(data.sessions)) {
      sessions = data.sessions;
      persistSessionsLocally();
    }
  }

  async function refreshAuthState() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) {
        currentUser = null;
        sessions = readGuestSessions();
        return;
      }

      const data = await res.json();
      if (data.authenticated && data.user) {
        currentUser = data.user;
        await loadSessionsFromServer();
      } else {
        // Not signed in: temporary tab-only chats (never restore from localStorage).
        currentUser = null;
        sessions = readGuestSessions();
      }
    } catch (err) {
      console.warn('Failed to load auth state:', err);
      currentUser = null;
      sessions = readGuestSessions();
    } finally {
      updateAuthUI();
    }
  }

  async function signOut() {
    try {
      if (firebaseAuth) {
        await firebaseAuth.signOut();
      }
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.warn('Sign-out request failed:', err);
    }

    closeProfileDropdown();
    // Guest mode: do not keep signed-in history in the sidebar.
    resetToGuestFreshChat();
  }

  function setupAuthListeners() {
    signInBtn?.addEventListener('click', () => {
      signInWithGoogle().catch((err) => {
        console.error('Firebase sign-in failed:', err);
        alert(`Sign-in failed: ${err.message}`);
      });
    });

    userProfileBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !userProfileDropdown?.classList.contains('hidden');
      if (isOpen) {
        closeProfileDropdown();
      } else {
        userProfileDropdown?.classList.remove('hidden');
        userProfileBtn?.setAttribute('aria-expanded', 'true');
      }
    });

    signOutBtn?.addEventListener('click', () => {
      signOut();
    });

    document.addEventListener('click', (e) => {
      if (!userProfileMenu?.contains(e.target)) {
        closeProfileDropdown();
      }
    });
  }

  async function persistSessionToServer(session) {
    if (!currentUser || !session) return;

    await fetch('/api/sessions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: session.id,
        title: session.title,
        history: session.history,
        timestamp: session.timestamp,
      }),
    });
  }

  const getOllamaHost = () => {
    if (serverConfig.provider === 'openrouter') return null;
    return localStorage.getItem('ollama_host') || serverConfig.ollamaHost;
  };
  const getOllamaModel = () => {
    if (serverConfig.provider === 'openrouter') return serverConfig.defaultModel;
    return localStorage.getItem('ollama_model') || serverConfig.defaultModel;
  };

  // Mobile Sidebar Toggle mechanics
  if (menuToggleBtn && sidebarBackdrop && sidebar) {
    menuToggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      sidebarBackdrop.classList.toggle('hidden');
    });

    sidebarBackdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.add('hidden');
    });
  }

  function closeMobileSidebar() {
    if (sidebar && sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
    }
    if (sidebarBackdrop && !sidebarBackdrop.classList.contains('hidden')) {
      sidebarBackdrop.classList.add('hidden');
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Theme-matched confirm dialog centered in the tab. Returns true if confirmed. */
  function showConfirmDialog({
    title = 'Are you sure?',
    message = 'This cannot be undone.',
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
  } = {}) {
    return new Promise((resolve) => {
      if (!confirmDialog) {
        resolve(window.confirm(message));
        return;
      }

      confirmDialogTitle.textContent = title;
      confirmDialogMessage.textContent = message;
      confirmDialogConfirm.textContent = confirmLabel;
      confirmDialogCancel.textContent = cancelLabel;
      confirmDialog.classList.remove('hidden');
      if (typeof lucide !== 'undefined') lucide.createIcons();
      confirmDialogConfirm.focus();

      const cleanup = (result) => {
        confirmDialog.classList.add('hidden');
        confirmDialogCancel.removeEventListener('click', onCancel);
        confirmDialogConfirm.removeEventListener('click', onConfirm);
        confirmDialog.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };

      const onCancel = () => cleanup(false);
      const onConfirm = () => cleanup(true);
      const onOverlay = (e) => {
        if (e.target === confirmDialog) cleanup(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') cleanup(false);
        if (e.key === 'Enter') {
          e.preventDefault();
          cleanup(true);
        }
      };

      confirmDialogCancel.addEventListener('click', onCancel);
      confirmDialogConfirm.addEventListener('click', onConfirm);
      confirmDialog.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);
    });
  }

  // Render Session List in Sidebar
  function renderSessionList() {
    if (sessions.length === 0) {
      const emptyHint = isSignedIn()
        ? 'No recent chats'
        : (authEnabled
          ? 'Temporary chat — sign in to save history'
          : 'No recent chats');
      chatHistoryList.innerHTML = `<div class="empty-state"><p>${emptyHint}</p></div>`;
      return;
    }

    chatHistoryList.innerHTML = '';
    sessions.forEach(session => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `chat-history-item ${session.id === currentSessionId ? 'active' : ''}`;
      item.setAttribute('data-session-id', session.id);
      item.innerHTML = `
        <span class="chat-history-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span>
        <span class="chat-history-delete" title="Delete" role="button"><i data-lucide="x"></i></span>
      `;

      // Click to load session
      item.addEventListener('click', (e) => {
        if (e.target.closest('.chat-history-delete')) return;
        loadSession(session.id);
      });

      // Delete session
      const deleteBtn = item.querySelector('.chat-history-delete');
      deleteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const ok = await showConfirmDialog({
          title: 'Delete conversation?',
          message: `Delete “${session.title}”? This cannot be undone.`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        });
        if (ok) {
          deleteSession(session.id);
        }
      });

      chatHistoryList.appendChild(item);
    });

    lucide.createIcons();
  }

  // Save/Update Session (guest: sessionStorage; signed-in: localStorage + server)
  function saveCurrentSession() {
    if (chatHistory.length === 0) return;

    let sessionToPersist = null;

    if (!currentSessionId) {
      currentSessionId = 'session_' + Date.now();
      const firstUserMsg = chatHistory.find(m => m.role === 'user');
      let title = 'New Sustainability Analysis';
      if (firstUserMsg) {
        title = firstUserMsg.content.length > 28
          ? firstUserMsg.content.substring(0, 28) + '...'
          : firstUserMsg.content;
      }

      sessionToPersist = {
        id: currentSessionId,
        title: title,
        history: chatHistory,
        timestamp: Date.now()
      };

      sessions.unshift(sessionToPersist);
    } else {
      const idx = sessions.findIndex(s => s.id === currentSessionId);
      if (idx !== -1) {
        sessions[idx].history = chatHistory;
        sessions[idx].timestamp = Date.now();
        const updatedSession = sessions.splice(idx, 1)[0];
        sessions.unshift(updatedSession);
        sessionToPersist = updatedSession;
      }
    }

    persistSessionsLocally();
    renderSessionList();

    if (isSignedIn() && sessionToPersist) {
      persistSessionToServer(sessionToPersist).catch((err) => {
        console.warn('Failed to save session to server:', err);
      });
    }
  }

  // Load selected session
  function loadSession(id) {
    const session = sessions.find(s => s.id === id);
    if (!session) return;

    currentSessionId = session.id;
    chatHistory = [...session.history];

    // Clear chat display
    chatContainer.innerHTML = '';

    // Render message bubbles
    chatHistory.forEach(msg => {
      appendMessageBubble(msg.role, msg.content);
    });

    renderSessionList();
    agentLogsPanel.classList.add('hidden');
    closeMobileSidebar();
  }

  // Delete session
  function deleteSession(id) {
    sessions = sessions.filter(s => s.id !== id);
    persistSessionsLocally();

    if (isSignedIn()) {
      fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch((err) => {
        console.warn('Failed to delete session on server:', err);
      });
    }

    if (currentSessionId === id) {
      startNewChat();
    } else {
      renderSessionList();
    }
  }

  // Start New Chat Session
  function startNewChat() {
    currentSessionId = null;
    chatHistory = [];
    chatContainer.innerHTML = '';
    appendWelcomeMessage();
    renderSessionList();
    agentLogsPanel.classList.add('hidden');
    closeMobileSidebar();
  }

  // Attach elements click events
  newChatBtn.addEventListener('click', startNewChat);

  // Textarea Auto-Resize and Send Trigger
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = (chatInput.scrollHeight) + 'px';
    sendBtn.disabled = chatInput.value.trim().length === 0 || isThinking;
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // Close Agent Logs Panel
  closeLogsBtn.addEventListener('click', () => {
    agentLogsPanel.classList.add('hidden');
  });

  // Paperclip button trigger file click
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileUpload(fileInput.files[0]);
    }
  });

  // Full-Window Drag & Drop Events
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      dragDropOverlay.classList.remove('hidden');
    }
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dragDropOverlay.classList.add('hidden');
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dragDropOverlay.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dragDropOverlay.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragDropOverlay.classList.add('hidden');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });

  // Handle XML/XBRL Upload via AJAX
  function handleFileUpload(file) {
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (ext !== '.xml' && ext !== '.xbrl') {
      alert('Only XML or XBRL documents are allowed.');
      return;
    }

    uploadProgressContainer.classList.remove('hidden');
    uploadStatusText.textContent = `Uploading "${file.name}"...`;
    progressFill.style.width = '20%';
    uploadPercentage.textContent = '20%';

    const formData = new FormData();
    formData.append('xbrl', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload-custom', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percentComplete = Math.round((e.loaded / e.total) * 40) + 20;
        progressFill.style.width = `${percentComplete}%`;
        uploadPercentage.textContent = `${percentComplete}%`;
        if (percentComplete >= 60) {
          uploadStatusText.textContent = 'Parsing taxonomy and validating schema...';
        }
      }
    };

    xhr.onload = function() {
      if (xhr.status === 200) {
        progressFill.style.width = '100%';
        uploadPercentage.textContent = '100%';
        uploadStatusText.textContent = 'Filing processed successfully!';
        
        let responseData = null;
        try {
          responseData = JSON.parse(xhr.responseText);
        } catch(e) {}

        setTimeout(() => {
          uploadProgressContainer.classList.add('hidden');
          
          if (responseData && responseData.records && responseData.records.length > 0) {
            const company = responseData.records[0].company;
            
            // Remove welcome message card if present
            const welcome = chatContainer.querySelector('.chat-welcome');
            if (welcome) {
              chatContainer.removeChild(welcome);
            }
            
            const msgText = `📥 **XBRL Report Uploaded & Indexed Successfully**\n\nI have successfully parsed and indexed the BRSR data for **${company}**:\n* ${responseData.records.map(r => `**FY ${r.year}** (Year ${r.year})`).join('\n* ')}\n\nThis data is now stored in the database. You can ask me questions or request comparisons for this company!`;
            
            appendMessageBubble('assistant', msgText);
            chatHistory.push({ role: 'assistant', content: msgText });
            saveCurrentSession();
          }
          
          fetchStatus();
        }, 1500);
      } else {
        let errMsg = 'Failed to process XML report.';
        try {
          const res = JSON.parse(xhr.responseText);
          errMsg = res.error || errMsg;
        } catch(e) {}
        
        uploadStatusText.textContent = 'Processing failed!';
        progressFill.style.width = '0%';
        uploadPercentage.textContent = '0%';
        alert(`Error: ${errMsg}`);
        setTimeout(() => {
          uploadProgressContainer.classList.add('hidden');
        }, 3000);
      }
    };

    xhr.onerror = function() {
      uploadStatusText.textContent = 'Network error!';
      alert('Network error occurred during upload.');
      uploadProgressContainer.classList.add('hidden');
    };

    xhr.send(formData);
  }

  // Reports Management Modal Controls
  viewReportsBtn.addEventListener('click', () => {
    reportsModal.classList.remove('hidden');
    fetchStatus();
  });

  closeReportsModalBtn.addEventListener('click', () => {
    reportsModal.classList.add('hidden');
  });

  reportsModal.addEventListener('click', (e) => {
    if (e.target === reportsModal) {
      reportsModal.classList.add('hidden');
    }
  });

  // Fetch Database Status and Available Reports
  async function fetchStatus() {
    try {
      const response = await fetch('/api/status');
      const data = await response.json();

      if (data.success) {
        reportsCountText.textContent = data.reportsCount;
        renderReportsTable(data.reports);
      }
    } catch (error) {
      console.error('Error fetching database status:', error);
    }
  }

  // Render modal reports database table
  function renderReportsTable(reports) {
    if (reports.length === 0) {
      reportsTableBody.innerHTML = `
        <tr>
          <td colspan="4" class="empty-state" style="padding: 40px 0;">
            <i data-lucide="files" class="empty-icon"></i>
            <p>No reports indexed in database yet.</p>
          </td>
        </tr>
      `;
      lucide.createIcons();
      return;
    }

    reportsTableBody.innerHTML = '';
    
    reports.forEach(report => {
      const tr = document.createElement('tr');
      
      const customBadge = report.isCustom 
        ? '<span class="badge-custom">Custom</span>' 
        : '<span style="font-size:11px; color:var(--text-muted);">Standard</span>';
      
      tr.innerHTML = `
        <td style="font-weight: 500; color: var(--text-main);">${report.company}</td>
        <td>FY${report.year}</td>
        <td>${customBadge}</td>
        <td>
          <button class="delete-report-btn" title="Delete report index">
            <i data-lucide="trash-2"></i>
          </button>
        </td>
      `;

      const deleteBtn = tr.querySelector('.delete-report-btn');
      deleteBtn.addEventListener('click', async () => {
        const ok = await showConfirmDialog({
          title: 'Delete report index?',
          message: `Delete the index for ${report.company} (FY${report.year})? This cannot be undone.`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        });
        if (!ok) return;
        try {
          const res = await fetch('/api/delete-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              company: report.company,
              year: report.year,
              filename: report.filename
            })
          });
          const status = await res.json();
          if (status.success) {
            fetchStatus();
          } else {
            alert(`Error deleting report: ${status.error}`);
          }
        } catch(err) {
          console.error('Delete error:', err);
        }
      });

      reportsTableBody.appendChild(tr);
    });
    
    lucide.createIcons();
  }

  // Append Welcome Message
  function appendWelcomeMessage() {
    const welcome = document.createElement('div');
    welcome.className = 'chat-welcome';
    welcome.innerHTML = `
      <div class="welcome-gemini-icon"><span class="gemini-gradient">✦</span></div>
      <h1 class="welcome-greeting">Hello</h1>
      <p class="welcome-sub">Ask anything about BRSR &amp; ESG sustainability data</p>
      <div class="quick-prompts-grid">
        <button class="quick-prompt-card" data-prompt="Analyze and compare Scope 1 emissions and renewable energy share of Infosys Limited and Asian Paints Limited in 2026. Include a bar chart.">
          <span class="prompt-text">Compare Infosys vs Asian Paints emissions</span>
        </button>
        <button class="quick-prompt-card" data-prompt="Analyze the Scope 1 and Scope 2 emissions trend for Infosys Limited from 2025 to 2026. Include a line chart with your analysis.">
          <span class="prompt-text">Infosys emissions trend</span>
        </button>
        <button class="quick-prompt-card" data-prompt="Analyze average carbon emissions intensity across all sectors in 2025. Rank sectors and show a pie chart of sector share.">
          <span class="prompt-text">Carbon intensity by sector</span>
        </button>
        <button class="quick-prompt-card" id="customXmlPrompt" data-prompt="Analyze the top 5 companies with the highest female employee share in 2025. Show a bar chart and a pie chart of their relative shares.">
          <span class="prompt-text">Top companies by female workforce share</span>
        </button>
      </div>
    `;

    welcome.querySelectorAll('.quick-prompt-card').forEach(btn => {
      btn.addEventListener('click', () => {
        chatInput.value = btn.getAttribute('data-prompt');
        chatInput.dispatchEvent(new Event('input'));
        sendMessage();
      });
    });

    chatContainer.appendChild(welcome);
    lucide.createIcons();
  }

  // Handle Quick Actions
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.quick-prompt-card');
    if (card && chatContainer.contains(card)) {
      chatInput.value = card.getAttribute('data-prompt');
      chatInput.dispatchEvent(new Event('input'));
      chatInput.focus();
    }
  });

  // Append message bubble
  function appendMessageBubble(role, contentText) {
    const welcome = chatContainer.querySelector('.chat-welcome');
    if (welcome) {
      chatContainer.removeChild(welcome);
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = `<i data-lucide="${role === 'user' ? 'user' : 'sparkles'}"></i>`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    
    if (role === 'user') {
      bubble.textContent = contentText;
    } else {
      renderAssistantBubble(bubble, contentText);
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(bubble);
    chatContainer.appendChild(messageDiv);
    
    chatContainer.scrollTop = chatContainer.scrollHeight;
    lucide.createIcons();
    return bubble;
  }

  // Render assistant bubble (supporting markdown, KaTeX, and Chart.js parsing)
  function renderAssistantBubble(bubbleElement, text) {
    // Find target element to write content to
    let targetElement = bubbleElement.querySelector('.assistant-content-text');
    if (!targetElement) {
      targetElement = bubbleElement;
      bubbleElement.innerHTML = '';
    } else {
      targetElement.innerHTML = '';
    }

    // 1. Extract charts
    // Support ```json-chart```, ```chart``` and ```json``` fences that contain chart configs
    const chartRegex = /```(json-chart|chart|json)\s*([\s\S]*?)\s*```/g;
    let match;
    const chartsToRender = [];
    let cleanedText = text;

    while ((match = chartRegex.exec(text)) !== null) {
      try {
        const fenceType = match[1];
        const jsonPayload = match[2];

        const chartData = JSON.parse(jsonPayload.trim());

        // Only treat this block as a chart if it looks like a chart config
        const looksLikeChart =
          chartData &&
          (chartData.type === 'chart' ||
            chartData.chartType ||
            Array.isArray(chartData.datasets) ||
            Array.isArray(chartData.series) ||
            (chartData.data && (Array.isArray(chartData.data) || Array.isArray(chartData.data?.datasets))));

        if (!looksLikeChart) {
          // Skip replacing this block; leave JSON rendered as normal code
          continue;
        }

        const chartId = 'chart-' + Math.random().toString(36).substring(2, 9);
        chartsToRender.push({ id: chartId, data: chartData });
        cleanedText = cleanedText.replace(match[0], `<div class="chart-placeholder" data-chart-id="${chartId}"></div>`);
      } catch (err) {
        console.error('Failed to parse chart JSON:', err, match[2]);
      }
    }

    // 2. Extract math block and inline formulas before markdown-it consumes backslashes
    const mathBlocks = [];
    
    // Extract block math: \[ ... \]
    cleanedText = cleanedText.replace(/\\\[([\s\S]*?)\\\]/g, (match, formula) => {
      try {
        const html = katex.renderToString(formula, { displayMode: true, throwOnError: false });
        const id = `MATHBLOCKPLACEHOLDER${mathBlocks.length}`;
        mathBlocks.push({ id, html });
        return id;
      } catch (err) {
        console.error(err);
        return match;
      }
    });

    // Extract block math: $$ ... $$
    cleanedText = cleanedText.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
      try {
        const html = katex.renderToString(formula, { displayMode: true, throwOnError: false });
        const id = `MATHBLOCKPLACEHOLDER${mathBlocks.length}`;
        mathBlocks.push({ id, html });
        return id;
      } catch (err) {
        console.error(err);
        return match;
      }
    });

    // Extract inline math: \( ... \)
    cleanedText = cleanedText.replace(/\\\(([\s\S]*?)\\\)/g, (match, formula) => {
      try {
        const html = katex.renderToString(formula, { displayMode: false, throwOnError: false });
        const id = `MATHBLOCKPLACEHOLDER${mathBlocks.length}`;
        mathBlocks.push({ id, html });
        return id;
      } catch (err) {
        console.error(err);
        return match;
      }
    });

    // Extract inline math: $ ... $ (avoiding basic numeric matching)
    cleanedText = cleanedText.replace(/\$([^\$\n]+)\$/g, (match, formula) => {
      try {
        if (/^\d+(\.\d+)?$/.test(formula)) return match;
        const html = katex.renderToString(formula, { displayMode: false, throwOnError: false });
        const id = `MATHBLOCKPLACEHOLDER${mathBlocks.length}`;
        mathBlocks.push({ id, html });
        return id;
      } catch (err) {
        console.error(err);
        return match;
      }
    });

    // 3. Render markdown (citations converted to hidden-link HTML first)
    let htmlResult = md.render(prepareCitationsForDisplay(cleanedText));

    // 4. Re-inject KaTeX equations
    mathBlocks.forEach(block => {
      htmlResult = htmlResult.replaceAll(block.id, block.html);
    });

    targetElement.innerHTML = htmlResult;
    enhanceCitationLinks(targetElement);

    // 5. Draw charts
    const placeholders = targetElement.querySelectorAll('.chart-placeholder');
    placeholders.forEach(ph => {
      const chartId = ph.getAttribute('data-chart-id');
      const chartItem = chartsToRender.find(c => c.id === chartId);
      if (chartItem) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-container-box';
        const isPieChart = chartItem.data.chartType === 'pie' || chartItem.data.chartType === 'doughnut';
        wrapper.innerHTML = `
          <div class="chart-title">${chartItem.data.title || 'Data Comparison'}</div>
          <div class="chart-canvas-wrapper${isPieChart ? ' pie-chart' : ''}">
            <canvas id="${chartId}"></canvas>
          </div>
        `;
        ph.parentNode.replaceChild(wrapper, ph);

        setTimeout(() => {
          drawChart(chartId, chartItem.data);
        }, 0);
      }
    });
  }

  // Draw Chart.js visualization
  function drawChart(canvasId, chartData) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const chartType = chartData.chartType || 'bar';
    const isPie = chartType === 'pie' || chartType === 'doughnut';
    const isLine = chartType === 'line';

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(60,64,67,0.08)';
    const tickColor = isDark ? '#9aa0a6' : '#70757a';
    const legendColor = isDark ? '#e3e3e3' : '#1f1f1f';

    const palette = [
      { fill: 'rgba(66, 133, 244, 0.75)', border: '#4285f4' },
      { fill: 'rgba(155, 114, 203, 0.75)', border: '#9b72cb' },
      { fill: 'rgba(217, 101, 112, 0.75)', border: '#d96570' },
      { fill: 'rgba(52, 168, 83, 0.75)', border: '#34a853' },
      { fill: 'rgba(251, 188, 4, 0.75)', border: '#fbbc04' },
      { fill: 'rgba(255, 109, 1, 0.75)', border: '#ff6d01' },
      { fill: 'rgba(24, 128, 128, 0.75)', border: '#188080' },
      { fill: 'rgba(234, 67, 53, 0.75)', border: '#ea4335' },
    ];

    const datasets = chartData.datasets.map((ds, idx) => {
      const color = palette[idx % palette.length];

      if (isPie) {
        const sliceCount = Math.max(ds.data?.length || 0, chartData.labels?.length || 0);
        const sliceColors = Array.from({ length: sliceCount }, (_, i) => palette[i % palette.length]);
        return {
          label: ds.label,
          data: ds.data,
          backgroundColor: sliceColors.map((c) => c.fill),
          borderColor: sliceColors.map((c) => c.border),
          borderWidth: 2,
        };
      }

      return {
        label: ds.label,
        data: ds.data,
        backgroundColor: isLine ? 'transparent' : color.fill,
        borderColor: color.border,
        borderWidth: 2,
        pointBackgroundColor: color.border,
        pointBorderColor: '#fff',
        pointHoverRadius: 6,
        tension: 0.35,
        fill: isLine ? false : true,
      };
    });

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: isPie ? 'right' : 'top',
          labels: {
            color: legendColor,
            font: { family: 'Roboto', size: 12 },
            boxWidth: 12,
            padding: 12,
          },
        },
        tooltip: {
          backgroundColor: isDark ? '#282a2c' : '#ffffff',
          titleColor: legendColor,
          bodyColor: tickColor,
          borderColor: gridColor,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          callbacks: isPie
            ? {
                label: (ctx) => {
                  const value = ctx.parsed ?? ctx.raw;
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = total ? ((value / total) * 100).toFixed(1) : 0;
                  return `${ctx.label}: ${value} (${pct}%)`;
                },
              }
            : undefined,
        },
      },
    };

    if (!isPie) {
      options.scales = {
        y: {
          grid: { color: gridColor, drawBorder: false },
          ticks: { color: tickColor, font: { family: 'Roboto', size: 11 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: tickColor, font: { family: 'Roboto', size: 11 }, maxRotation: 45 },
        },
      };
    }

    new Chart(ctx, {
      type: chartType,
      data: {
        labels: chartData.labels,
        datasets,
      },
      options,
    });
  }

  // Update Agent Status UI
  function setAgentStatus(status, text) {
    const short = text.length > 32 ? text.slice(0, 30) + '…' : text;
    agentStatusText.textContent = status === 'thinking' ? 'Thinking…' : (status === 'idle' ? 'Ready' : short);
    agentStatusText.className = 'model-chip-sub';
    if (status === 'thinking') agentStatusText.classList.add('thinking');
  }

  // Log Step to Reasoning Panel (panel stays hidden unless user opens it)
  function logReasoningStep(stepData) {
    // Do not auto-open agentLogsPanel — keeps UI focused on the answer
    
    const logRow = document.createElement('div');
    logRow.className = 'log-entry';
    
    const timeStr = new Date().toLocaleTimeString([], { hour12: false });
    
    let messageText = '';
    let textClass = 'log-text';
    
    if (stepData.status === 'user_question') {
      messageText = `User Question: "${stepData.message}"`;
      textClass = 'log-text highlight';
    } else if (stepData.status === 'thinking') {
      messageText = `Agent executing reasoning iteration ${stepData.loop}...`;
      textClass = 'log-text highlight';
    } else if (stepData.status === 'tool_start') {
      messageText = `Tool call: ${stepData.tool} -> ${stepData.message}`;
      textClass = 'log-text highlight';
    } else if (stepData.status === 'tool_end') {
      messageText = `Tool return: ${stepData.message}`;
      textClass = 'log-text success';
    }
    
    logRow.innerHTML = `
      <span class="log-time">[${timeStr}]</span>
      <span class="${textClass}">${messageText}</span>
    `;
    
    logsContent.appendChild(logRow);
    logsContent.scrollTop = logsContent.scrollHeight;
  }

  // Send Message and Stream Agent Loop
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isThinking) return;

    isThinking = true;
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendBtn.disabled = true;
    logsContent.innerHTML = '';

    // Log the user question to reasoning logs
    logReasoningStep({ status: 'user_question', message: text });

    // Append to UI
    appendMessageBubble('user', text);

    // Save user message to current chatHistory
    chatHistory.push({ role: 'user', content: text });

    // Initialize Assistant Bubble with Thought Accordion skeleton
    const assistantBubble = appendMessageBubble('assistant', '');
    assistantBubble.innerHTML = `
      <div class="thought-container collapsed compact">
        <div class="thought-header">
          <div class="thought-header-left">
            <i data-lucide="loader-2" class="thought-brain-icon thinking"></i>
            <span class="thought-header-text">Analyzing...</span>
          </div>
          <div class="thought-header-right">
            <i data-lucide="chevron-down" class="thought-chevron"></i>
          </div>
        </div>
        <div class="thought-body">
          <div class="thought-steps"></div>
        </div>
      </div>
      <div class="assistant-content-text">
        <p class="preparing-text status-line">Querying BRSR database...</p>
      </div>
    `;

    // Bind collapsible click handler
    const thoughtHeader = assistantBubble.querySelector('.thought-header');
    const thoughtContainer = assistantBubble.querySelector('.thought-container');
    if (thoughtHeader && thoughtContainer) {
      thoughtHeader.addEventListener('click', () => {
        thoughtContainer.classList.toggle('collapsed');
      });
    }

    setAgentStatus('thinking', 'Thinking - Initializing agent loop');
    lucide.createIcons();

    // Default parameters sent to the backend
    const modelName = getOllamaModel();
    const ollamaHost = getOllamaHost();
    const requestBody = {
      message: text,
      chatHistory: chatHistory.slice(0, -1),
    };
    if (serverConfig.provider !== 'openrouter') {
      requestBody.modelName = modelName;
      requestBody.ollamaHost = ollamaHost;
    }

    // Step state tracking
    let activeStepRow = null;
    let streamBuffer = '';

    function completeActiveStep(isError = false) {
      if (activeStepRow) {
        activeStepRow.classList.remove('active');
        const iconDiv = activeStepRow.querySelector('.step-status-icon');
        if (iconDiv) {
          iconDiv.className = `step-status-icon ${isError ? 'error' : 'success'}`;
          iconDiv.innerHTML = `<i data-lucide="${isError ? 'alert-circle' : 'check'}"></i>`;
        }
        activeStepRow = null;
      }
    }

    function addStepRow(stepText) {
      const stepsContainer = assistantBubble.querySelector('.thought-steps');
      if (!stepsContainer) return null;

      const stepRow = document.createElement('div');
      stepRow.className = 'thought-step-row active';
      stepRow.innerHTML = `
        <div class="step-status-icon active-spinner">
          <i data-lucide="loader-2"></i>
        </div>
        <div class="thought-step-text"></div>
      `;
      stepRow.querySelector('.thought-step-text').textContent = stepText;
      stepsContainer.appendChild(stepRow);
      
      activeStepRow = stepRow;
      
      lucide.createIcons();
      chatContainer.scrollTop = chatContainer.scrollHeight;
      return stepRow;
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim().startsWith('data: ')) {
            const jsonStr = line.trim().slice(6);
            let data;
            try {
              data = JSON.parse(jsonStr);
              
              if (data.status === 'thinking') {
                setAgentStatus('thinking', `Step ${data.loop}...`);
                logReasoningStep(data);
                // Keep thought panel collapsed — no step rows cluttering the UI
              } else if (data.status === 'tool_start') {
                setAgentStatus('thinking', data.tool);
                logReasoningStep(data);
                const statusLine = assistantBubble.querySelector('.status-line');
                if (statusLine) statusLine.textContent = data.message || `Running ${data.tool}...`;
              } else if (data.status === 'tool_end') {
                logReasoningStep(data);
              } else if (data.status === 'answer_start') {
                completeActiveStep();
                streamBuffer = '';
                const thoughtContainer = assistantBubble.querySelector('.thought-container');
                if (thoughtContainer) thoughtContainer.classList.add('hidden-when-answering');
                const statusLine = assistantBubble.querySelector('.status-line');
                if (statusLine) statusLine.remove();
                let targetElement = assistantBubble.querySelector('.assistant-content-text');
                if (!targetElement) {
                  const contentWrap = document.createElement('div');
                  contentWrap.className = 'assistant-content-text streaming-text';
                  assistantBubble.appendChild(contentWrap);
                  targetElement = contentWrap;
                }
                targetElement.textContent = '';
                targetElement.classList.add('streaming-text');
              } else if (data.status === 'token') {
                let targetElement = assistantBubble.querySelector('.assistant-content-text');
                if (!targetElement) {
                  const contentWrap = document.createElement('div');
                  contentWrap.className = 'assistant-content-text streaming-text';
                  assistantBubble.appendChild(contentWrap);
                  targetElement = contentWrap;
                }
                streamBuffer += data.delta;
                targetElement.textContent = maskCitationsForStreaming(streamBuffer);
                chatContainer.scrollTop = chatContainer.scrollHeight;
              } else if (data.status === 'done') {
                completeActiveStep();
                
                // Update reasoning accordion to completed state
                const brainIcon = assistantBubble.querySelector('.thought-brain-icon');
                if (brainIcon) {
                  brainIcon.classList.remove('thinking');
                  brainIcon.setAttribute('data-lucide', 'check-circle');
                }
                const headerText = assistantBubble.querySelector('.thought-header-text');
                if (headerText) {
                  headerText.textContent = 'Thought process completed';
                }
                if (thoughtContainer) {
                  thoughtContainer.classList.add('collapsed');
                }
                lucide.createIcons();

                // Parse full text
                renderAssistantBubble(assistantBubble, data.text);

                // Add to history
                chatHistory.push({ role: 'assistant', content: data.text });
                
                // Save the session
                saveCurrentSession();
                
                setAgentStatus('idle', 'Ready');
                isThinking = false;
                sendBtn.disabled = chatInput.value.trim().length === 0;
              } else if (data.status === 'error') {
                throw new Error(data.message);
              }
            } catch (err) {
              if (data?.status === 'error' || data?.status === 'done') {
                throw err;
              }
              console.error('Failed to process stream chunk:', err, jsonStr);
            }
          }
        }
      }

    } catch (error) {
      console.error('Failed to communicate with agent:', error);
      
      completeActiveStep(true);
      const brainIcon = assistantBubble.querySelector('.thought-brain-icon');
      if (brainIcon) {
        brainIcon.classList.remove('thinking');
        brainIcon.setAttribute('data-lucide', 'alert-circle');
      }
      const headerText = assistantBubble.querySelector('.thought-header-text');
      if (headerText) {
        headerText.textContent = 'Error occurred during reasoning';
      }
      if (thoughtContainer) {
        thoughtContainer.classList.remove('collapsed');
      }
      
      // Render the error message in the content block below thoughts
      const contentTextElement = assistantBubble.querySelector('.assistant-content-text');
      if (contentTextElement) {
        contentTextElement.innerHTML = `<span style="color:#ef4444; font-weight:600;"><i data-lucide="alert-triangle" style="display:inline-block; vertical-align:middle; margin-right:6px;"></i> Error running agent loop:</span><br>${error.message}`;
      } else {
        assistantBubble.innerHTML = `<span style="color:#ef4444; font-weight:600;"><i data-lucide="alert-triangle" style="display:inline-block; vertical-align:middle; margin-right:6px;"></i> Error running agent loop:</span><br>${error.message}`;
      }
      
      setAgentStatus('idle', 'Error occurred');
      isThinking = false;
      sendBtn.disabled = chatInput.value.trim().length === 0;
      lucide.createIcons();
    }
  }

  // Initial Boot Sequence
  async function initializeApp() {
    try {
      const configRes = await fetch('/api/config');
      if (configRes.ok) {
        serverConfig = await configRes.json();
        authEnabled = Boolean(serverConfig.authEnabled && serverConfig.firebase);
        if (serverConfig.provider === 'openrouter') {
          localStorage.removeItem('ollama_model');
          localStorage.removeItem('ollama_host');
        }
      }
    } catch (err) {
      console.warn('Failed to load server configuration. Using default fallbacks:', err);
    }

    setupAuthListeners();
    initFirebaseAuth();
    await refreshAuthState();

    renderSessionList();

    // Signed-in: restore last chat from server cache.
    // Guest: restore only if this same browser tab still has temporary sessionStorage history.
    // Opening a new localhost tab always starts with an empty guest chat.
    if (sessions.length > 0) {
      loadSession(sessions[0].id);
    } else {
      startNewChat();
    }
  }

  initializeApp();
});
