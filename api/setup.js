// Страница настройки: проверяет переменные, базу, CryptoBot и подключает вебхук Telegram.
// Открой https://ТВОЙ-ПРОЕКТ.vercel.app/api/setup после каждого изменения настроек.
import {
  ADMIN_IDS, BOT_TOKEN, CRYPTO_HOST, CRYPTO_TOKEN, TG_SECRET, crypto, loadCatalog, redis, tg,
} from "../lib/core.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(request) {
  const origin = new URL(request.url).origin;
  const rows = [];
  const check = async (title, fn, optional = false) => {
    try { rows.push({ ok: true, title, note: (await fn()) || "" }); return true; }
    catch (e) { rows.push({ ok: optional ? null : false, title, note: e.message }); return false; }
  };

  let botName = "";
  const botOk = await check("Токен бота (BOT_TOKEN)", async () => {
    if (!BOT_TOKEN) throw new Error("Добавь BOT_TOKEN в Settings → Environment Variables");
    const me = await tg("getMe");
    botName = me.username;
    return "@" + me.username;
  });
  await check("ID продавца (ADMIN_IDS)", async () => {
    if (!ADMIN_IDS.length || ADMIN_IDS.some(Number.isNaN)) throw new Error("Добавь ADMIN_IDS — свой ID узнай у @userinfobot");
    return ADMIN_IDS.join(", ");
  });
  await check("База заказов (Upstash Redis)", async () => {
    if ((await redis("PING")) !== "PONG") throw new Error("нет ответа");
    return "подключена";
  });
  await check("Каталог (catalog.json)", async () => {
    const c = await loadCatalog(origin);
    return `${c.categories.reduce((n, x) => n + x.items.length, 0)} предметов, оплата: ${(c.payments || []).join(", ")}`;
  });
  await check("CryptoBot (CRYPTO_PAY_TOKEN)", async () => {
    if (!CRYPTO_TOKEN) throw new Error("не задан — будет только ручной перевод");
    const me = await crypto("getMe");
    return `${me.name || "приложение"} · ${CRYPTO_HOST === "pay.crypt.bot" ? "боевая сеть" : "тестовая сеть"}`;
  }, true);
  await check("Реквизиты (MANUAL_PAYMENT_TEXT)", async () => {
    if (!process.env.MANUAL_PAYMENT_TEXT) throw new Error("не заданы — бот напишет, что реквизиты пришлёт продавец");
    return "заданы";
  }, true);
  if (botOk) {
    await check("Вебхук Telegram", async () => {
      await tg("setWebhook", {
        url: `${origin}/api/telegram`, secret_token: TG_SECRET,
        allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
      });
      await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть магазин" }] });
      return `${origin}/api/telegram`;
    });
  }

  const allOk = rows.every(r => r.ok !== false);
  const icon = (ok) => ok === true ? "✓" : ok === null ? "–" : "✕";
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Настройка магазина</title>
<style>
body{margin:0;background:#0F2620;color:#EEF4EF;font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:620px;margin:0 auto;padding:28px 18px}
h1{font-size:24px;margin:0 0 6px}p{color:#B9E4C9;margin:0 0 18px}
ul{list-style:none;padding:0;margin:0 0 22px;border:1px solid rgba(185,228,201,.15);border-radius:14px;overflow:hidden;background:#15332B}
li{display:grid;grid-template-columns:26px 1fr;gap:4px 10px;padding:12px 14px}li+li{border-top:1px solid rgba(185,228,201,.12)}
.i{font-weight:700}.ok .i{color:#5FD08A}.bad .i{color:#FF8A7A}.opt .i{color:#8DB3A0}
small{grid-column:2;color:#8DB3A0;word-break:break-all}.bad small{color:#FF8A7A}
.box{border:1px dashed rgba(185,228,201,.3);border-radius:14px;padding:14px;margin-bottom:14px}
code{background:#0A1C17;padding:2px 6px;border-radius:6px;word-break:break-all}
a{color:#E3B34C}
</style></head><body><main>
<h1>${allOk ? "Магазин подключён" : "Нужно доделать настройку"}</h1>
<p>${allOk ? "Всё работает. Открой бота и нажми /start." : "Исправь красные пункты, сделай Redeploy и обнови эту страницу."}</p>
<ul>${rows.map(r => `<li class="${r.ok === true ? "ok" : r.ok === null ? "opt" : "bad"}"><span class="i">${icon(r.ok)}</span><b>${esc(r.title)}</b><small>${esc(r.note)}</small></li>`).join("")}</ul>
${CRYPTO_TOKEN ? `<div class="box">Для CryptoBot: открой @${CRYPTO_HOST === "pay.crypt.bot" ? "CryptoBot" : "CryptoTestnetBot"} → Crypto Pay → My Apps → твоё приложение → Webhooks → включи и вставь адрес:<br><code>${origin}/api/cryptopay</code></div>` : ""}
${botName ? `<div class="box">Бот: <a href="https://t.me/${esc(botName)}">t.me/${esc(botName)}</a></div>` : ""}
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
