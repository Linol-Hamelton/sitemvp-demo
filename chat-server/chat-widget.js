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
  let isStartingRecording = false;
  let welcomeShown = false;
  let recorder = null;
  let microphoneStream = null;
  let recordingParts = [];
  let discardRecording = false;
  let recordingStartedAt = 0;
  let recordingTimer = 0;
  let feedbackTimer = 0;
  const objectUrls = new Set();
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const MAX_COMPRESSED_PHOTO_BYTES = 1024 * 1024;
  const MAX_PHOTO_EDGE = 1920;
  const MEDIA_TIMEOUT_MS = 30 * 1000;

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
    if (feedbackTimer) {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = 0;
    }
    feedback.textContent = message;
    feedback.classList.toggle('is-error', Boolean(isError));
  }

  function setSuccessFeedback(message) {
    setFeedback(message, false);
    feedbackTimer = window.setTimeout(() => setFeedback('', false), 2500);
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
  const recordingStatus = makeElement('p', 'sitemvp-chat-recording-status');
  recordingStatus.setAttribute('role', 'status');
  recordingStatus.setAttribute('aria-live', 'off');
  const recordingDot = makeElement('span', 'sitemvp-chat-recording-dot');
  recordingDot.setAttribute('aria-hidden', 'true');
  const recordingLabel = makeElement('span', '', 'Идёт запись');
  const recordingClock = makeElement('time', '', '00:00');
  recordingClock.setAttribute('aria-label', 'Время записи');
  recordingStatus.append(recordingDot, recordingLabel, recordingClock);
  recordingStatus.hidden = true;
  const cancelVoiceButton = makeElement('button', 'sitemvp-chat-recording-cancel', '×');
  cancelVoiceButton.type = 'button';
  cancelVoiceButton.setAttribute('aria-label', 'Отменить запись');
  cancelVoiceButton.hidden = true;
  tools.append(photoInput, voiceButton, recordingStatus, cancelVoiceButton);
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

  function setMediaBusy(busy, allowVoice = false) {
    tools.classList.toggle('is-busy', busy);
    tools.setAttribute('aria-busy', String(busy));
    photoInput.disabled = busy;
    voiceButton.disabled = busy && !allowVoice;
    photoInput.setAttribute('aria-disabled', String(busy));
    voiceButton.setAttribute('aria-disabled', String(busy && !allowVoice));
    attachmentsSummary.setAttribute('aria-disabled', String(busy));
    if (busy && !allowVoice) attachments.open = false;
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
      if (feedback.textContent === 'Подключаемся…') setFeedback('', false);
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

  function photoFormatError() {
    return new Error('Этот формат фото не поддерживается этим браузером. Выберите другое фото (JPEG/PNG).');
  }

  async function decodeImage(file) {
    if (typeof window.createImageBitmap === 'function') {
      try {
        const bitmap = await window.createImageBitmap(file);
        if (bitmap.width > 0 && bitmap.height > 0) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            dispose: () => bitmap.close()
          };
        }
        bitmap.close();
      } catch (_error) {
        // The Image fallback handles browsers that can display formats createImageBitmap cannot decode.
      }
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = () => reject(photoFormatError());
        candidate.src = objectUrl;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw photoFormatError();
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(objectUrl)
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error && error.message ? error : photoFormatError();
    }
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Не получилось обработать фото. Выберите другое фото и попробуйте снова.'));
      }, 'image/jpeg', quality);
    });
  }

  async function normalizePhoto(file) {
    if (!file || (file.type && !/^image\//i.test(file.type))) {
      throw new Error('Выберите файл изображения (JPEG или PNG).');
    }
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('Фото должно быть не больше 10 МБ.');

    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch (_error) {
      throw photoFormatError();
    }

    try {
      const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(decoded.width, decoded.height));
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Не получилось обработать фото. Выберите другое фото и попробуйте снова.');
      context.drawImage(decoded.source, 0, 0, width, height);

      for (const quality of [0.8, 0.75, 0.7, 0.65, 0.6]) {
        const jpeg = await canvasToJpeg(canvas, quality);
        if (jpeg.size <= MAX_COMPRESSED_PHOTO_BYTES) {
          return new File([jpeg], 'photo.jpg', { type: 'image/jpeg', lastModified: Date.now() });
        }
      }
      throw new Error('Фото не удалось сжать до 1 МБ. Выберите фото поменьше.');
    } finally {
      decoded.dispose();
    }
  }

  function voiceExtension(mime) {
    const type = String(mime || '').toLowerCase().split(';', 1)[0];
    if (type === 'audio/ogg') return 'ogg';
    if (type === 'audio/mp4') return 'm4a';
    if (type === 'audio/mpeg') return 'mp3';
    if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav';
    return 'webm';
  }

  async function sendMessage(kind, file) {
    if (!clientId || isSending) return;
    const text = messageInput.value.trim();
    if (kind === 'text' && !text) return;
    if (file && file.size > MAX_UPLOAD_BYTES) {
      setFeedback(kind === 'photo' ? 'Фото должно быть не больше 10 МБ.' : 'Голосовое сообщение должно быть не больше 10 МБ.', true);
      return;
    }
    if (kind === 'photo' && file && file.type && !/^image\//i.test(file.type)) {
      setFeedback('Выберите файл изображения (JPEG или PNG).', true);
      return;
    }

    isSending = true;
    sendButton.disabled = true;
    setMediaBusy(true);
    try {
      const body = { clientId, kind, text };
      let uploadFile = file;
      if (file) {
        if (kind === 'photo') {
          setFeedback('Обрабатываем фото…', false);
          uploadFile = await normalizePhoto(file);
          body.mime = 'image/jpeg';
          body.filename = 'photo.jpg';
        } else {
          setFeedback('Готовим голосовое…', false);
          body.mime = file.type || 'audio/webm';
          body.filename = 'voice.' + voiceExtension(body.mime);
        }
        body.fileBase64 = await readAsBase64(uploadFile);
      }
      setFeedback(file ? 'Отправляем…' : '', false);
      let data;
      let timeoutId = 0;
      const controller = file ? new AbortController() : null;
      if (controller) timeoutId = window.setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
      try {
        data = await requestJson('/api/msg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        if (controller && controller.signal.aborted) {
          throw new Error('Отправка заняла больше 30 секунд. Проверьте соединение и попробуйте ещё раз.');
        }
        if (file && error && (error.name === 'TypeError' || error.name === 'NetworkError')) {
          throw new Error('Не удалось подключиться к чату. Проверьте интернет и попробуйте ещё раз.');
        }
        throw error;
      } finally {
        if (timeoutId) window.clearTimeout(timeoutId);
      }
      appendMessage({
        from: 'client',
        kind,
        text,
        fileUrl: uploadFile ? URL.createObjectURL(uploadFile) : '',
        createdAt: new Date().toISOString()
      });
      if (uploadFile) objectUrls.add(thread.lastElementChild.querySelector('img, audio')?.src || '');
      const nextCursor = Number(data.cursor);
      if (Number.isSafeInteger(nextCursor) && nextCursor >= cursor) cursor = nextCursor;
      messageInput.value = '';
      syncComposerActions();
      if (file) setSuccessFeedback(kind === 'photo' ? 'Фото отправлено.' : 'Голосовое отправлено.');
      else setFeedback('', false);
      setOperatorStatus(true);
    } catch (error) {
      setOperatorStatus(false);
      setFeedback(error.message || 'Не удалось отправить сообщение. Попробуйте снова.', true);
    } finally {
      isSending = false;
      sendButton.disabled = false;
      setMediaBusy(false);
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

  function updateRecordingClock() {
    const seconds = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    const remainder = String(seconds % 60).padStart(2, '0');
    recordingClock.textContent = minutes + ':' + remainder;
  }

  function resetRecordingUi() {
    if (recordingTimer) {
      window.clearInterval(recordingTimer);
      recordingTimer = 0;
    }
    recordingStatus.hidden = true;
    cancelVoiceButton.hidden = true;
    voiceButton.textContent = 'Записать голосовое';
    voiceButton.setAttribute('aria-label', 'Записать голосовое сообщение');
    voiceButton.setAttribute('aria-pressed', 'false');
    recordingClock.textContent = '00:00';
    attachments.open = false;
    setMediaBusy(false);
  }

  function stopRecording(discard) {
    discardRecording = Boolean(discard);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function startRecording() {
    if (isSending || isStartingRecording || (recorder && recorder.state !== 'inactive')) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof window.MediaRecorder !== 'function') {
      setFeedback('Запись голоса недоступна в этом браузере. Можно написать или прикрепить фото.', true);
      return;
    }
    isStartingRecording = true;
    setMediaBusy(true, true);
    voiceButton.disabled = true;
    setFeedback('Подключаем микрофон…', false);
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
        : '';
      recorder = mimeType ? new MediaRecorder(microphoneStream, { mimeType }) : new MediaRecorder(microphoneStream);
      recordingParts = [];
      discardRecording = false;
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
        const wasDiscarded = discardRecording;
        discardRecording = false;
        resetRecordingUi();
        if (blob.size && !wasDiscarded) {
          attachments.open = false;
          sendMessage('voice', blob);
        } else if (!wasDiscarded) {
          setFeedback('Не удалось записать голосовое. Попробуйте ещё раз или напишите сообщение.', true);
        } else {
          setFeedback('Запись отменена.', false);
        }
      }, { once: true });
      recorder.start();
      isStartingRecording = false;
      recordingStartedAt = Date.now();
      updateRecordingClock();
      recordingStatus.hidden = false;
      cancelVoiceButton.hidden = false;
      recordingTimer = window.setInterval(updateRecordingClock, 1000);
      voiceButton.disabled = false;
      voiceButton.textContent = 'Отправить голосовое';
      voiceButton.setAttribute('aria-label', 'Отправить голосовое сообщение');
      voiceButton.setAttribute('aria-pressed', 'true');
      setMediaBusy(true, true);
      setFeedback('Идёт запись. Нажмите «Отправить голосовое», чтобы отправить, или отмените запись.', false);
    } catch (_error) {
      if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
      microphoneStream = null;
      recorder = null;
      isStartingRecording = false;
      resetRecordingUi();
      setFeedback('Нет доступа к микрофону. Разрешите запись или отправьте текст.', true);
    }
  }

  voiceButton.addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stopRecording();
    else startRecording();
  });
  cancelVoiceButton.addEventListener('click', () => stopRecording(true));
  attachmentsSummary.addEventListener('click', (event) => {
    if (isSending || isStartingRecording || (recorder && recorder.state !== 'inactive')) event.preventDefault();
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
      if (recordingTimer) window.clearInterval(recordingTimer);
      if (feedbackTimer) window.clearTimeout(feedbackTimer);
      objectUrls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
    }, { once: true });
  } else {
    setOperatorStatus(false);
  }
}());
