require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ─────────────────────────────
// SUPABASE
// ─────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────
// CONFIG
// ─────────────────────────────
const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  REDIRECT_URI,
  SESSION_SECRET,
  SITE_URL,
} = process.env;

// ─────────────────────────────
// TRUST PROXY (RAILWAY)
// ─────────────────────────────
app.set("trust proxy", 1);

// ─────────────────────────────
// STRIPE WEBHOOK (BEFORE JSON)
// ─────────────────────────────
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook verify failed:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const discordId = session.metadata.discord_id;

      console.log("💰 Payment success:", discordId);

      await supabase
        .from("whitelist") // ✅ FIXED
        .update({ plan: "premium" })
        .eq("discord_id", discordId);
    }

    res.json({ received: true });
  }
);

// ─────────────────────────────
// MIDDLEWARE
// ─────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// ─────────────────────────────
// AUTH
// ─────────────────────────────
const auth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
};

// ─────────────────────────────
// HELPERS
// ─────────────────────────────
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

async function getOrCreateUser(discordUser) {
  const { data: existing } = await supabase
    .from("whitelist") // ✅ FIXED
    .select("*")
    .eq("discord_id", discordUser.id);

  let user = existing?.[0];

  if (!user) {
    const { data } = await supabase
      .from("whitelist") // ✅ FIXED
      .insert([
        {
          discord_id: discordUser.id,
          username: discordUser.username,
          plan: "free",
          generations_this_month: 0,
          month_key: monthKey(),
        },
      ])
      .select()
      .single();

    return data;
  }

  if (user.month_key !== monthKey()) {
    const { data } = await supabase
      .from("whitelist") // ✅ FIXED
      .update({
        generations_this_month: 0,
        month_key: monthKey(),
      })
      .eq("discord_id", discordUser.id)
      .select()
      .single();

    return data;
  }

  return user;
}

// ─────────────────────────────
// DISCORD LOGIN
// ─────────────────────────────
app.get("/auth/discord", (req, res) => {
  const url =
    "https://discord.com/api/oauth2/authorize?" +
    new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "identify",
    });

  res.redirect(url);
});

// ─────────────────────────────
// CALLBACK (FIXED SESSION)
// ─────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) return res.redirect("/?error=no_code");

  try {
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const access_token = tokenRes.data.access_token;

    const discordUser = (
      await axios.get("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` },
      })
    ).data;

    const user = await getOrCreateUser(discordUser);

    if (!user) return res.redirect("/?error=db_fail");

    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
    };

    req.session.save((err) => {
      if (err) {
        console.error("Session save failed:", err);
        return res.redirect("/?error=session_fail");
      }

      res.redirect("/");
    });
  } catch (e) {
    console.error("OAuth error:", e.response?.data || e.message);
    res.redirect("/?error=oauth_failed");
  }
});

// ─────────────────────────────
// LOGOUT
// ─────────────────────────────
app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ─────────────────────────────
// GET USER
// ─────────────────────────────
app.get("/api/me", auth, async (req, res) => {
  const { data } = await supabase
    .from("whitelist") // ✅ FIXED
    .select("*")
    .eq("discord_id", req.session.user.id);

  res.json(data?.[0]);
});

// ─────────────────────────────
// STRIPE CHECKOUT
// ─────────────────────────────
app.post("/api/create-checkout", auth, async (req, res) => {
  try {
    const { plan } = req.body;

    const priceId =
      plan === "enterprise"
        ? process.env.STRIPE_PRICE_ENTERPRISE
        : process.env.STRIPE_PRICE_BASIC;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SITE_URL}/success`,
      cancel_url: `${SITE_URL}/cancel`,
      metadata: {
        discord_id: req.session.user.id,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Stripe failed" });
  }
});

// ─────────────────────────────
// START
// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Running on ${SITE_URL}`);
});
