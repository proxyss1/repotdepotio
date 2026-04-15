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
  SITE_URL = "http://localhost:3000",
} = process.env;

// ─────────────────────────────
// MIDDLEWARE
// ─────────────────────────────
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // IMPORTANT for localhost
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

const auth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
};

// ─────────────────────────────
// HELPERS (SUPABASE)
// ─────────────────────────────

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

// GET OR CREATE USER (SAFE)
async function getOrCreateUser(discordUser) {
  const { data: existing, error } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", discordUser.id);

  if (error) {
    console.error("Supabase select error:", error);
    return null;
  }

  let user = existing?.[0];

  // CREATE USER IF NOT EXISTS
  if (!user) {
    const newUser = {
      discord_id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null,
      plan: "free",
      generations_this_month: 0,
      month_key: monthKey(),
      blacklisted: false,
    };

    const { data, error: insertErr } = await supabase
      .from("users")
      .insert([newUser])
      .select()
      .single();

    if (insertErr) {
      console.error("Insert error:", insertErr);
      return null;
    }

    return data;
  }

  // RESET MONTH IF NEEDED
  if (user.month_key !== monthKey()) {
    const { data } = await supabase
      .from("users")
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

// UPDATE USER
async function updateUser(discordId, fields) {
  const { error } = await supabase
    .from("users")
    .update(fields)
    .eq("discord_id", discordId);

  if (error) console.error("updateUser error:", error);
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
// DISCORD CALLBACK (FIXED + DEBUG)
// ─────────────────────────────
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

    const discordUser = (
      await axios.get("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` },
      })
    ).data;

    console.log("Logged in Discord user:", discordUser);

    const user = await getOrCreateUser(discordUser);

    if (!user) {
      return res.redirect("/?error=db_fail");
    }

    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
    };

    res.redirect("/");
  } catch (e) {
    console.error("OAuth FAILED:", e.response?.data || e.message);
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
// ME API
// ─────────────────────────────
app.get("/api/me", auth, async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", req.session.user.id);

  const user = data?.[0];

  if (!user) return res.status(404).json({ error: "User not found" });

  res.json(user);
});

// ─────────────────────────────
// START SERVER
// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
