(() => {
  'use strict';

  const SRC_LANG = 'en';
  const DST_LANG = 'ru';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    tabUrl: $('#tab-url'),
    tabText: $('#tab-text'),
    tabFile: $('#tab-file'),
    urlForm: $('#url-form'),
    urlInput: $('#url-input'),
    textForm: $('#text-form'),
    textInput: $('#text-input'),
    fileForm: $('#file-form'),
    fileInput: $('#file-input'),
    drop: $('#drop'),
    status: $('#status'),
    docs: $('#docs'),
    docsCount: $('#docs-count'),
    docsList: $('#docs-list'),
    docsClear: $('#docs-clear'),
    empty: $('#empty'),
    article: $('#article'),
    title: $('#article-title'),
    meta: $('#article-meta'),
    body: $('#article-body'),
    popup: $('#popup'),
  };

  /* ------------------------------------------------------------------ */
  /* Утилиты                                                             */
  /* ------------------------------------------------------------------ */

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function sanitize(html, { images = true } = {}) {
    const forbid = ['style', 'form', 'input', 'button', 'iframe'];
    if (!images) forbid.push('img', 'picture', 'source', 'svg');
    return DOMPurify.sanitize(html, { FORBID_TAGS: forbid, FORBID_ATTR: ['style'] });
  }

  // Текст без разметки; DOMParser не запускает загрузку картинок, в отличие от innerHTML
  function plainText(html) {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
  }

  // Абзацы разделены пустой строкой; если пустых строк нет совсем, каждая строка считается абзацем
  function textToHtml(text) {
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    const chunks = /\n\s*\n/.test(normalized) ? normalized.split(/\n\s*\n/) : normalized.split('\n');
    return chunks
      .map((chunk) => chunk.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .map((chunk) => '<p>' + esc(chunk) + '</p>')
      .join('');
  }

  function setAddress(sourceUrl) {
    try {
      history.replaceState(null, '', sourceUrl ? '?url=' + encodeURIComponent(sourceUrl) : location.pathname);
    } catch { /* например, при открытии с file:// */ }
  }

  function setStatus(message, kind) {
    if (!message) {
      els.status.hidden = true;
      els.status.textContent = '';
      els.status.className = '';
      return;
    }
    els.status.hidden = false;
    els.status.textContent = message;
    els.status.className = kind || '';
  }

  const storage = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); return true; } catch { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* нечего удалять */ }
    },
  };

  /* ------------------------------------------------------------------ */
  /* Загрузка статьи по ссылке                                           */
  /* ------------------------------------------------------------------ */

  // Браузер не может напрямую скачать чужую страницу (CORS), поэтому идём
  // через публичные прокси. Если один не отвечает, пробуем следующий.
  const PROXIES = [
    (u) => ({ url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) }),
    (u) => ({ url: 'https://corsproxy.io/?url=' + encodeURIComponent(u) }),
    (u) => ({ url: 'https://r.jina.ai/' + u, headers: { 'X-Return-Format': 'html' } }),
  ];

  async function fetchTimeout(url, ms, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHtml(target) {
    let lastErr;
    for (const make of PROXIES) {
      const { url, headers } = make(target);
      try {
        const res = await fetchTimeout(url, 20000, headers ? { headers } : {});
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (text.length < 500) throw new Error('empty response');
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('fetch failed');
  }

  function extractArticle(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // База нужна, чтобы Readability превратил относительные ссылки и картинки в абсолютные.
    const base = doc.createElement('base');
    base.href = pageUrl;
    doc.head.prepend(base);

    const parsed = new Readability(doc).parse();
    if (!parsed || !parsed.content || (parsed.textContent || '').trim().length < 200) {
      throw new Error('no article');
    }
    return parsed;
  }

  /* ------------------------------------------------------------------ */
  /* Разбивка текста на слова                                            */
  /* ------------------------------------------------------------------ */

  // Латинские слова, включая don't, well-known и т. п.
  const WORD_RE = /\p{Script=Latin}+(?:['’\-]\p{Script=Latin}+)*/gu;

  function wrapWords(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style, noscript, textarea')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(WORD_RE)) {
        if (m.index > last) frag.append(text.slice(last, m.index));
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = m[0];
        frag.append(span);
        last = m.index + m[0].length;
      }
      if (last === 0) continue; // слов в узле нет
      if (last < text.length) frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  /* ------------------------------------------------------------------ */
  /* История: недавние статьи и тексты                                   */
  /* ------------------------------------------------------------------ */

  // Индекс лежит под одним ключом, содержимое каждой статьи под своим. Так список
  // читается быстро, а при нехватке места можно выбросить самые старые статьи.
  const DOCS_KEY = 'reader-docs-v1';
  const DOC_PREFIX = 'reader-doc-v1:';
  const DOCS_MAX = 20;
  const DOC_MAX_CHARS = 1200000; // больше в localStorage (около 5 МБ) уже не поместится

  const dateFmt = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  const isDocEntry = (d) =>
    d && typeof d.id === 'string' && typeof d.title === 'string' &&
    typeof d.label === 'string' && typeof d.ts === 'number';

  let docs = [];
  try {
    const stored = JSON.parse(storage.get(DOCS_KEY) || '[]');
    if (Array.isArray(stored)) docs = stored.filter(isDocEntry).slice(0, DOCS_MAX);
  } catch { /* история необязательна */ }

  const saveIndex = () => storage.set(DOCS_KEY, JSON.stringify(docs));

  function renderDocs() {
    els.docsList.textContent = '';
    for (const d of docs) {
      const li = document.createElement('li');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'doc-open';
      open.dataset.id = d.id;
      const title = document.createElement('span');
      title.className = 'doc-title';
      title.textContent = d.kind === 'text' ? d.snippet || d.title : d.title;
      const meta = document.createElement('span');
      meta.className = 'doc-meta';
      meta.textContent = [d.label, d.site, dateFmt.format(new Date(d.ts))].filter(Boolean).join(' · ');
      open.append(title, meta);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'doc-del';
      del.dataset.id = d.id;
      del.setAttribute('aria-label', 'Удалить из истории');
      del.textContent = '×';

      li.append(open, del);
      els.docsList.append(li);
    }
    els.docsCount.textContent = docs.length ? '(' + docs.length + ')' : '';
    els.docs.hidden = docs.length === 0;
  }

  // Возвращает false, если сохранить не удалось (слишком большой документ или нет места)
  function saveDoc(entry, html) {
    if (html.length > DOC_MAX_CHARS) return false;

    const list = [entry, ...docs.filter((d) => d.id !== entry.id)];
    for (const evicted of list.splice(DOCS_MAX)) storage.remove(DOC_PREFIX + evicted.id);

    // Не хватает места: выбрасываем самые старые статьи, пока новая не поместится
    while (!storage.set(DOC_PREFIX + entry.id, html)) {
      if (list.length <= 1) {
        docs = [];
        saveIndex();
        renderDocs();
        return false;
      }
      storage.remove(DOC_PREFIX + list.pop().id);
    }

    docs = list;
    saveIndex();
    renderDocs();
    return true;
  }

  function removeDoc(id) {
    storage.remove(DOC_PREFIX + id);
    docs = docs.filter((d) => d.id !== id);
    saveIndex();
    renderDocs();
  }

  function clearDocs() {
    for (const d of docs) storage.remove(DOC_PREFIX + d.id);
    docs = [];
    saveIndex();
    renderDocs();
  }

  function touchDoc(id) {
    const entry = docs.find((d) => d.id === id);
    if (!entry) return;
    entry.ts = Date.now();
    docs = [entry, ...docs.filter((d) => d.id !== id)];
    saveIndex();
    renderDocs();
  }

  function openSaved(id) {
    const entry = docs.find((d) => d.id === id);
    if (!entry) return;

    const stored = storage.get(DOC_PREFIX + id);
    if (stored === null) {
      removeDoc(id);
      setStatus('Сохранённая копия недоступна, её убрали из списка.', 'error');
      return;
    }

    els.body.innerHTML = sanitize(stored);
    showArticle({ title: entry.title, metaParts: entry.metaParts, sourceUrl: entry.sourceUrl });
    setAddress(entry.sourceUrl);
    setStatus('');
    touchDoc(id);
  }

  /* ------------------------------------------------------------------ */
  /* Показ статьи                                                        */
  /* ------------------------------------------------------------------ */

  function showArticle({ title, metaParts, sourceUrl }) {
    closePopup();
    els.docs.open = false;
    els.title.textContent = title;

    els.meta.textContent = '';
    const parts = (metaParts || []).filter(Boolean);
    els.meta.append(parts.join(' · '));
    if (sourceUrl) {
      if (parts.length) els.meta.append(' · ');
      const a = document.createElement('a');
      a.href = sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'оригинал';
      els.meta.append(a);
    }

    for (const a of els.body.querySelectorAll('a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }

    wrapWords(els.body);

    document.title = title + ' — Читалка';
    els.empty.hidden = true;
    els.article.hidden = false;
    window.scrollTo({ top: 0 });
  }

  // html здесь уже очищен; он же сохраняется в историю (без обёртки слов в span)
  function presentDocument({ id, kind, label, title, snippet, metaParts, sourceUrl, site, html }) {
    els.body.innerHTML = html;
    showArticle({ title, metaParts, sourceUrl });
    setAddress(sourceUrl);

    const saved = saveDoc(
      {
        id, kind, label, title,
        snippet: snippet || '',
        metaParts: (metaParts || []).filter(Boolean),
        sourceUrl: sourceUrl || '',
        site: site || '',
        ts: Date.now(),
      },
      html
    );
    setStatus(
      saved ? '' : 'Открыто, но не сохранено в историю: документ слишком большой или в браузере нет места.'
    );
  }

  async function loadUrl(raw) {
    let url;
    try {
      url = new URL(raw.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    } catch {
      setStatus('Это не похоже на ссылку. Она должна начинаться с http:// или https://', 'error');
      return;
    }

    const btn = els.urlForm.querySelector('button');
    btn.disabled = true;
    setStatus('Загружаю статью…');

    try {
      const html = await fetchHtml(url.href);
      const article = extractArticle(html, url.href);

      presentDocument({
        id: 'u' + hash(url.href),
        kind: 'url',
        label: 'Ссылка',
        title: article.title || url.hostname,
        metaParts: [article.byline, article.siteName || url.hostname],
        sourceUrl: url.href,
        site: url.hostname,
        html: sanitize(article.content),
      });
    } catch (err) {
      const noArticle = err && err.message === 'no article';
      setStatus(
        noArticle
          ? 'Не удалось выделить текст статьи на этой странице. Попробуй вставить текст вручную во вкладке «Свой текст».'
          : 'Не удалось загрузить страницу. Сайт может блокировать загрузку: вставь текст вручную во вкладке «Свой текст».',
        'error'
      );
    } finally {
      btn.disabled = false;
    }
  }

  function snippetOf(text) {
    const line = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
    return line.length > 70 ? line.slice(0, 70).trimEnd() + '…' : line;
  }

  function loadText(raw) {
    const html = textToHtml(raw);
    if (!html) {
      setStatus('Вставь текст, который хочешь прочитать.', 'error');
      return;
    }

    presentDocument({
      id: 't' + hash(html) + html.length.toString(36),
      kind: 'text',
      label: 'Текст',
      title: 'Вставленный текст',
      snippet: snippetOf(raw),
      metaParts: [],
      html: sanitize(html),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Файлы: PDF, DOCX, TXT, MD                                           */
  /* ------------------------------------------------------------------ */

  const TEXT_EXTS = ['txt', 'md', 'markdown', 'text'];

  const failure = (code) => Object.assign(new Error(code), { code });

  function readFile(file, as) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      if (as === 'text') reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('cannot load ' + src));
      document.head.append(script);
    });
  }

  // Тяжёлые библиотеки подгружаются только когда нужны
  let pdfjsPromise = null;
  function loadPdfjs() {
    // window.readerPdfjs позволяет подставить уже загруженный pdf.js (так сайт проверяют в тестах)
    if (window.readerPdfjs) return Promise.resolve(window.readerPdfjs);
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdf.min.js')
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', document.baseURI).href;
          return lib;
        })
        .catch((err) => {
          pdfjsPromise = null;
          throw err;
        });
    }
    return pdfjsPromise;
  }

  let mammothPromise = null;
  function loadMammoth() {
    if (!mammothPromise) {
      mammothPromise = loadScript('vendor/mammoth.browser.min.js')
        .then(() => window.mammoth)
        .catch((err) => {
          mammothPromise = null;
          throw err;
        });
    }
    return mammothPromise;
  }

  async function openPdf(file, base) {
    const [pdfjs, buffer] = await Promise.all([loadPdfjs(), readFile(file, 'buffer')]);
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    try {
      const pdf = await task.promise;
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        setStatus('Читаю PDF: страница ' + n + ' из ' + pdf.numPages + '…');
        const page = await pdf.getPage(n);
        pages.push((await page.getTextContent()).items);
        page.cleanup();
      }

      const blocks = PdfText.itemsToBlocks(pages);
      if (!blocks.length) throw failure('no-text');

      const html = blocks
        .map((b) => (b.type === 'h' ? '<h2>' + esc(b.text) + '</h2>' : '<p>' + esc(b.text) + '</p>'))
        .join('');

      presentDocument({
        id: 'f' + hash(html) + html.length.toString(36),
        kind: 'file',
        label: 'PDF',
        title: base,
        metaParts: ['PDF', pdf.numPages + ' стр.'],
        html: sanitize(html),
      });
    } finally {
      // освобождаем память и воркер; ошибка здесь не должна скрыть результат
      try {
        Promise.resolve(task.destroy()).catch(() => {});
      } catch { /* уже уничтожено */ }
    }
  }

  async function openDocx(file, base) {
    const [mammoth, buffer] = await Promise.all([loadMammoth(), readFile(file, 'buffer')]);
    // Картинки не нужны для чтения и сильно раздувают размер, поэтому выбрасываем их
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) }
    );

    const html = sanitize(result.value, { images: false });
    if (!plainText(html)) throw failure('no-text');

    presentDocument({
      id: 'f' + hash(html) + html.length.toString(36),
      kind: 'file',
      label: 'DOCX',
      title: base,
      metaParts: ['DOCX'],
      html,
    });
  }

  async function openPlain(file, base, ext) {
    const html = textToHtml(await readFile(file, 'text'));
    if (!html) throw failure('no-text');

    const label = ext === 'md' || ext === 'markdown' ? 'MD' : 'TXT';
    presentDocument({
      id: 'f' + hash(html) + html.length.toString(36),
      kind: 'file',
      label,
      title: base,
      metaParts: [label],
      html: sanitize(html),
    });
  }

  function fileErrorMessage(err) {
    if (err && err.code === 'no-text') {
      return 'В файле не нашлось текста. Если это скан PDF, он состоит из картинок, и прочитать его не получится.';
    }
    if (err && err.name === 'PasswordException') {
      return 'Файл защищён паролем. Сними защиту и открой его снова.';
    }
    return 'Не удалось прочитать файл. Возможно, он повреждён.';
  }

  async function loadFile(file) {
    if (!file) return;

    const name = file.name || 'document';
    const ext = ((name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
    const base = name.replace(/\.[^.]+$/, '') || name;

    setStatus('Читаю файл…');
    try {
      if (ext === 'pdf' || file.type === 'application/pdf') {
        await openPdf(file, base);
      } else if (ext === 'docx') {
        await openDocx(file, base);
      } else if (TEXT_EXTS.includes(ext) || file.type === 'text/plain') {
        await openPlain(file, base, ext);
      } else if (ext === 'doc') {
        setStatus('Старый формат .doc не поддерживается. Сохрани файл как .docx или PDF и открой его снова.', 'error');
      } else {
        setStatus('Этот формат не поддерживается. Подойдут PDF, DOCX, TXT и MD.', 'error');
      }
    } catch (err) {
      console.error(err);
      setStatus(fileErrorMessage(err), 'error');
    } finally {
      els.fileInput.value = ''; // чтобы тот же файл можно было выбрать ещё раз
    }
  }

  /* ------------------------------------------------------------------ */
  /* Перевод                                                             */
  /* ------------------------------------------------------------------ */

  // Кэш нужен, чтобы повторные слова переводились мгновенно и без сети
  const CACHE_KEY = 'reader-translations-v1';
  const cache = new Map();
  try {
    for (const [k, v] of JSON.parse(storage.get(CACHE_KEY) || '[]')) cache.set(k, v);
  } catch { /* кэш необязателен */ }

  function saveCache() {
    storage.set(CACHE_KEY, JSON.stringify([...cache].slice(-1500)));
  }

  const POS_RU = {
    noun: 'сущ.', verb: 'глаг.', adjective: 'прил.', adverb: 'нареч.',
    preposition: 'предл.', conjunction: 'союз', pronoun: 'мест.',
    interjection: 'межд.', article: 'арт.', determiner: 'опред.',
    particle: 'част.', numeral: 'числ.', abbreviation: 'сокр.', prefix: 'приставка',
  };

  async function translateGoogle(word) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx' +
      `&sl=${SRC_LANG}&tl=${DST_LANG}&dt=t&dt=bd&q=${encodeURIComponent(word)}`;
    const res = await fetchTimeout(url, 8000);
    if (!res.ok) throw new Error('google ' + res.status);
    const data = await res.json();

    const main = (data[0] || []).map((part) => part[0]).join('').trim();
    const alts = (data[1] || [])
      .map((entry) => ({ pos: POS_RU[entry[0]] || entry[0], words: (entry[1] || []).slice(0, 4) }))
      .filter((entry) => entry.words.length);
    if (!main) throw new Error('empty translation');
    return { main, alts };
  }

  async function translateMyMemory(word) {
    const url =
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=${SRC_LANG}|${DST_LANG}`;
    const res = await fetchTimeout(url, 8000);
    if (!res.ok) throw new Error('mymemory ' + res.status);
    const data = await res.json();
    const main = data && data.responseData && data.responseData.translatedText;
    if (!main || /MYMEMORY WARNING/i.test(main)) throw new Error('empty translation');
    return { main: main.trim(), alts: [] };
  }

  async function translate(word) {
    if (cache.has(word)) return cache.get(word);
    let result;
    try {
      result = await translateGoogle(word);
    } catch {
      result = await translateMyMemory(word);
    }
    cache.set(word, result);
    saveCache();
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Всплывающее окно с переводом                                        */
  /* ------------------------------------------------------------------ */

  let current = null; // слово, для которого открыто окно
  let token = 0;      // защита от гонки: показываем только последний запрос

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  function renderPopup(word, state, result) {
    els.popup.textContent = '';

    const head = document.createElement('div');
    head.className = 'p-head';
    const label = document.createElement('span');
    label.textContent = word;
    head.append(label);

    if ('speechSynthesis' in window) {
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      speakBtn.className = 'p-speak';
      speakBtn.setAttribute('aria-label', 'Произнести слово');
      speakBtn.textContent = '🔊';
      speakBtn.addEventListener('click', () => speak(word));
      head.append(speakBtn);
    }

    const main = document.createElement('div');
    main.className = 'p-main';
    els.popup.append(head, main);

    if (state === 'loading') {
      main.classList.add('dim');
      main.textContent = 'Перевожу…';
    } else if (state === 'error') {
      main.classList.add('err');
      main.textContent = 'Не удалось перевести. Проверь соединение и попробуй ещё раз.';
    } else {
      main.textContent = result.main;
      if (result.alts && result.alts.length) {
        const list = document.createElement('div');
        list.className = 'p-alts';
        for (const alt of result.alts) {
          const row = document.createElement('div');
          const pos = document.createElement('b');
          pos.textContent = alt.pos;
          row.append(pos, alt.words.join(', '));
          list.append(row);
        }
        els.popup.append(list);
      }
    }
  }

  function place(span) {
    const popup = els.popup;
    popup.hidden = false;

    const rect = span.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const viewW = document.documentElement.clientWidth;

    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, viewW - pw - 8));

    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight && rect.top - ph - 8 > 0) top = rect.top - ph - 8;

    popup.style.left = left + window.scrollX + 'px';
    popup.style.top = top + window.scrollY + 'px';
  }

  async function openPopup(span) {
    if (current) current.classList.remove('sel');
    current = span;
    span.classList.add('sel');

    const mine = ++token;
    const word = span.textContent;

    renderPopup(word, 'loading');
    place(span);

    try {
      const result = await translate(word);
      if (mine !== token) return;
      renderPopup(word, 'done', result);
    } catch {
      if (mine !== token) return;
      renderPopup(word, 'error');
    }
    place(span);
  }

  function closePopup() {
    token++;
    els.popup.hidden = true;
    if (current) current.classList.remove('sel');
    current = null;
  }

  /* ------------------------------------------------------------------ */
  /* События                                                             */
  /* ------------------------------------------------------------------ */

  els.body.addEventListener('click', (e) => {
    const word = e.target.closest('.w');
    if (!word) return;
    e.preventDefault(); // слово внутри ссылки не должно уводить со страницы
    openPopup(word);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#popup') || e.target.closest('.w')) return;
    closePopup();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopup();
  });

  window.addEventListener('resize', () => {
    if (current && !els.popup.hidden) place(current);
  });

  els.urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loadUrl(els.urlInput.value);
  });

  // Вставил ссылку и сразу открылась статья, без нажатия кнопки.
  els.urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      if (/^https?:\/\/\S+$/i.test(els.urlInput.value.trim())) els.urlForm.requestSubmit();
    }, 0);
  });

  els.textForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loadText(els.textInput.value);
  });

  els.fileInput.addEventListener('change', () => {
    loadFile(els.fileInput.files && els.fileInput.files[0]);
  });

  // Файл можно бросить в любое место страницы
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    els.drop.classList.add('over');
  });

  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) els.drop.classList.remove('over');
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    els.drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) {
      selectTab('file');
      loadFile(file);
    }
  });

  const TABS = {
    url: [els.tabUrl, els.urlForm],
    text: [els.tabText, els.textForm],
    file: [els.tabFile, els.fileForm],
  };

  function selectTab(which) {
    for (const [name, [tab, panel]] of Object.entries(TABS)) {
      tab.setAttribute('aria-selected', String(name === which));
      panel.hidden = name !== which;
    }
    setStatus('');
  }

  for (const name of Object.keys(TABS)) {
    TABS[name][0].addEventListener('click', () => selectTab(name));
  }

  els.docsList.addEventListener('click', (e) => {
    const del = e.target.closest('.doc-del');
    if (del) {
      removeDoc(del.dataset.id);
      return;
    }
    const open = e.target.closest('.doc-open');
    if (open) openSaved(open.dataset.id);
  });

  els.docsClear.addEventListener('click', clearDocs);

  /* ------------------------------------------------------------------ */
  /* Старт                                                               */
  /* ------------------------------------------------------------------ */

  renderDocs();

  // Ссылку на сайт можно отправить другу: ?url=https://…
  const initial = new URLSearchParams(location.search).get('url');
  if (initial) {
    els.urlInput.value = initial;
    loadUrl(initial);
  } else if (docs.length) {
    els.docs.open = true; // на пустой странице сразу показываем историю
  }
})();
