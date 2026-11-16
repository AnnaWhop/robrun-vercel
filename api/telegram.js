// Вебхук Telegram: сюда приходят все сообщения и нажатия кнопок.
import { handleUpdate, TG_SECRET } from "../lib/core.js";

export async function POST(request) {
  if (!TG_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== TG_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    await handleUpdate(await request.json(), new URL(request.url).origin);
  } catch (e) {
    console.error("update failed:", e);
  }
  // Всегда 200, иначе Telegram будет повторять запрос.
  return new Response("ok");
}

export function GET() {
  return new Response("Вебхук Telegram работает. Настройка: /api/setup");
}
