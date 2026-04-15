require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// ── SUPABASE ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CONFIG ───────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI          = process.env.REDIRECT_URI;
const SESSION_SECRET        = process.env.SESSION_SECRET || "change_me";
const SITE_URL              = process.env.SITE_URL || "http://localhost:3000";

const KEYS_URL =
  "https://raw.githubusercontent.com/proxyss1/HomeDepot/refs/heads/main/depotkeys.json";

const PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

const PLANS = {
  free: { limit: 5, delayMs: 15000 },
  basic: { limit: 20, delayMs: 8000 },
  enterprise: { limit: Infinity, delayMs: 0 },
};

// ── MIDDLEWARE ───────────────────────────────────────────
app.set("trust proxy", 1);

app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // FIXED
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// ── AUTH MIDDLEWARE ──────────────────────────────────────
const auth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: "Not logged in" });

// ── HELPERS ──────────────────────────────────────────────
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

// safer Supabase user fetch (FIXED)
async function getUser(discordId) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", discordId);

  if (error) {
    console.error("getUser error:", error);
    return null;
  }

  const user = data?.[0];

  // create user if missing
  if (!user) {
    const newUser = {
      discord_id: discordId,
      username: "",
      avatar: "",
      plan: "free",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      generations_this_month: 0,
      month_key: getCurrentMonthKey(),
      blacklisted: false,
    };

    const { data: inserted, error: insertErr } = await supabase
      .from("users")
      .insert(newUser)
      .select()
      .single();

    if (insertErr) {
      console.error("Insert user error:", insertErr);
      return null;
    }

    return inserted;
  }

  // reset month
  const mk = getCurrentMonthKey();
  if (user.month_key !== mk) {
    const { data: updated } = await supabase
      .from("users")
      .update({
        generations_this_month: 0,
        month_key: mk,
      })
      .eq("discord_id", discordId)
      .select()
      .single();

    return updated;
  }

  return user;
}

async function updateUser(discordId, fields) {
  const { error } = await supabase
    .from("users")
    .update(fields)
    .eq("discord_id", discordId);

  if (error) console.error("updateUser error:", error);
}

async function getUserByStripeCustomer(customerId) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("stripe_customer_id", customerId);

  return data?.[0] || null;
}

// ── DISCORD LOGIN ────────────────────────────────────────
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

// ── CALLBACK (FIXED + DEBUGGING) ─────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) return res.redirect("/?error=no_code");

  try {
    // exchange code
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

    // get user
    const u = (
      await axios.get("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` },
      })
    ).data;

    const tag =
      u.discriminator === "0"
        ? u.username
        : `${u.username}#${u.discriminator}`;

    const avatar = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    await getUser(u.id);
    await updateUser(u.id, { username: tag, avatar });

    req.session.user = { id: u.id, username: tag, avatar };

    res.redirect("/");
  } catch (e) {
    console.error("OAuth error:", e.response?.data || e.message);
    res.redirect("/?error=oauth_failed");
  }
});

// ── LOGOUT ───────────────────────────────────────────────
app.get("/auth/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/"))
);

// ── ME ───────────────────────────────────────────────────
app.get("/api/me", auth, async (req, res) => {
  const u = await getUser(req.session.user.id);

  if (!u) return res.status(500).json({ error: "User not found" });

  const p = PLANS[u.plan] || PLANS.free;
  const limit = p.limit === Infinity ? null : p.limit;

  const left =
    limit === null
      ? null
      : Math.max(0, limit - u.generations_this_month);

  res.json({
    id: u.discord_id,
    username: u.username,
    avatar: u.avatar,
    plan: u.plan,
    blacklisted: u.blacklisted,
    generationsThisMonth: u.generations_this_month,
    generationsLeft: left,
    limit,
  });
});

// ── START SERVER ─────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
