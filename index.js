// src/index.js
import express from "express";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

// Minimal env vars for current step (language + DB)
const { BOT_TOKEN, DATABASE_URL, RU_CHANNEL_ID, LV_CHANNEL_ID } = process.env;

if (!BOT_TOKEN || !DATABASE_URL || !RU_CHANNEL_ID || !LV_CHANNEL_ID) {
  throw new Error(
    "Missing env vars: BOT_TOKEN, DATABASE_URL, RU_CHANNEL_ID, LV_CHANNEL_ID"
  );
}

const app = express();
app.use(express.json());

// Postgres (Render)
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    create table if not exists users (
      telegram_user_id bigint primary key,
      language text not null default 'ru',
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists subscriptions (
      telegram_user_id bigint primary key references users(telegram_user_id),
      stripe_subscription_id text unique,
      status text not null default 'inactive',
      updated_at timestamptz not null default now()
    );
  `);
}

async function upsertUserLanguage(telegramUserId, language) {
  await pool.query(
    `
    insert into users (telegram_user_id, language)
    values ($1, $2)
    on conflict (telegram_user_id)
    do update set language = excluded.language
    `,
    [telegramUserId, language]
  );
}

async function getUserLanguage(telegramUserId) {
  const r = await pool.query(
    `select language from users where telegram_user_id = $1`,
    [telegramUserId]
  );
  return r.rows[0]?.language || null;
}

function mainMenu(lang) {
  if (lang === "lv") {
    return Markup.inlineKeyboard([
      [Markup.button.callback("Abonēt", "subscribe")],
      [Markup.button.callback("Uzzināt vairāk", "more")],
      [Markup.button.callback("Mainīt valodu", "change_lang")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("Оформить подписку", "subscribe")],
    [Markup.button.callback("Узнать больше", "more")],
    [Markup.button.callback("Сменить язык", "change_lang")]
  ]);
}

function languageKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.callback("Русский", "lang_ru"),
    Markup.button.callback("Latviešu", "lang_lv")
  ]);
}

// Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Render will POST updates here (webhook from Telegram)
app.post("/telegram", (req, res) => bot.handleUpdate(req.body, res));

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// /start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const lang = await getUserLanguage(userId);

  if (lang === "ru") {
    return ctx.reply("Добро пожаловать в Health Lab Padel - RU", mainMenu("ru"));
  }
  if (lang === "lv") {
    return ctx.reply("Laipni lūdzam Health Lab Padel - LV", mainMenu("lv"));
  }

  return ctx.reply("Выберите язык / Izvēlieties valodu", languageKeyboard());
});

// Change language button
bot.action("change_lang", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply("Выберите язык / Izvēlieties valodu", languageKeyboard());
});

// Language actions
bot.action("lang_ru", async (ctx) => {
  await ctx.answerCbQuery();
  await upsertUserLanguage(ctx.from.id, "ru");
  await ctx.reply("Язык сохранен. Добро пожаловать в Health Lab Padel - RU");
  return ctx.reply("Меню:", mainMenu("ru"));
});

bot.action("lang_lv", async (ctx) => {
  await ctx.answerCbQuery();
  await upsertUserLanguage(ctx.from.id, "lv");
  await ctx.reply("Valoda saglabāta. Laipni lūdzam Health Lab Padel - LV");
  return ctx.reply("Izvēlne:", mainMenu("lv"));
});

// Menu actions (placeholders for now)
bot.action("more", async (ctx) => {
  await ctx.answerCbQuery();
  const lang = (await getUserLanguage(ctx.from.id)) || "ru";

  if (lang === "lv") {
    return ctx.reply(
      "Kanālā: uzturs padel spēlētājiem, papildinājumi, atjaunošanās, praktiski protokoli un Q&A."
    );
  }

  return ctx.reply(
    "В канале: питание для паделистов, добавки, восстановление, практические протоколы и Q&A."
  );
});

bot.action("subscribe", async (ctx) => {
  await ctx.answerCbQuery();
  const lang = (await getUserLanguage(ctx.from.id)) || "ru";

  if (lang === "lv") {
    return ctx.reply("Abonēšana būs nākamais solis (Stripe Checkout).");
  }

  return ctx.reply("Подписка - следующий шаг (Stripe Checkout).");
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log("Server started on", PORT));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
