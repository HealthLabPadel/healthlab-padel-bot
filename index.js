import express from "express";
import Stripe from "stripe";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

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

if (!BOT_TOKEN || !STRIPE_SECRET_KEY || !DATABASE_URL || !RU_CHANNEL_ID || !LV_CHANNEL_ID || !APP_URL || !PRICE_ID) {
  throw new Error("Missing env vars");
}

const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

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

const bot = new Telegraf(BOT_TOKEN);

app.use(express.json());
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

bot.action("lang_ru", (ctx) => {
  ctx.answerCbQuery();
  ctx.reply("Добро пожаловать в Health Lab Padel - RU");
});

bot.action("lang_lv", (ctx) => {
  ctx.answerCbQuery();
  ctx.reply("Laipni lūdzam Health Lab Padel - LV");
});

app.get("/", (req, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => console.log("Server started on", PORT));
});
