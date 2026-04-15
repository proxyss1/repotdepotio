require("dotenv").config();
const express = require("express");
const expressSession = require("express-session");
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
// STRIPE WEBHOOK (MUST BE BEFORE JSON MIDDLEWARE)
// ─────────────────────────────
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let stripeEvent;

    try {
      stripeEvent = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook verify failed:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (stripeEvent.type === "checkout.session.completed") {
      const checkoutSession = stripeEvent.data.object;
      const discordId = checkoutSession.metadata?.discord_id;

      if (!discordId) {
        console.error("No discord_id in metadata");
        return res.status(400).send("Missing discord_id");
      }

      console.log("💰 Payment success for discord_id:", discordId);

      const { error } = await supabase
        .from("whitelist")
        .update({ plan: "premium" })
        .eq("discord_id", discordId);

      if (error) {
        console.error("Supabase update failed:", error.message);
        return res.status(500).send("DB Error");
      }
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
  expressSession({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // only force secure in prod
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
    },
  })
);

// ─────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────
const requireAuth = (req, res, next) => {
  if (!req.session?.user) {
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
  const currentMonthKey = monthKey();

  // Fetch existing user — use maybeSingle() to safely handle "not found"
  const { data: existing, error: fetchError } = await supabase
    .from("whitelist")
    .select("*")
    .eq("discord_id", discordUser.id)
    .maybeSingle();

  if (fetchError) {
    console.error("Supabase fetch error:", fetchError.message);
    return null;
  }

  // New user — insert
  if (!existing) {
    const { data: inserted, error: insertError } = await supabase
      .from("whitelist")
      .insert([
        {
          discord_id: discordUser.id,
          username: discordUser.username,
          plan: "free",
          generations_this_month: 0,
          month_key: currentMonthKey,
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error("Supabase insert error:", insertError.message);
      return null;
    }

    return inserted;
  }

  // Existing user — reset generation count if it's a new month
  if (existing.month_key !== currentMonthKey) {
    const { data: updated, error: updateError } = await supabase
      .from("whitelist")
      .update({
        generations_this_month: 0,
        month_key: currentMonthKey,
      })
      .eq("discord_id", discordUser.id)
      .select()
      .single();

    if (updateError) {
      console.error("Supabase update error:", updateError.message);
      return null;
    }

    return updated;
  }

  return existing;
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
// DISCORD CALLBACK
// ─────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) return res.redirect("/?error=no_code");

  try {
    // Exchange code for access token
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

    if (!access_token) {
      console.error("No access token returned from Discord");
      return res.redirect("/?error=no_token");
    }

    // Fetch Discord user info
    const discordUserRes = await axios.get(
      "https://discord.com/api/users/@me",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    const discordUser = discordUserRes.data;

    if (!discordUser?.id) {
      console.error("Invalid Discord user response");
      return res.redirect("/?error=bad_discord_user");
    }

    // Upsert user in DB
    const user = await getOrCreateUser(discordUser);

    if (!user) return res.redirect("/?error=db_fail");

    // Save session
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
// GET CURRENT USER
// ─────────────────────────────
app.get("/api/me", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("whitelist")
    .select("*")
    .eq("discord_id", req.session.user.id)
    .maybeSingle();

  if (error) {
    console.error("Supabase /api/me error:", error.message);
    return res.status(500).json({ error: "DB error" });
  }

  if (!data) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json(data);
});

// ─────────────────────────────
// STRIPE CHECKOUT
// ─────────────────────────────
app.post("/api/create-checkout", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan) {
      return res.status(400).json({ error: "Missing plan" });
    }

    const priceId =
      plan === "enterprise"
        ? process.env.STRIPE_PRICE_ENTERPRISE
        : process.env.STRIPE_PRICE_BASIC;

    if (!priceId) {
      console.error("Missing price ID for plan:", plan);
      return res.status(500).json({ error: "Invalid plan config" });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SITE_URL}/success`,
      cancel_url: `${SITE_URL}/cancel`,
      metadata: {
        discord_id: req.session.user.id,
      },
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: "Stripe failed" });
  }
});

// ─────────────────────────────
// START
// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Running on port ${PORT} — ${SITE_URL}`);
});
