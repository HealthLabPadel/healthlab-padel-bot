import express from "express";
import Stripe from "stripe";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

// -------------------- ENV --------------------
const {
  BOT_TOKEN,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  DATABASE_URL,
  RU_CHANNEL_ID,
  LV_CHANNEL_ID,
  APP_URL,
  PRICE_ID
} = process.env;

// Обязательные переменные только для запуска бота и базы
const required = ["BOT_TOKEN", "DATABASE_URL", "RU_CHANNEL_ID", "LV_CHANNEL_ID"];
const missing = required.filter((k) => !process.env[k]);

if (missing.length) {
  throw new Error("Missing env vars: " + missing.join(", "));
}

// Stripe создаем только если ключ реально задан (чтобы деплой не падал)
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// -------------------- APP --------------------
const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (req, res) => res.send("Bot is running"));

// -------------------- DB --------------------
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    create table if not exists users (
      telegram_user_id bigint primary key,
      language text not null default 'ru',
      stripe_customer_id text,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists subscriptions (
      telegram_user_id bigint primary key references users(telegram_user_id),
      stripe_subscription_id text unique,
      status text not null default 'active',
      updated_at timestamptz not null default now()
    );
  `);
}

// -------------------- TELEGRAM BOT --------------------
const bot = new Telegraf(BOT_TOKEN);

// Если позже включим webhook - этот endpoint пригодится.
// Сейчас он не мешает.
app.post("/telegram", (req, res) => bot.handleUpdate(req.body, res));

bot.start((ctx) => {
  ctx.reply(
    "Выберите язык / Izvēlieties valodu",
    Markup.inlineKeyboard([
      Markup.button.callback("Русский", "lang_ru"),
      Markup.button.callback("Latviešu", "lang_lv")
    ])
  );
});

bot.action("lang_ru", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Добро пожаловать в Health Lab Padel - RU");
});

bot.action("lang_lv", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Laipni lūdzam Health Lab Padel - LV");
});

// -------------------- OPTIONAL: Stripe placeholders --------------------
// Пока не используем, но оставлено для будущего подключения.
// Чтобы случайно не пытаться запускать оплату без env - даем понятный ответ.
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe || !PRICE_ID) {
      return res.status(400).json({
        ok: false,
        message:
          "Stripe is not configured yet. Set STRIPE_SECRET_KEY and PRICE_ID in Render env vars."
      });
    }

    // Тут позже будет логика создания checkout session
    return res.status(501).json({ ok: false, message: "Not implemented yet" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;

initDb()
  .then(async () => {
    app.listen(PORT, () => console.log("Server started on", PORT));

    // Самый простой вариант для новичка: long polling
    // (чтобы бот отвечал сразу без webhook)
    await bot.launch();
    console.log("Bot launched (long polling)");
  })
  .catch((e) => {
    console.error("Startup error:", e);
    process.exit(1);
  });

// Корректное завершение
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
