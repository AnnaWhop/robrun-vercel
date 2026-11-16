// Логика бота: заказы, оплата (CryptoBot + ручной перевод), статусы.
// Работает на вебхуках, без постоянно запущенного процесса: подходит для Vercel.
import { createHash } from "node:crypto";

const env = process.env;
export const BOT_TOKEN = (env.BOT_TOKEN || "").trim();
export const ADMIN_IDS = (env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
export const CRYPTO_TOKEN = (env.CRYPTO_PAY_TOKEN || "").trim();
export const CRYPTO_HOST = env.CRYPTO_TESTNET === "1" ? "testnet-pay.crypt.bot" : "pay.crypt.bot";
export const TG_SECRET = BOT_TOKEN ? createHash("sha256").update("tg:" + BOT_TOKEN).digest("hex").slice(0, 48) : "";
const R_URL = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
const MANUAL_TEXT = (env.MANUAL_PAYMENT_TEXT || "").replace(/\\n/g, "\n").trim();
const INVOICE_TTL = 3600;

const STATUS = {
  awaiting_payment: "⏳ Ждёт оплату",
  claimed: "🧾 Покупатель отметил оплату",
  paid: "💰 Оплачен",
  delivered: "✅ Передан",
  cancelled: "❌ Отменён",
};

// ---------------- внешние API ----------------

export async function redis(...cmd) {
  if (!R_URL || !R_TOKEN) throw new Error("База не подключена: нет KV_REST_API_URL / KV_REST_API_TOKEN");
  const r = await fetch(R_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("Redis: " + j.error);
  return j.result;
}

export async function tg(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

export async function crypto(method, params = {}) {
  const r = await fetch(`https://${CRYPTO_HOST}/api/${method}`, {
    method: "POST",
    headers: { "Crypto-Pay-API-Token": CRYPTO_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`CryptoBot ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

export async function loadCatalog(origin) {
  const r = await fetch(`${origin}/catalog.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`catalog.json: HTTP ${r.status}`);
  return r.json();
}

// ---------------- утилиты ----------------

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");

const kb = (...rows) => ({
  inline_keyboard: rows.map(row => row.map(([text, d]) =>
    d.startsWith("http") ? { text, url: d } : { text, callback_data: d })),
});
const shopKeyboard = (origin) => ({
  // tg.sendData работает только из reply-кнопки, а не из кнопки меню или inline.
  keyboard: [[{ text: "🛒 Открыть магазин", web_app: { url: `${origin}/` } }]],
  resize_keyboard: true,
});

async function send(chatId, text, markup) {
  try {
    return await tg("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    });
  } catch (e) { console.error("send", chatId, e.message); }
}
async function notifyAdmins(text, markup) {
  for (const a of ADMIN_IDS) await send(a, text, markup);
}

export function priceOrder(order, cat) {
  const items = Object.fromEntries(cat.categories.flatMap(c => c.items).map(i => [i.id, i]));
  const cur = cat.currency || "₽";
  const lines = []; let total = 0;
  for (const pos of (order.items || []).slice(0, 30)) {
    const id = String(pos.id), q = parseInt(pos.q, 10);
    let cost;
    if (id === "cash") {
      if (!cat.cash.steps_k.includes(q)) throw new Error(`недопустимая сумма денег: ${q}K`);
      const rate = cat.cash.tiers.filter(t => q >= t.from_k).pop().rate;
      cost = Math.round(q * rate);
      lines.push(`• $${fmt(q * 1000)} игровых денег — ${fmt(cost)} ${cur}`);
    } else {
      if (!items[id] || !(q >= 1 && q <= 99)) throw new Error(`неизвестная позиция: ${id} × ${q}`);
      cost = items[id].price * q;
      lines.push(`• ${esc(items[id].name)} × ${q} — ${fmt(cost)} ${cur}`);
    }
    total += cost;
  }
  if (!lines.length) throw new Error("пустой заказ");
  return { lines, total };
}

// ---------------- хранилище заказов ----------------
// order:{no} — JSON заказа, order:{no}:status — статус (отдельно, чтобы менять атомарно)

const MOVE_LUA = `local s = redis.call('GET', KEYS[1])
for i = 2, #ARGV do if s == ARGV[i] then redis.call('SET', KEYS[1], ARGV[1]) return 1 end end
return 0`;

async function getOrder(no) {
  const [raw, status] = await redis("MGET", `order:${no}`, `order:${no}:status`);
  return raw ? { ...JSON.parse(raw), status } : null;
}
async function saveOrder(o) {
  const { status, ...rest } = o;
  await redis("SET", `order:${o.no}`, JSON.stringify(rest));
}
// Меняет статус, только если текущий из списка from. Защита от двойных нажатий и повторных вебхуков.
async function move(no, from, to) {
  return (await redis("EVAL", MOVE_LUA, "1", `order:${no}:status`, to, ...from)) === 1;
}
async function firstTime(key) {
  return (await redis("SET", key, "1", "NX", "EX", "86400")) === "OK";
}

function orderCard(o, cur) {
  const d = o.data;
  let who = `<a href="tg://user?id=${o.user_id}">${esc(o.full_name || "покупатель")}</a>`;
  if (o.username) who += ` (@${esc(o.username)})`;
  const method = o.pay === "crypto" ? "CryptoBot (USDT/TON)" : "ручной перевод";
  let t = `<b>Заказ №${o.no}</b> от ${who}\n\n${o.lines}\n\n<b>Итого: ${fmt(o.total)} ${cur}</b>\n` +
    `Оплата: ${method}\n\n` +
    `Регион: ${esc(d.region || "—")}, сервер: <b>${esc(d.server || "—")}</b>\n` +
    `Ник в игре: <b>${esc(d.nick || "—")}</b>\nКогда: ${esc(d.when || "—")}`;
  if (d.comment) t += `\nКомментарий: ${esc(d.comment)}`;
  return t;
}

async function onPaid(no, how, origin) {
  const o = await getOrder(no);
  const cat = await loadCatalog(origin);
  await send(o.user_id, `💰 Оплата по заказу №${no} получена. Продавец скоро напишет и передаст товар в игре.`);
  await notifyAdmins(`💰 <b>Оплачен</b> (${esc(how)})\n\n${orderCard(o, cat.currency || "₽")}`,
    kb([["✅ Передал покупателю", `adm:done:${no}`]]));
}

// ---------------- обработка Telegram ----------------

export async function handleUpdate(update, origin) {
  if (update.update_id != null && !(await firstTime(`upd:${update.update_id}`))) return; // повтор от Telegram
  const m = update.message;
  if (m?.web_app_data) return onOrder(m, origin);
  if (m?.text?.startsWith("/start")) {
    return send(m.chat.id,
      "Привет! Здесь можно купить игровые деньги и предметы ROB RUN.\n" +
      "Передача проходит в игре, доступ к аккаунту не нужен.\n\nНажми «Открыть магазин» внизу.",
      shopKeyboard(origin));
  }
  if (m && (m.photo || m.document)) return onReceipt(m);
  if (m?.text && !ADMIN_IDS.includes(m.from.id)) {
    return send(m.chat.id, "Чтобы сделать заказ, нажми «Открыть магазин» внизу.", shopKeyboard(origin));
  }
  const cb = update.callback_query;
  if (cb?.data?.startsWith("usr:claimed:")) return onClaimed(cb);
  if (cb?.data?.startsWith("adm:")) return onAdmin(cb, origin);
  if (cb) return tg("answerCallbackQuery", { callback_query_id: cb.id });
}

async function onOrder(m, origin) {
  let order, cat, priced;
  try {
    order = JSON.parse(m.web_app_data.data);
    cat = await loadCatalog(origin);
    priced = priceOrder(order, cat);
  } catch (e) {
    console.warn("плохой заказ", m.from.id, e.message);
    return send(m.chat.id, "Не получилось принять заказ. Открой магазин и собери корзину заново.");
  }
  const cur = cat.currency || "₽";
  const { lines, total } = priced;
  let pay = order.pay;
  if (!(cat.payments || ["manual"]).includes(pay) || (pay === "crypto" && !CRYPTO_TOKEN)) pay = "manual";

  const no = await redis("INCR", "orders:seq");
  const u = m.from;
  const o = {
    no, created: new Date().toISOString(), user_id: u.id, username: u.username || "",
    full_name: [u.first_name, u.last_name].filter(Boolean).join(" "),
    data: order, lines: lines.join("\n"), total, pay, invoice_id: null, invoice_url: null,
  };
  await saveOrder(o);
  await redis("SET", `order:${no}:status`, "awaiting_payment");
  await redis("SET", `user:${u.id}:last`, String(no));

  const summary = `🧾 <b>Заказ №${no}</b>\n\n${o.lines}\n\n<b>Итого: ${fmt(total)} ${cur}</b>`;

  if (pay === "crypto") {
    try {
      const inv = await crypto("createInvoice", {
        currency_type: "fiat", fiat: cat.currency_code || "RUB", amount: String(total),
        accepted_assets: "USDT,TON", description: `Заказ №${no} — ROB RUN`,
        payload: String(no), expires_in: INVOICE_TTL, allow_comments: false,
      });
      o.invoice_id = inv.invoice_id; o.invoice_url = inv.bot_invoice_url;
      await saveOrder(o);
      await send(m.chat.id,
        `${summary}\n\nОплати в @CryptoBot, подойдут USDT или TON. Счёт действует 1 час.\n` +
        "Как только оплата пройдёт, я сразу передам заказ продавцу.",
        kb([[`Оплатить ${fmt(total)} ${cur}`, inv.bot_invoice_url]]));
    } catch (e) {
      console.error("createInvoice", e.message);
      pay = o.pay = "manual"; await saveOrder(o);
      await send(m.chat.id, "CryptoBot сейчас не отвечает, поэтому пришлю реквизиты для перевода.");
    }
  }
  if (pay === "manual") {
    const details = MANUAL_TEXT || "Продавец пришлёт реквизиты в личные сообщения.";
    await send(m.chat.id,
      `${summary}\n\nПереведи <b>${fmt(total)} ${cur}</b>:\n\n${details}\n\n` +
      "После перевода нажми «Я оплатил» и пришли сюда скрин чека.",
      kb([["Я оплатил", `usr:claimed:${no}`]]));
  }

  const adminKb = pay === "manual"
    ? kb([["💰 Оплата получена", `adm:paid:${no}`], ["Отменить", `adm:cancel:${no}`]])
    : kb([["Отменить", `adm:cancel:${no}`]]);
  await notifyAdmins(`🆕 ${STATUS.awaiting_payment}\n\n${orderCard({ ...o, status: "awaiting_payment" }, cur)}`, adminKb);
  if (Math.abs((Number(order.total) || 0) - total) > 1) {
    await notifyAdmins(`⚠️ Заказ №${no}: в мини-аппе была сумма ${fmt(order.total || 0)} ${cur}. Верная — ${fmt(total)} ${cur}.`);
  }
}

async function onReceipt(m) {
  if (ADMIN_IDS.includes(m.from.id)) return;
  const no = await redis("GET", `user:${m.from.id}:last`);
  const o = no && await getOrder(no);
  if (!o || !["awaiting_payment", "claimed"].includes(o.status)) {
    return send(m.chat.id, "Не вижу у тебя неоплаченных заказов. Собери заказ в магазине.");
  }
  for (const a of ADMIN_IDS) {
    try {
      await tg("forwardMessage", { chat_id: a, from_chat_id: m.chat.id, message_id: m.message_id });
      await send(a, `☝️ Чек от покупателя по заказу <b>№${no}</b>`);
    } catch (e) { console.error("forward", a, e.message); }
  }
  return send(m.chat.id, `Чек получил и передал продавцу (заказ №${no}).`);
}

const answer = (cb, text, alert = false) =>
  tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
const stamp = (cb, label, markup) => tg("editMessageReplyMarkup", {
  chat_id: cb.message.chat.id, message_id: cb.message.message_id,
  reply_markup: markup || kb([[label, "noop"]]),
}).catch(e => console.warn("stamp", e.message));

async function onClaimed(cb) {
  const no = Number(cb.data.split(":")[2]);
  const o = await getOrder(no);
  if (!o || o.user_id !== cb.from.id) return answer(cb, "Это не твой заказ", true);
  if (!(await move(no, ["awaiting_payment"], "claimed"))) return answer(cb, `Статус заказа: ${STATUS[o.status] || o.status}`, true);
  await stamp(cb, "🧾 Оплата отмечена");
  await answer(cb);
  await send(cb.from.id, `Принято. Продавец проверит перевод по заказу №${no} и напишет тебе. ` +
    "Если ещё не прислал скрин чека, пришли его сюда.");
  await notifyAdmins(`🧾 Покупатель отметил оплату по заказу <b>№${no}</b>. Проверь поступление <b>${fmt(o.total)} ₽</b>.`,
    kb([["💰 Оплата получена", `adm:paid:${no}`], ["Оплаты нет", `adm:nopay:${no}`]]));
}

async function onAdmin(cb, origin) {
  if (!ADMIN_IDS.includes(cb.from.id)) return answer(cb, "Только для продавца", true);
  const [, action, noS] = cb.data.split(":");
  const no = Number(noS);
  const o = await getOrder(no);
  if (!o) return answer(cb, "Заказ не найден", true);
  const already = () => answer(cb, `Уже: ${STATUS[o.status] || o.status}`, true);

  if (action === "paid") {
    if (!(await move(no, ["awaiting_payment", "claimed"], "paid"))) return already();
    await stamp(cb, null, kb([["✅ Передал покупателю", `adm:done:${no}`]]));
    await send(o.user_id, `💰 Оплата по заказу №${no} подтверждена. Продавец скоро напишет и передаст товар в игре.`);
  } else if (action === "nopay") {
    if (!(await move(no, ["claimed"], "awaiting_payment"))) return already();
    await stamp(cb, "Оплаты нет — покупатель предупреждён");
    await send(o.user_id, `Продавец пока не видит перевод по заказу №${no}. Проверь платёж и пришли скрин чека сюда.`,
      kb([["Я оплатил", `usr:claimed:${no}`]]));
  } else if (action === "done") {
    if (!(await move(no, ["paid"], "delivered"))) return already();
    await stamp(cb, STATUS.delivered);
    await send(o.user_id, `✅ Заказ №${no} передан. Спасибо за покупку!`, shopKeyboard(origin));
  } else if (action === "cancel") {
    if (!(await move(no, ["awaiting_payment", "claimed"], "cancelled"))) return already();
    if (o.pay === "crypto" && o.invoice_id) {
      await crypto("deleteInvoice", { invoice_id: o.invoice_id }).catch(e => console.warn("deleteInvoice", e.message));
    }
    await stamp(cb, STATUS.cancelled);
    await send(o.user_id, `Заказ №${no} отменён. Если есть вопросы, напиши сюда.`);
  }
  return answer(cb);
}

// ---------------- вебхук CryptoBot ----------------

export async function handleCryptoUpdate(update, origin) {
  if (update.update_type !== "invoice_paid") return;
  const id = update.payload?.invoice_id;
  if (!id) return;
  // Не верим телу запроса: перепроверяем счёт напрямую в CryptoBot.
  const res = await crypto("getInvoices", { invoice_ids: String(id) });
  const inv = (Array.isArray(res) ? res : res.items || [])[0];
  if (!inv || inv.status !== "paid") return;
  const no = Number(inv.payload);
  if (!no || !(await move(no, ["awaiting_payment"], "paid"))) return;
  await onPaid(no, `CryptoBot, ${inv.paid_amount || ""} ${inv.paid_asset || ""}`.trim(), origin);
}
