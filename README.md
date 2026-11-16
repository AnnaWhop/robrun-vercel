# Магазин ROB RUN на Vercel (бесплатно, без своего сервера)

```
public/index.html     — мини-апп
public/catalog.json   — товары, цены, способы оплаты
api/telegram.js       — вебхук бота
api/cryptopay.js      — вебхук оплаты CryptoBot
api/setup.js          — страница проверки и подключения
lib/core.js           — вся логика заказов
```

Устанавливать на компьютер ничего не нужно, всё делается в браузере.

## 1. Подготовь данные

- **Токен бота:** напиши @BotFather → `/newbot` → скопируй токен.
- **Свой Telegram ID:** напиши @userinfobot → скопируй число.
- **Токен CryptoBot (для теста):** @CryptoTestnetBot → Crypto Pay → Create App → скопируй токен.
  Для настоящих платежей то же самое делается в @CryptoBot.

## 2. Залей проект на GitHub

1. Зарегистрируйся на github.com → справа вверху **+** → **New repository** → любое имя → **Create repository**.
2. На странице репозитория нажми **uploading an existing file**.
3. Перетащи в окно **содержимое** папки `robrun-vercel`: папки `public`, `api`, `lib` и файлы `package.json`, `vercel.json`, `README.md`.
4. Нажми **Commit changes**.

## 3. Задеплой на Vercel

1. Зайди на vercel.com → **Continue with GitHub**.
2. **Add New → Project** → выбери репозиторий → **Import**.
3. Framework Preset: **Other** → **Deploy**. Через минуту появится адрес вида `https://имя.vercel.app`.

## 4. Подключи базу заказов (бесплатно)

В проекте на Vercel: **Storage → Create Database → Upstash for Redis** → план **Free** → **Connect**.
Vercel сам добавит переменные `KV_REST_API_URL` и `KV_REST_API_TOKEN`.

## 5. Добавь настройки

**Settings → Environment Variables**, добавь по одной:

| Имя | Значение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather |
| `ADMIN_IDS` | твой ID (несколько через запятую) |
| `CRYPTO_PAY_TOKEN` | токен приложения CryptoBot |
| `CRYPTO_TESTNET` | `1` пока тестируешь, потом удали |
| `MANUAL_PAYMENT_TEXT` | реквизиты, например: `<b>СБП:</b> +7 900 000-00-00, Банк, Имя Ф.` |

Потом открой **Deployments** → у последнего деплоя **⋯ → Redeploy**.
Без этого шага новые переменные не применятся.

## 6. Запусти

Открой `https://имя.vercel.app/api/setup`.
Страница проверит всё по пунктам и подключит бота к Telegram.
Если есть красные пункты, исправь их, сделай Redeploy и обнови страницу.

На этой же странице есть адрес для CryptoBot:
@CryptoTestnetBot → Crypto Pay → My Apps → приложение → **Webhooks** → включи и вставь адрес
`https://имя.vercel.app/api/cryptopay`.

Готово: пиши боту `/start`.

## Как тестировать

1. **Крипта:** оплати счёт тестовыми монетами из @CryptoTestnetBot. Бот сам напишет «Оплачен», а тебе придёт кнопка «Передал».
2. **Перевод:** выбери «Перевод», нажми «Я оплатил», пришли любую картинку. Тебе придут чек и кнопки «Оплата получена» / «Оплаты нет».
3. **Боевой режим:** удали `CRYPTO_TESTNET`, поставь токен из настоящего @CryptoBot, сделай Redeploy и снова открой `/api/setup`.

## Полезно знать

- Цены меняются в `public/catalog.json` на GitHub (иконка карандаша → Commit). Vercel обновится сам за минуту.
- Если поменял настройки или адрес проекта, снова открой `/api/setup`.
- Логи ошибок: Vercel → проект → **Logs**.
- Неоплаченные крипто-счета сгорают через час молча. Такие заказы можно отменить кнопкой «Отменить».
- Бесплатный план Vercel (Hobby) по правилам Vercel только для некоммерческих проектов.
  Код написан без привязки к Vercel, поэтому для работы магазина в долгую его можно перенести, например на Cloudflare.
