require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// ── CONFIG ───────────────────────────────────────────────
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me";
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

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

// ── USER DB (JSON) ───────────────────────────────────────
const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function safeUpdateUser(id, fields) {
  const users = loadUsers();
  users[id] = { ...(users[id] || {}), ...fields };
  saveUsers(users);
}

function getUser(id) {
  const users = loadUsers();

  if (!users[id]) {
    users[id] = {
      discordId: id,
      username: "",
      avatar: "",
      plan: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      generationsThisMonth: 0,
      monthKey: "",
      createdAt: new Date().toISOString(),
    };
  }

  const u = users[id];

  const mk = `${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
  if (u.monthKey !== mk) {
    u.monthKey = mk;
    u.generationsThisMonth = 0;
  }

  users[id] = u;
  saveUsers(users);
  return u;
}

function getUserByStripe(customerId) {
  const users = loadUsers();
  return Object.values(users).find(
    (u) => u.stripeCustomerId === customerId
  );
}

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
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

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

    const u = (
      await axios.get("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.data.access_token}` },
      })
    ).data;

    const tag =
      u.discriminator === "0" ? u.username : `${u.username}#${u.discriminator}`;

    const avatar = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    getUser(u.id);
    safeUpdateUser(u.id, { username: tag, avatar });

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
app.get("/api/me", auth, (req, res) => {
  const u = getUser(req.session.user.id);
  const p = PLANS[u.plan] || PLANS.free;

  const limit = p.limit === Infinity ? null : p.limit;
  const left =
    limit === null
      ? null
      : Math.max(0, limit - u.generationsThisMonth);

  res.json({
    id: u.discordId,
    username: u.username,
    avatar: u.avatar,
    plan: u.plan,
    generationsThisMonth: u.generationsThisMonth,
    generationsLeft: left,
    limit,
  });
});

// ── STRIPE CHECKOUT ─────────────────────────────────────
app.post("/api/subscribe", auth, async (req, res) => {
  const { plan } = req.body;
  if (!PRICE_IDS[plan])
    return res.status(400).json({ error: "Invalid plan" });

  const u = getUser(req.session.user.id);

  let cid = u.stripeCustomerId;

  if (!cid) {
    const c = await stripe.customers.create({
      name: u.username,
      metadata: { discordId: u.discordId },
    });

    cid = c.id;
    safeUpdateUser(u.discordId, { stripeCustomerId: cid });
  }

  const session = await stripe.checkout.sessions.create({
    customer: cid,
    payment_method_types: ["card"],
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    mode: "subscription",
    success_url: `${SITE_URL}/?subscribed=1`,
    cancel_url: `${SITE_URL}/?cancelled=1`,
  });

  res.json({ url: session.url });
});

// ── STRIPE WEBHOOK (FIXED) ──────────────────────────────
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
    console.log("🔥 Stripe event:", event.type);

    // ── PRIMARY: PAYMENT SUCCESS ─────────────────────────
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      const user = getUserByStripe(invoice.customer);
      if (!user) return res.json({ received: true });

      const sub = await stripe.subscriptions.retrieve(
        invoice.subscription
      );

      const priceId = sub.items.data[0].price.id;

      let plan = "free";
      if (priceId === process.env.STRIPE_PRICE_BASIC) plan = "basic";
      if (priceId === process.env.STRIPE_PRICE_ENTERPRISE)
        plan = "enterprise";

      safeUpdateUser(user.discordId, {
        plan,
        stripeSubscriptionId: invoice.subscription,
      });

      console.log(`💰 Updated ${user.discordId} → ${plan}`);
    }

    // ── CANCELLED ────────────────────────────────────────
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;

      const user = getUserByStripe(sub.customer);
      if (user) {
        safeUpdateUser(user.discordId, {
          plan: "free",
          stripeSubscriptionId: null,
        });

        console.log(`⚠️ Downgraded ${user.discordId}`);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).send("Webhook failed");
  }
});

// ── GENERATE ─────────────────────────────────────────────
app.post("/api/generate", auth, async (req, res) => {
  const { appId } = req.body;

  if (!appId || isNaN(parseInt(appId)))
    return res.status(400).json({ error: "Invalid App ID" });

  const u = getUser(req.session.user.id);
  const p = PLANS[u.plan] || PLANS.free;

  if (p.limit !== Infinity && u.generationsThisMonth >= p.limit) {
    return res.status(429).json({ error: "Monthly generation limit reached" });
  }

  const id = parseInt(appId);
  let name = `App ${id}`;

  // Fetch game name from Steam
  try {
    const r = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`
    );
    if (r.data[id]?.data?.name) name = r.data[id].data.name;
  } catch {
    // Non-fatal: fall back to generic name
  }

  // Fetch depot keys from remote source
  let depotKeys;
  try {
    const keysRes = await axios.get(KEYS_URL);
    depotKeys = keysRes.data;
  } catch {
    return res.status(502).json({ error: "Failed to fetch key pool" });
  }

  // Look up the depot key by ID string
  const key = depotKeys[String(id)];

  if (!key) {
    return res.status(404).json({ error: `No depot key found for App ID ${id}` });
  }

  // Enforce plan delay
  if (p.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, p.delayMs));
  }

  // Increment usage only after all checks pass
  safeUpdateUser(u.discordId, {
    generationsThisMonth: u.generationsThisMonth + 1,
  });

  res.json({
    success: true,
    name,
    appId: id,
    depotKey: key,
  });
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);
