// Вебхук CryptoBot: приходит, когда покупатель оплатил счёт.
import { handleCryptoUpdate, CRYPTO_TOKEN } from "../lib/core.js";

export async function POST(request) {
  if (!CRYPTO_TOKEN) return new Response("crypto disabled", { status: 404 });
  try {
    await handleCryptoUpdate(await request.json(), new URL(request.url).origin);
  } catch (e) {
    console.error("crypto update failed:", e);
    return new Response("error", { status: 500 }); // CryptoBot повторит позже
  }
  return new Response("ok");
}

export function GET() {
  return new Response("Вебхук CryptoBot работает.");
}
