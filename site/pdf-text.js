/*
 * Превращает текстовые фрагменты, которые отдаёт pdf.js, в аккуратные абзацы:
 *  - собирает строки из фрагментов и вставляет пропущенные пробелы;
 *  - убирает номера страниц и повторяющиеся колонтитулы;
 *  - склеивает строки в абзацы по межстрочным интервалам и отступам;
 *  - убирает переносы слов («exam-\nple» → «example»);
 *  - находит заголовки по размеру шрифта;
 *  - склеивает абзацы, разорванные границей страницы.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const END_OF_SENTENCE = /[.!?:;"”’')\]…]$/;

  function cleanText(text) {
    return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  // Фрагменты одной страницы -> строки {text, x, y, size}
  function pageToLines(items) {
    const lines = [];
    let cur = null;
    let prev = null;

    const flush = () => {
      if (cur) lines.push(cur);
      cur = null;
      prev = null;
    };

    for (const item of items) {
      if (!item || typeof item.str !== 'string' || !item.transform) continue;

      if (item.str === '') {
        if (item.hasEOL) flush();
        continue;
      }

      const x = item.transform[4];
      const y = item.transform[5];
      const size = Math.abs(item.height) || Math.hypot(item.transform[0], item.transform[1]) || 10;

      if (cur && Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.5) flush();

      if (!cur) {
        cur = { text: '', x, y, size };
      } else if (prev) {
        const gap = x - (prev.transform[4] + (prev.width || 0));
        if (gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(item.str)) cur.text += ' ';
      }

      cur.text += item.str;
      cur.size = Math.max(cur.size, size);
      prev = item;

      if (item.hasEOL) flush();
    }
    flush();

    return lines
      .map((line) => ({ ...line, text: cleanText(line.text) }))
      .filter((line) => line.text);
  }

  // Номера страниц и колонтитулы, повторяющиеся на многих страницах
  function dropPageFurniture(pages) {
    const total = pages.length;
    const normalize = (text) => text.replace(/\d+/g, '#').toLowerCase();
    const pageNumber = /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i;

    const counts = new Map();
    for (const lines of pages) {
      const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => normalize(l.text)));
      for (const key of edge) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const threshold = Math.max(3, Math.ceil(total * 0.5));

    return pages.map((lines) =>
      lines.filter((line, i) => {
        const onEdge = i < 2 || i >= lines.length - 2;
        if (!onEdge) return true;
        if (pageNumber.test(line.text)) return false;
        return !(total >= 4 && counts.get(normalize(line.text)) >= threshold);
      })
    );
  }

  // Самый частый размер шрифта (с учётом длины текста) считаем размером основного текста
  function bodyFontSize(pages) {
    const buckets = new Map();
    for (const lines of pages) {
      for (const line of lines) {
        const key = Math.round(line.size * 2) / 2;
        buckets.set(key, (buckets.get(key) || 0) + line.text.length);
      }
    }
    let best = 10;
    let bestWeight = -1;
    for (const [size, weight] of buckets) {
      if (weight > bestWeight) {
        best = size;
        bestWeight = weight;
      }
    }
    return best;
  }

  // Обычный межстрочный интервал: самое частое расстояние между соседними строками по всему документу
  function typicalLeading(pages, bodySize) {
    const buckets = new Map();
    for (const lines of pages) {
      for (let i = 1; i < lines.length; i++) {
        const gap = lines[i - 1].y - lines[i].y;
        if (gap <= 0 || gap > bodySize * 4) continue;
        const key = Math.round(gap * 2) / 2;
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
    }
    let best = 0;
    let bestCount = 0;
    for (const [gap, count] of buckets) {
      if (count > bestCount || (count === bestCount && gap < best)) {
        best = gap;
        bestCount = count;
      }
    }
    return best || bodySize * 1.2;
  }

  function joinText(a, b) {
    if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
    return a + ' ' + b;
  }

  // Строки страницы -> блоки {type: 'h' | 'p', text}
  function linesToBlocks(lines, bodySize, leading) {
    if (!lines.length) return [];

    const groups = [];
    let cur = null;
    lines.forEach((line, i) => {
      const prev = lines[i - 1];
      let split = !cur;
      if (!split) {
        const gap = prev.y - line.y;
        if (gap < 0 || gap > leading * 1.3) split = true; // большой интервал или другая колонка
        else if (Math.abs(line.size - prev.size) > bodySize * 0.15) split = true; // другой размер шрифта
        else if (line.x - prev.x > bodySize * 0.8 && END_OF_SENTENCE.test(prev.text)) split = true; // красная строка
      }
      if (split) {
        cur = { lines: [], size: line.size };
        groups.push(cur);
      }
      cur.lines.push(line);
      cur.size = Math.max(cur.size, line.size);
    });

    return groups.map((group) => {
      let text = group.lines[0].text;
      for (let i = 1; i < group.lines.length; i++) text = joinText(text, group.lines[i].text);
      const heading = group.size >= bodySize * 1.25 && text.length <= 160;
      return { type: heading ? 'h' : 'p', text };
    });
  }

  // pages: массив страниц, каждая страница: массив фрагментов pdf.js (textContent.items)
  function itemsToBlocks(pages) {
    const lined = dropPageFurniture(pages.map(pageToLines));
    const bodySize = bodyFontSize(lined);
    const leading = typicalLeading(lined, bodySize);

    const result = [];
    let carry = false; // предыдущий абзац мог продолжиться на следующей странице
    for (const lines of lined) {
      const blocks = linesToBlocks(lines, bodySize, leading);
      blocks.forEach((block, i) => {
        const last = result[result.length - 1];
        if (
          i === 0 && carry && last && last.type === 'p' && block.type === 'p' &&
          !END_OF_SENTENCE.test(last.text) && /^\p{Ll}/u.test(block.text)
        ) {
          last.text = joinText(last.text, block.text);
        } else {
          result.push(block);
        }
      });
      carry = blocks.length > 0 && blocks[blocks.length - 1].type === 'p';
    }
    return result;
  }

  return { itemsToBlocks, pageToLines };
});
