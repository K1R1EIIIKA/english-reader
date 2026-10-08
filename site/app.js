(() => {
  'use strict';

  const SRC_LANG = 'en';
  const DST_LANG = 'ru';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    tabUrl: $('#tab-url'),
    tabText: $('#tab-text'),
    urlForm: $('#url-form'),
    urlInput: $('#url-input'),
    textForm: $('#text-form'),
    textInput: $('#text-input'),
    status: $('#status'),
    empty: $('#empty'),
    article: $('#article'),
    title: $('#article-title'),
    meta: $('#article-meta'),
    body: $('#article-body'),
    popup: $('#popup'),
    recent: $('#history'),
    recentCount: $('#history-count'),
    recentList: $('#history-list'),
    recentClear: $('#history-clear'),
  };

  /* ------------------------------------------------------------------ */
  /* Загрузка статьи                                                     */
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
  /* Показ статьи                                                        */
  /* ------------------------------------------------------------------ */

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

  function showArticle({ title, metaParts, sourceUrl }) {
    closePopup();
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

      els.body.innerHTML = DOMPurify.sanitize(article.content, {
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
        FORBID_ATTR: ['style'],
      });

      showArticle({
        title: article.title || url.hostname,
        metaParts: [article.byline, article.siteName || url.hostname],
        sourceUrl: url.href,
      });
      setStatus('');

      try {
        history.replaceState(null, '', '?url=' + encodeURIComponent(url.href));
      } catch { /* например, при открытии с file:// */ }
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

  function loadText(raw) {
    const text = raw.trim();
    if (!text) {
      setStatus('Вставь текст, который хочешь прочитать.', 'error');
      return;
    }

    els.body.textContent = '';
    for (const chunk of text.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      p.textContent = chunk.replace(/\s*\n\s*/g, ' ').trim();
      if (p.textContent) els.body.append(p);
    }

    showArticle({ title: 'Вставленный текст', metaParts: [] });
    setStatus('');
    try {
      history.replaceState(null, '', location.pathname);
    } catch { /* например, при открытии с file:// */ }
  }

  /* ------------------------------------------------------------------ */
  /* Перевод                                                             */
  /* ------------------------------------------------------------------ */

  const CACHE_KEY = 'reader-translations-v1';
  const cache = new Map();
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')) cache.set(k, v);
  } catch { /* кэш необязателен */ }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify([...cache].slice(-1500)));
    } catch { /* кэш необязателен */ }
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
  /* Недавние переводы                                                   */
  /* ------------------------------------------------------------------ */

  const RECENT_KEY = 'reader-recent-v1';
  const RECENT_MAX = 50;
  let recent = [];

  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (Array.isArray(stored)) {
      recent = stored
        .filter((item) => item && typeof item.word === 'string' && typeof item.main === 'string')
        .slice(0, RECENT_MAX);
    }
  } catch { /* история необязательна */ }

  function renderRecent() {
    els.recentList.textContent = '';
    for (const item of recent) {
      const li = document.createElement('li');
      const word = document.createElement('strong');
      word.textContent = item.word;
      const tr = document.createElement('span');
      tr.textContent = item.main;
      li.append(word, tr);
      els.recentList.append(li);
    }
    els.recentCount.textContent = recent.length ? '(' + recent.length + ')' : '';
    els.recent.hidden = recent.length === 0;
  }

  function saveRecent() {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch { /* история необязательна */ }
  }

  function addRecent(word, main) {
    const key = word.toLowerCase();
    recent = [{ word, main }, ...recent.filter((item) => item.word.toLowerCase() !== key)].slice(0, RECENT_MAX);
    saveRecent();
    renderRecent();
  }

  els.recentClear.addEventListener('click', () => {
    recent = [];
    saveRecent();
    renderRecent();
  });

  renderRecent();

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
      addRecent(word, result.main);
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

  function selectTab(which) {
    const isUrl = which === 'url';
    els.tabUrl.setAttribute('aria-selected', String(isUrl));
    els.tabText.setAttribute('aria-selected', String(!isUrl));
    els.urlForm.hidden = !isUrl;
    els.textForm.hidden = isUrl;
    setStatus('');
  }

  els.tabUrl.addEventListener('click', () => selectTab('url'));
  els.tabText.addEventListener('click', () => selectTab('text'));

  // Ссылку на сайт можно отправить другу: ?url=https://…
  const initial = new URLSearchParams(location.search).get('url');
  if (initial) {
    els.urlInput.value = initial;
    loadUrl(initial);
  }
})();
