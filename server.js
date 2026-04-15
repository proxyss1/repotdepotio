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

const KEYS_URL = "https://raw.githubusercontent.com/proxyss1/HomeDepot/refs/heads/main/depotkeys.json";

const PRICE_IDS = {
  basic:      process.env.STRIPE_PRICE_BASIC,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

const PLANS = {
  free:       { limit: 5,        delayMs: 15000 },
  basic:      { limit: 20,       delayMs: 8000  },
  enterprise: { limit: Infinity, delayMs: 0     },
};

// ── USER HELPERS (Supabase) ──────────────────────────────
async function getUser(discordId) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", discordId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("getUser error:", error);
    return null;
  }

  // New user — insert defaults
  if (!data) {
    const mk = getCurrentMonthKey();
    const newUser = {
      discord_id: discordId,
      username: "",
      avatar: "",
      plan: "free",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      generations_this_month: 0,
      month_key: mk,
      blacklisted: false,
    };
    const { data: inserted } = await supabase
      .from("users")
      .insert(newUser)
      .select()
      .single();
    return inserted;
  }

  // Reset monthly counter if new month
  const mk = getCurrentMonthKey();
  if (data.month_key !== mk) {
    const { data: updated } = await supabase
      .from("users")
      .update({ generations_this_month: 0, month_key: mk })
      .eq("discord_id", discordId)
      .select()
      .single();
    return updated;
  }

  return data;
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
    .eq("stripe_customer_id", customerId)
    .single();
  return data || null;
}

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

// ── MIDDLEWARE ───────────────────────────────────────────
app.set("trust proxy", 1);
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: "none", maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

const auth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: "Not logged in" });

// ── DISCORD LOGIN ────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
  res.redirect(
    "https://discord.com/api/oauth2/authorize?" +
    new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "identify",
    })
  );
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");

  try {
    const token = await axios.post(
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

    const u = (await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.data.access_token}` },
    })).data;

    const tag    = u.discriminator === "0" ? u.username : `${u.username}#${u.discriminator}`;
    const avatar = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    await getUser(u.id); // ensure row exists
    await updateUser(u.id, { username: tag, avatar });

    req.session.user = { id: u.id, username: tag, avatar };
    res.redirect("/");
  } catch (e) {
    console.error(e.message);
    res.redirect("/?error=oauth_failed");
  }
});

app.get("/auth/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/"))
);

// ── API ME ───────────────────────────────────────────────
app.get("/api/me", auth, async (req, res) => {
  const u = await getUser(req.session.user.id);
  if (!u) return res.status(500).json({ error: "User not found" });

  const p     = PLANS[u.plan] || PLANS.free;
  const limit = p.limit === Infinity ? null : p.limit;
  const left  = limit === null ? null : Math.max(0, limit - u.generations_this_month);

  res.json({
    id:                   u.discord_id,
    username:             u.username,
    avatar:               u.avatar,
    plan:                 u.plan,
    blacklisted:          u.blacklisted,
    generationsThisMonth: u.generations_this_month,
    generationsLeft:      left,
    limit,
  });
});

// ── STRIPE CHECKOUT ──────────────────────────────────────
app.post("/api/subscribe", auth, async (req, res) => {
  const { plan } = req.body;
  if (!PRICE_IDS[plan]) return res.status(400).json({ error: "Invalid plan" });

  const u = await getUser(req.session.user.id);
  if (!u) return res.status(500).json({ error: "User not found" });

  let cid = u.stripe_customer_id;
  if (!cid) {
    const c = await stripe.customers.create({
      name: u.username,
      metadata: { discordId: u.discord_id },
    });
    cid = c.id;
    await updateUser(u.discord_id, { stripe_customer_id: cid });
  }

  const session = await stripe.checkout.sessions.create({
    customer: cid,
    payment_method_types: ["card"],
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    mode: "subscription",
    success_url: `${SITE_URL}/?subscribed=1`,
    cancel_url:  `${SITE_URL}/?cancelled=1`,
  });

  res.json({ url: session.url });
});

// ── STRIPE PORTAL ────────────────────────────────────────
app.post("/api/portal", auth, async (req, res) => {
  const u = await getUser(req.session.user.id);
  if (!u?.stripe_customer_id)
    return res.status(400).json({ error: "No billing account found" });

  const session = await stripe.billingPortal.sessions.create({
    customer:   u.stripe_customer_id,
    return_url: SITE_URL,
  });

  res.json({ url: session.url });
});

// ── STRIPE WEBHOOK ───────────────────────────────────────
app.post("/stripe/webhook", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const user    = await getUserByStripeCustomer(invoice.customer);
      if (!user) return res.json({ received: true });

      const sub    = await stripe.subscriptions.retrieve(invoice.subscription);
      const priceId = sub.items.data[0].price.id;

      let plan = "free";
      if (priceId === process.env.STRIPE_PRICE_BASIC)      plan = "basic";
      if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) plan = "enterprise";

      await updateUser(user.discord_id, {
        plan,
        stripe_subscription_id: invoice.subscription,
      });
      console.log(`💰 ${user.discord_id} → ${plan}`);
    }

    if (event.type === "customer.subscription.deleted") {
      const sub  = event.data.object;
      const user = await getUserByStripeCustomer(sub.customer);
      if (user) {
        await updateUser(user.discord_id, {
          plan: "free",
          stripe_subscription_id: null,
        });
        console.log(`⚠️ Downgraded ${user.discord_id}`);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).send("Webhook failed");
  }
});

// ── ADMIN: BLACKLIST ─────────────────────────────────────
// POST /api/admin/blacklist  { discordId, blacklisted: true/false }
// Protect this with a secret header in production
app.post("/api/admin/blacklist", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });

  const { discordId, blacklisted } = req.body;
  if (!discordId) return res.status(400).json({ error: "Missing discordId" });

  await updateUser(discordId, { blacklisted: !!blacklisted });
  res.json({ ok: true, discordId, blacklisted: !!blacklisted });
});

// ── GENERATE ─────────────────────────────────────────────
app.post("/api/generate", auth, async (req, res) => {
  const { appId } = req.body;
  if (!appId || !/^\d+$/.test(String(appId)))
    return res.status(400).json({ error: "Invalid App ID" });

  const u = await getUser(req.session.user.id);
  if (!u) return res.status(500).json({ error: "User not found" });

  // Blacklist check
  if (u.blacklisted)
    return res.status(403).json({ error: "Your account has been suspended." });

  const p     = PLANS[u.plan] || PLANS.free;
  const limit = p.limit;

  if (limit !== Infinity && u.generations_this_month >= limit)
    return res.status(429).json({ error: "Monthly limit reached", upgrade: true });

  const id  = parseInt(appId);
  const log = [];

  // 1. App name lookup
  let name = `App ${id}`;
  try {
    const r = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`
    );
    if (r.data[id]?.data?.name) name = r.data[id].data.name;
    log.push({ text: `app resolved: ${name}`, type: "ok" });
  } catch {
    log.push({ text: `app lookup failed, using App ${id}`, type: "" });
  }

  // 2. Fetch depot keys
  let depotKeys;
  try {
    const kr = await axios.get(KEYS_URL);
    depotKeys = kr.data;
    log.push({ text: `loaded ${Object.keys(depotKeys).length} depot keys`, type: "ok" });
  } catch {
    return res.status(502).json({ error: "Failed to fetch depot key database", log });
  }

  // 3. Fetch depot list from Steam
  let depots = {};
  try {
    const sr = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${id}&filters=depots`
    );
    const raw = sr.data[id]?.data?.depots || {};
    // Filter: only numeric depot IDs that have a Windows config
    for (const [depotId, info] of Object.entries(raw)) {
      if (!/^\d+$/.test(depotId)) continue;
      const configs = info?.config?.oslist;
      // include if no oslist restriction (shared) or explicitly Windows
      if (!configs || configs.includes("windows")) {
        depots[depotId] = info;
      }
    }
    log.push({ text: `found ${Object.keys(depots).length} Windows depot(s)`, type: "ok" });
  } catch {
    log.push({ text: "depot list lookup failed", type: "" });
  }

  // 4. Match keys to depots
  const matched = [];
  for (const depotId of Object.keys(depots)) {
    const key = depotKeys[depotId];
    if (key) matched.push({ depotId, key });
  }

  // Fallback: if Steam depot API gave nothing, try the key DB directly
  if (matched.length === 0) {
    const directKey = depotKeys[String(id)];
    if (directKey) {
      matched.push({ depotId: String(id), key: directKey });
      log.push({ text: `direct depot key found for ${id}`, type: "ok" });
    }
  }

  if (matched.length === 0) {
    log.push({ text: "no depot keys matched", type: "" });
    return res.status(404).json({
      error: `No depot keys found for App ID ${id}. The game may not be in the key database.`,
      log,
    });
  }

  log.push({ text: `matched ${matched.length} depot key(s)`, type: "ok" });

  // 5. Enforce plan delay
  if (p.delayMs > 0) {
    await new Promise(r => setTimeout(r, p.delayMs));
  }

  // 6. Build the Lua file
  const lua = buildLua(id, name, matched);
  const filename = `${name.replace(/[^a-zA-Z0-9_\-]/g, "_")}_${id}.lua`;

  log.push({ text: `lua generated: ${filename}`, type: "ok" });

  // 7. Increment usage counter
  await updateUser(u.discord_id, {
    generations_this_month: u.generations_this_month + 1,
  });

  const newLeft = limit === Infinity
    ? null
    : Math.max(0, limit - (u.generations_this_month + 1));

  res.json({
    success: true,
    name,
    depotCount: matched.length,
    filename,
    lua,
    log,
    generationsLeft: newLeft,
  });
});

// ── LUA BUILDER ──────────────────────────────────────────
function buildLua(appId, appName, depots) {
  const lines = [
    `-- ${appName} (${appId})`,
    `-- Generated by FCV Manifest Generator`,
    `-- https://steamtools.net`,
    ``,
    `addappid(${appId}, 1)`,
    ``,
  ];

  for (const { depotId, key } of depots) {
    lines.push(`addappid(${depotId}, 1, "${key}")`);
  }

  return lines.join("\n");
}

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
