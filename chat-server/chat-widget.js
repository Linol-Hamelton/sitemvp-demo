'use strict';

(function () {
  const configuredBase = typeof window.SITEMVP_CHAT_API === 'string' ? window.SITEMVP_CHAT_API.trim() : '';
  if (!configuredBase) return;

  const root = document.getElementById('sitemvp-chat-widget');
  if (!root) return;

  let apiBase = '';
  try {
    const parsed = new URL(configuredBase, window.location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    apiBase = parsed.href.replace(/\/$/, '');
  } catch (_error) {
    apiBase = '';
  }

  const panel = root.querySelector('.sitemvp-chat-panel');
  const toggle = root.querySelector('.sitemvp-chat-toggle');
  const thread = root.querySelector('.sitemvp-chat-thread');
  const notice = root.querySelector('.sitemvp-chat-notice');
  const chatTitle = root.querySelector('.sitemvp-chat-title');
  const closeButton = root.querySelector('.sitemvp-chat-close');
  const kicker = root.querySelector('.sitemvp-chat-kicker');
  const quick = root.querySelector('.sitemvp-chat-quick');
  const demoForm = root.querySelector('.sitemvp-chat-form');
  const demoCta = root.querySelector('.sitemvp-chat-cta');
  if (!panel || !thread || !notice || !toggle) return;

  const clientIdKey = 'sitemvp_chat_client_id';
  let clientId = '';
  let cursor = 0;
  let isPolling = false;
  let isSending = false;
  let welcomeShown = false;
  let recorder = null;
  let microphoneStream = null;
  let recordingParts = [];
  let discardRecording = false;
  const objectUrls = new Set();

  function makeClientId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') throw new Error('Secure random numbers are unavailable.');
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function setOperatorStatus(online) {
    operatorStatus.textContent = online ? 'Оператор онлайн' : 'Оператор офлайн';
    operatorStatus.dataset.state = online ? 'online' : 'offline';
  }

  function setFeedback(message, isError) {
    feedback.textContent = message;
    feedback.classList.toggle('is-error', Boolean(isError));
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  const composer = makeElement('div', 'sitemvp-chat-real-composer');
  const operatorStatus = makeElement('p', 'sitemvp-chat-real-status', 'Подключаемся…');
  operatorStatus.setAttribute('role', 'status');
  operatorStatus.setAttribute('aria-live', 'polite');
  const feedback = makeElement('p', 'sitemvp-chat-real-feedback', '');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');

  const form = makeElement('form', 'sitemvp-chat-real-form');
  const messageInput = makeElement('textarea');
  messageInput.id = 'sitemvp-chat-real-input';
  messageInput.maxLength = 2000;
  messageInput.rows = 2;
  messageInput.placeholder = 'Напишите сообщение…';
  messageInput.setAttribute('aria-label', 'Ваше сообщение');
  const sendButton = makeElement('button', '', 'Отправить');
  sendButton.type = 'submit';
  sendButton.hidden = true;
  form.append(messageInput, sendButton);

  const tools = makeElement('div', 'sitemvp-chat-real-tools');
  const photoInput = makeElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.setAttribute('aria-label', 'Прикрепить фото');
  const voiceButton = makeElement('button', '', 'Записать голосовое');
  voiceButton.type = 'button';
  voiceButton.setAttribute('aria-pressed', 'false');
  voiceButton.setAttribute('aria-label', 'Записать голосовое сообщение');
  tools.append(photoInput, voiceButton);
  const attachments = makeElement('details', 'sitemvp-chat-attachments');
  const attachmentsSummary = makeElement('summary', '', 'Фото или голос');
  attachments.append(attachmentsSummary, tools);
  composer.append(operatorStatus, form, attachments, feedback);
  const defaultTitle = chatTitle.textContent;
  const defaultNotice = 'Ваши сообщения уходят оператору — ответ придёт в этом чате.';
  notice.textContent = defaultNotice;

  function syncAttachmentView() {
    const selectingAttachment = attachments.open;
    panel.classList.toggle('is-attachment-choice', selectingAttachment);
    chatTitle.textContent = selectingAttachment ? 'Добавить вложение' : defaultTitle;
    notice.textContent = selectingAttachment ? 'Выберите фото или запишите голосовое сообщение.' : defaultNotice;
    attachmentsSummary.textContent = selectingAttachment ? 'Назад в чат' : 'Фото или голос';
    closeButton.hidden = selectingAttachment;
    toggle.hidden = !panel.hidden;
  }

  function syncComposerActions() {
    const hasText = Boolean(messageInput.value.trim());
    sendButton.hidden = !hasText;
    if (hasText) attachments.open = false;
  }
  attachments.addEventListener('toggle', syncAttachmentView);
  syncAttachmentView();

  if (kicker) kicker.hidden = true;
  if (quick) quick.hidden = true;
  if (demoForm) demoForm.hidden = true;
  if (demoCta) demoCta.hidden = true;
  while (thread.firstChild) thread.removeChild(thread.firstChild);
  thread.insertAdjacentElement('afterend', composer);

  function getOrCreateClientId() {
    try {
      const saved = localStorage.getItem(clientIdKey);
      if (saved && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved)) return saved;
      const created = makeClientId();
      localStorage.setItem(clientIdKey, created);
      return created;
    } catch (_error) {
      setFeedback('Браузер не может сохранить этот чат. Разрешите локальное хранилище и обновите страницу.', true);
      messageInput.disabled = true;
      sendButton.disabled = true;
      photoInput.disabled = true;
      voiceButton.disabled = true;
      return '';
    }
  }

  function makeFileUrl(fileUrl) {
    if (typeof fileUrl !== 'string') return '';
    if (fileUrl.startsWith('blob:')) return fileUrl;
    if (!fileUrl.startsWith('/file/')) return '';
    try { return new URL(fileUrl, apiBase).href; } catch (_error) { return ''; }
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function appendMessage(message) {
    const bubble = makeElement('div', 'sitemvp-chat-message ' + (message.from === 'client' ? 'is-user' : 'is-assistant'));
    const speaker = makeElement('span', 'sitemvp-chat-message-label', message.from === 'client' ? 'Вы' : 'Оператор');
    bubble.appendChild(speaker);
    const fileUrl = makeFileUrl(message.fileUrl);
    if (message.kind === 'photo' && fileUrl) {
      bubble.classList.add('has-media');
      const image = makeElement('img');
      image.src = fileUrl;
      image.alt = 'Фото из сообщения';
      bubble.appendChild(image);
    } else if (message.kind === 'voice' && fileUrl) {
      bubble.classList.add('has-media');
      const audio = makeElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = fileUrl;
      bubble.appendChild(audio);
    }
    if (message.text) bubble.appendChild(makeElement('p', '', message.text));
    const time = makeElement('time', '', formatTime(message.createdAt));
    if (message.createdAt) time.dateTime = message.createdAt;
    bubble.appendChild(time);
    thread.appendChild(bubble);
    thread.scrollTop = thread.scrollHeight;
  }

  function addWelcome() {
    if (welcomeShown) return;
    welcomeShown = true;
    appendMessage({
      from: 'operator',
      kind: 'text',
      text: 'Здравствуйте! Напишите, какой сайт вам нужен.'
    });
  }

  async function requestJson(path, options = {}) {
    if (!apiBase) throw new Error('Адрес сервера чата задан неверно.');
    const response = await fetch(apiBase + path, Object.assign({
      cache: 'no-store',
      credentials: 'omit'
    }, options));
    let data;
    try { data = await response.json(); } catch (_error) { data = null; }
    if (!response.ok || !data || data.ok !== true) {
      throw new Error(data && data.error ? data.error : 'Сервер чата временно недоступен.');
    }
    return data;
  }

  async function poll() {
    if (!clientId || isPolling || isSending) return;
    isPolling = true;
    try {
      const data = await requestJson('/api/poll?clientId=' + encodeURIComponent(clientId) + '&cursor=' + cursor);
      const messages = Array.isArray(data.messages) ? data.messages : [];
      setOperatorStatus(true);
      if (messages.length) {
        welcomeShown = true;
        for (const message of messages) {
          if (!Number.isSafeInteger(Number(message.cursor)) || Number(message.cursor) > cursor) appendMessage(message);
        }
      } else if (cursor === 0) {
        addWelcome();
      }
      const nextCursor = Number(data.cursor);
      if (Number.isSafeInteger(nextCursor) && nextCursor >= cursor) cursor = nextCursor;
      if (feedback.textContent === 'Подключаемся…' || feedback.classList.contains('is-error')) setFeedback('', false);
    } catch (_error) {
      setOperatorStatus(false);
    } finally {
      isPolling = false;
    }
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = typeof reader.result === 'string' ? reader.result : '';
        const comma = value.indexOf(',');
        if (comma < 0) reject(new Error('Не удалось прочитать файл.'));
        else resolve(value.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
      reader.readAsDataURL(file);
    });
  }

  async function sendMessage(kind, file) {
    if (!clientId || isSending) return;
    const text = messageInput.value.trim();
    if (kind === 'text' && !text) return;
    if (file && file.size > 10 * 1024 * 1024) {
      setFeedback('Файл должен быть не больше 10 МБ.', true);
      return;
    }

    isSending = true;
    sendButton.disabled = true;
    photoInput.disabled = true;
    voiceButton.disabled = true;
    setFeedback('Отправляем…', false);
    try {
      const body = { clientId, kind, text };
      if (file) {
        body.fileBase64 = await readAsBase64(file);
        const extension = String(file.name || '').split('.').pop().toLowerCase();
        const fallbackTypes = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
          webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav'
        };
        body.mime = file.type || fallbackTypes[extension] || (kind === 'voice' ? 'audio/webm' : 'image/jpeg');
        body.filename = file.name || (kind === 'voice' ? 'voice.webm' : 'photo');
      }
      const data = await requestJson('/api/msg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      appendMessage({
        from: 'client',
        kind,
        text,
        fileUrl: file ? URL.createObjectURL(file) : '',
        createdAt: new Date().toISOString()
      });
      if (file) objectUrls.add(thread.lastElementChild.querySelector('img, audio')?.src || '');
      const nextCursor = Number(data.cursor);
      if (Number.isSafeInteger(nextCursor) && nextCursor >= cursor) cursor = nextCursor;
      messageInput.value = '';
      syncComposerActions();
      setFeedback('', false);
      setOperatorStatus(true);
    } catch (error) {
      setOperatorStatus(false);
      setFeedback(error.message || 'Не удалось отправить сообщение. Попробуйте снова.', true);
    } finally {
      isSending = false;
      sendButton.disabled = false;
      photoInput.disabled = false;
      voiceButton.disabled = false;
      poll();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage('text', null);
  });

  messageInput.addEventListener('input', syncComposerActions);

  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  photoInput.addEventListener('change', () => {
    const file = photoInput.files && photoInput.files[0];
    photoInput.value = '';
    if (file) {
      attachments.open = false;
      sendMessage('photo', file);
    }
  });

  function stopRecording(discard) {
    discardRecording = Boolean(discard);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function startRecording() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof window.MediaRecorder !== 'function') {
      setFeedback('Запись голоса недоступна в этом браузере. Можно написать или прикрепить фото.', true);
      return;
    }
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
        : '';
      recorder = mimeType ? new MediaRecorder(microphoneStream, { mimeType }) : new MediaRecorder(microphoneStream);
      recordingParts = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) recordingParts.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        const type = recorder && recorder.mimeType ? recorder.mimeType.split(';', 1)[0] : 'audio/webm';
        const blob = new Blob(recordingParts, { type });
        recordingParts = [];
        if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
        microphoneStream = null;
        recorder = null;
        voiceButton.textContent = 'Записать голосовое';
        voiceButton.setAttribute('aria-label', 'Записать голосовое сообщение');
        voiceButton.setAttribute('aria-pressed', 'false');
        if (blob.size && !discardRecording) {
          attachments.open = false;
          sendMessage('voice', blob);
        }
        discardRecording = false;
      }, { once: true });
      recorder.start();
      voiceButton.textContent = 'Остановить запись';
      voiceButton.setAttribute('aria-label', 'Остановить запись голоса');
      voiceButton.setAttribute('aria-pressed', 'true');
      setFeedback('Идёт запись. Нажмите «Остановить запись», когда закончите.', false);
    } catch (_error) {
      if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
      microphoneStream = null;
      recorder = null;
      voiceButton.textContent = 'Записать голосовое';
      voiceButton.setAttribute('aria-pressed', 'false');
      setFeedback('Нет доступа к микрофону. Разрешите запись или отправьте текст.', true);
    }
  }

  voiceButton.addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stopRecording();
    else startRecording();
  });

  toggle.addEventListener('click', () => {
    if (!panel.hidden) window.setTimeout(() => messageInput.focus(), 0);
  });
  const panelObserver = new MutationObserver(() => {
    if (panel.hidden) attachments.open = false;
    syncAttachmentView();
  });
  panelObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });

  clientId = getOrCreateClientId();
  if (clientId) {
    poll();
    const pollTimer = window.setInterval(poll, 5000);
    window.addEventListener('pagehide', () => {
      window.clearInterval(pollTimer);
      panelObserver.disconnect();
      stopRecording(true);
      if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
      objectUrls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
    }, { once: true });
  } else {
    setOperatorStatus(false);
  }
}());
