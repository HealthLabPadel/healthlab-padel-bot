// src/index.js
import express from "express";
import Stripe from "stripe";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

// -------------------- ENV --------------------
const {
  BOT_TOKEN,
  DATABASE_URL,
  RU_CHANNEL_ID,
  LV_CHANNEL_ID,
  APP_URL, // e.g. https://healthlab-padel-bot.onrender.com
  PRICE_ID, // price_...
  STRIPE_SECRET_KEY, // sk_test_... or sk_live_...
  STRIPE_WEBHOOK_SECRET // whsec_...
} = process.env;

const required = [
  "BOT_TOKEN",
  "DATABASE_URL",
  "RU_CHANNEL_ID",
  "LV_CHANNEL_ID",
  "APP_URL",
  "PRICE_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET"
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

// -------------------- APP SETUP --------------------
const app = express();

// IMPORTANT: Stripe webhooks need RAW body for signature verification
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );

      await handleStripeEvent(event);
      return res.status(200).send("OK");
    } catch (err) {
      console.error("Stripe webhook error:", err?.message || err);
      return res.status(400).send(`Webhook Error: ${err?.message || "unknown"}`);
    }
  }
);

// For everything else, normal JSON
app.use(express.json());

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Optional endpoints for success/cancel (Stripe redirects)
app.get("/stripe/success", (req, res) =>
  res
    .status(200)
    .send("Payment successful. You can return to Telegram and press /start.")
);

app.get("/stripe/cancel", (req, res) =>
  res.status(200).send("Payment canceled. You can return to Telegram.")
);

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

async function getUser(telegramUserId) {
  const r = await pool.query(
    `
    select telegram_user_id, language, stripe_customer_id
    from users
    where telegram_user_id = $1
    `,
    [telegramUserId]
  );
  return r.rows[0] || null;
}

async function ensureUserExists(telegramUserId) {
  await pool.query(
    `
    insert into users (telegram_user_id)
    values ($1)
    on conflict (telegram_user_id) do nothing
    `,
    [telegramUserId]
  );
}

async function setSubscriptionFromCheckout({
  telegramUserId,
  stripeCustomerId,
  stripeSubscriptionId,
  status
}) {
  await pool.query(
    `
    update users
    set stripe_customer_id = $2
    where telegram_user_id = $1
    `,
    [telegramUserId, stripeCustomerId]
  );

  await pool.query(
    `
    insert into subscriptions (telegram_user_id, stripe_subscription_id, status, updated_at)
    values ($1, $2, $3, now())
    on conflict (telegram_user_id)
    do update set
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      updated_at = now()
    `,
    [telegramUserId, stripeSubscriptionId, status || "active"]
  );
}

async function setSubscriptionStatusBySubId(stripeSubscriptionId, status) {
  await pool.query(
    `
    update subscriptions
    set status = $2, updated_at = now()
    where stripe_subscription_id = $1
    `,
    [stripeSubscriptionId, status]
  );
}

// -------------------- STRIPE --------------------
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

async function handleStripeEvent(event) {
  switch (event.type) {
    // Main: after successful checkout (subscription mode)
    case "checkout.session.completed": {
      const session = event.data.object;

      // We set metadata.telegram_user_id when creating the session
      const telegramUserIdRaw = session?.metadata?.telegram_user_id;
      const telegramUserId = telegramUserIdRaw
        ? Number(telegramUserIdRaw)
        : null;

      const stripeCustomerId = session.customer;
      const stripeSubscriptionId = session.subscription;

      if (!telegramUserId || !stripeCustomerId || !stripeSubscriptionId) {
        console.warn("checkout.session.completed missing fields:", {
          telegramUserId,
          stripeCustomerId,
          stripeSubscriptionId
        });
        return;
      }

      await ensureUserExists(telegramUserId);
      await setSubscriptionFromCheckout({
        telegramUserId,
        stripeCustomerId,
        stripeSubscriptionId,
        status: "active"
      });

      // Optional: notify user in Telegram
      try {
        await bot.telegram.sendMessage(
          telegramUserId,
          "Подписка активирована. Нажмите /start и выберите Управление подпиской."
        );
      } catch (e) {
        console.warn("Telegram notify failed:", e?.message || e);
      }

      return;
    }

    // Keep DB status in sync (optional but recommended)
    case "customer.subscription.updated": {
      const sub = event.data.object;
      if (sub?.id && sub?.status) {
        await setSubscriptionStatusBySubId(sub.id, sub.status);
      }
      return;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      if (sub?.id) {
        await setSubscriptionStatusBySubId(sub.id, "canceled");
      }
      return;
    }

    default:
      return;
  }
}

// -------------------- TELEGRAM BOT --------------------
const bot = new Telegraf(BOT_TOKEN);

// Telegram webhook endpoint (Render will receive POSTs here from Telegram)
app.post("/telegram", (req, res) => bot.handleUpdate(req.body, res));

// UI helpers
function languageKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.callback("Русский", "lang_ru"),
    Markup.button.callback("Latviešu", "lang_lv")
  ]);
}

function mainMenu(lang) {
  if (lang === "lv") {
    return Markup.inlineKeyboard([
      [Markup.button.callback("Abonēt", "subscribe")],
      [Markup.button.callback("Pārvaldīt abonementu", "manage")],
      [Markup.button.callback("Uzzināt vairāk", "more")],
      [Markup.button.callback("Mainīt valodu", "change_lang")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("Оформить подписку", "subscribe")],
    [Markup.button.callback("Управлять подпиской", "manage")],
    [Markup.button.callback("Узнать больше", "more")],
    [Markup.button.callback("Сменить язык", "change_lang")]
  ]);
}

// /start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await ensureUserExists(userId);

  const user = await getUser(userId);
  const lang = user?.language || null;

  if (lang === "ru") {
    return ctx.reply("Добро пожаловать в Health Lab Padel - RU", mainMenu("ru"));
  }
  if (lang === "lv") {
    return ctx.reply("Laipni lūdzam Health Lab Padel - LV", mainMenu("lv"));
  }

  return ctx.reply("Выберите язык / Izvēlieties valodu", languageKeyboard());
});

// Change language
bot.action("change_lang", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply("Выберите язык / Izvēlieties valodu", languageKeyboard());
});

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

// Info
bot.action("more", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);
  const lang = user?.language || "ru";

  if (lang === "lv") {
    return ctx.reply(
      "Kanālā: uzturs padel spēlētājiem, papildinājumi, atjaunošanās, praktiski protokoli un Q&A."
    );
  }
  return ctx.reply(
    "В канале: питание для паделистов, добавки, восстановление, практические протоколы и Q&A."
  );
});

// Create Stripe Checkout Session (subscription)
bot.action("subscribe", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramUserId = ctx.from.id;

  const user = await getUser(telegramUserId);
  const lang = user?.language || "ru";

  try {
    // Customer: reuse if exists, else let Stripe create during checkout
    const customer = user?.stripe_customer_id || undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${APP_URL}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/stripe/cancel`,
      allow_promotion_codes: false,
      subscription_data: {
        metadata: {
          telegram_user_id: String(telegramUserId)
        }
      },
      metadata: {
        telegram_user_id: String(telegramUserId),
        language: lang
      }
    });

    const btnText = lang === "lv" ? "Atvērt maksājumu" : "Открыть оплату";
    return ctx.reply(
      lang === "lv"
        ? "Lūdzu, atveriet Stripe Checkout, lai aktivizētu abonementu:"
        : "Откройте Stripe Checkout, чтобы активировать подписку:",
      Markup.inlineKeyboard([Markup.button.url(btnText, session.url)])
    );
  } catch (e) {
    console.error("Checkout create error:", e);
    return ctx.reply(
      lang === "lv"
        ? "Kļūda, veidojot maksājumu. Mēģiniet vēlreiz pēc brīža."
        : "Ошибка при создании оплаты. Попробуйте еще раз через минуту."
    );
  }
});

// Customer Portal (manage subscription)
bot.action("manage", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramUserId = ctx.from.id;

  const user = await getUser(telegramUserId);
  const lang = user?.language || "ru";

  if (!user?.stripe_customer_id) {
    return ctx.reply(
      lang === "lv"
        ? "Vispirms aktivizējiet abonementu (Abonēt)."
        : "Сначала оформите подписку (Оформить подписку)."
    );
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${APP_URL}/stripe/success`
    });

    const btnText = lang === "lv" ? "Atvērt portālu" : "Открыть портал";
    return ctx.reply(
      lang === "lv"
        ? "Atveriet portālu, lai pārvaldītu abonementu (atcelt, atjaunot):"
        : "Откройте портал, чтобы управлять подпиской (отмена, возобновление):",
      Markup.inlineKeyboard([Markup.button.url(btnText, portalSession.url)])
    );
  } catch (e) {
    console.error("Portal create error:", e);
    return ctx.reply(
      lang === "lv"
        ? "Neizdevās izveidot portālu. Mēģiniet vēlreiz."
        : "Не удалось открыть портал. Попробуйте еще раз."
    );
  }
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log("Server started on", PORT));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
