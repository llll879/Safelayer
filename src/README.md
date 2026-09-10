# KMBP SafeLayer — Termux/Android

Версия без зависимости `sharp`, чтобы бот запускался в Termux на Android ARM64.

## Запуск

```bash
npm install
npm start
```

Создай `.env` рядом с `package.json`:

```env
BOT_TOKEN=токен_бота
ADMIN_IDS=123456789
COMPLAINT_CHAT_ID=
DB_FILE=./data/kmbp.json
```

### Динамические карточки SafeLayer

Бот больше не падает из-за `sharp`.

Если в системе есть ImageMagick (`magick` или `convert`), бот автоматически наносит на шаблоны динамические данные: username, ID и причины нарушений.

В Termux при желании можно установить ImageMagick:

```bash
pkg update
pkg install imagemagick
```

Но **это не обязательно для запуска бота**: без ImageMagick будут отправляться исходные шаблоны, а актуальные данные всё равно будут в подписи сообщения.

## Основные команды

- `/start` — главное меню
- `/check @bot` — проверка
- `/search запрос` — поиск
- `/register` — регистрация проекта
- `/report @bot причина` — жалоба
- `/stats` — статистика
- `/top` — проверенные проекты
- `/recent` — последние добавления
- `/cancel` — отменить ввод

### Администратор

- `/admin`
- `/addbot @bot Название | описание`
- `/verify @bot`
- `/setid @bot 123456789`
- `/warnbot @bot причина`
- `/banbot @bot причина`
- `/unbanbot @bot`
- `/reason @bot текст`
- `/botnote @bot текст`
- `/setstats @bot users=100,active=20`
- `/logs`

## Важно про Telegram ID ботов

Telegram Bot API не позволяет надёжно получить ID произвольного чужого бота только по его username. Поэтому для базы предусмотрена команда администратора `/setid`.

Не публикуй токен бота в чатах и репозиториях. Если токен когда-либо был раскрыт, перевыпусти его через BotFather.

### Обновление карточек и /help
- Раздел администратора в `/help` показывается только пользователям из `ADMIN_IDS`.
- Обычные пользователи получают только публичные команды.
- На изображениях карточек шаблонные `support_good_bot`, `bad_support_bot`, `unknown_bot` и базовые заголовки перекрываются динамическими данными из базы.
- Для карточек используются реальное `b.name`, `@username` и `telegramId`, а для плохих карточек — подтверждённые причины из базы.
- Для отрисовки текста поверх PNG нужен ImageMagick в Termux: `pkg update && pkg install imagemagick`.
