// src/index.js
import express from "express";
import { Telegraf, Markup } from "telegraf";
import Stripe from "stripe";
import pg from "pg";

const {
  BOT_TOKEN,
  DATABASE_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRICE_ID,
  APP_URL
} = process.env;

if (
  !BOT_TOKEN ||
  !DATABASE_URL ||
  !STRIPE_SECRET_KEY ||
  !STRIPE_WEBHOOK_SECRET ||
  !PRICE_ID ||
  !APP_URL
) {
  throw new Error("Missing env vars");
}

const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// RAW body нужен для webhook
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature failed", err.message);
      return res.status(400).send(`Webhook Error`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.mode === "subscription") {
        await pool.query(
          `
          insert into subscriptions
          (telegram_user_id, stripe_customer_id, stripe_subscription_id, status)
          values ($1, $2, $3, 'active')
          on conflict (telegram_user_id)
          do update set
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            status = 'active',
            updated_at = now()
          `,
          [
            session.client_reference_id,
            session.customer,
            session.subscription
          ]
        );
      }
    }

    res.json({ received: true });
  }
);

// обычный JSON для остальных роутов
app.use(express.json());

// DB
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    create table if not exists subscriptions (
      telegram_user_id bigint primary key,
      stripe_customer_id text,
      stripe_subscription_id text,
      status text not null,
      updated_at timestamptz not null default now()
    );
  `);
}

// Telegram bot
const bot = new Telegraf(BOT_TOKEN);

app.post("/telegram", (req, res) => bot.handleUpdate(req.body, res));

bot.start((ctx) => {
  ctx.reply(
    "Health Lab Padel",
    Markup.inlineKeyboard([
      [Markup.button.callback("Subscribe", "subscribe")]
    ])
  );
});

bot.action("subscribe", async (ctx) => {
  await ctx.answerCbQuery();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: `${APP_URL}/success`,
    cancel_url: `${APP_URL}/cancel`,
    client_reference_id: ctx.from.id
  });

  return ctx.reply(
    "Оплата подписки:",
    Markup.inlineKeyboard([
      Markup.button.url("Перейти к оплате", session.url)
    ])
  );
});

app.get("/success", (req, res) =>
  res.send("Оплата прошла успешно. Можно закрыть страницу.")
);

app.get("/cancel", (req, res) =>
  res.send("Оплата отменена.")
);

const PORT = process.env.PORT || 3000;
initDb().then(() => app.listen(PORT));
