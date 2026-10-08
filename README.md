# Читалка EN → RU

Вставляешь ссылку на английскую статью, она открывается в удобном виде, а при нажатии на слово появляется перевод на русский.

## Как устроено

- Статический сайт без сборки: `site/index.html`, `site/style.css`, `site/app.js`.
- Статья скачивается через публичные CORS-прокси (allorigins, corsproxy.io, r.jina.ai) и очищается библиотекой [Readability](https://github.com/mozilla/readability). Копия лежит в `site/vendor/`.
- Текст чистится через [DOMPurify](https://github.com/cure53/DOMPurify), каждое слово оборачивается в `<span>`.
- Перевод берётся из Google Translate (неофициальный endpoint), запасной вариант: MyMemory. Переводы кэшируются в `localStorage`.
- Если сайт не отдаёт статью, можно вставить текст вручную во вкладке «Свой текст».
- Ссылкой можно поделиться: `https://<user>.github.io/<repo>/?url=https://example.com/article`.

## Деплой

Workflow `.github/workflows/deploy.yml` публикует папку `site/` на GitHub Pages при каждом пуше в `main`.

Один раз включи Pages: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Локальный запуск

```bash
cd site
python3 -m http.server 8000
# открой http://localhost:8000
```
