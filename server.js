require("dotenv").config();
const express  = require("express");
const session  = require("express-session");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const Stripe   = require("stripe");

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT   = process.env.PORT || 3000;

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI          = process.env.REDIRECT_URI;
const SESSION_SECRET        = process.env.SESSION_SECRET || "change_me";
const SITE_URL              = process.env.SITE_URL || "http://localhost:3000";
const KEYS_URL              = "https://raw.githubusercontent.com/proxyss1/HomeDepot/refs/heads/main/depotkeys.json";

const PRICE_IDS = {
  basic:      process.env.STRIPE_PRICE_BASIC,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

const PLANS = {
  free:       { limit: 5,        delayMs: 15000 },
  basic:      { limit: 20,       delayMs: 8000  },
  enterprise: { limit: Infinity, delayMs: 0     },
};

// ── User store ─────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(d) { fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)); }

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function getUser(id) {
  const all = loadUsers();
  if (!all[id]) {
    all[id] = { discordId:id, username:"", avatar:"", plan:"free",
      stripeCustomerId:null, stripeSubscriptionId:null,
      generationsThisMonth:0, monthKey:monthKey(), createdAt:new Date().toISOString() };
    saveUsers(all);
  }
  const u = loadUsers()[id];
  if (u.monthKey !== monthKey()) {
    u.generationsThisMonth = 0;
    u.monthKey = monthKey();
    const a = loadUsers(); a[id]=u; saveUsers(a);
  }
  return loadUsers()[id];
}

if (event.type === "checkout.session.completed") {
  const s = event.data.object;

  const customerId = s.customer;

  const user = getUserByStripe(customerId);
  if (!user) return;

  // Get subscription details properly
  const subscription = await stripe.subscriptions.retrieve(s.subscription);

  const priceId = subscription.items.data[0].price.id;

  let plan = "free";
  if (priceId === process.env.STRIPE_PRICE_BASIC) plan = "basic";
  if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) plan = "enterprise";

  updateUser(user.discordId, {
    plan,
    stripeSubscriptionId: s.subscription
  });

  console.log(`✅ User upgraded to ${plan}`);
}

function getUserByStripe(customerId) {
  return Object.values(loadUsers()).find(u => u.stripeCustomerId === customerId) || null;
}
app.set("trust proxy", 1);
// ── Middleware ─────────────────────────────────────────────────────────────
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,          // always true in production
    sameSite: "none",      // required for OAuth redirects
    maxAge: 7 * 24 * 60 * 60 * 1000
  },
}));

const auth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error:"Not logged in" });

// ── Discord OAuth ──────────────────────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
  res.redirect(`https://discord.com/api/oauth2/authorize?${new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: "code", scope: "identify",
  })}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");
  try {
    const tok = await axios.post("https://discord.com/api/oauth2/token",
      new URLSearchParams({ client_id:DISCORD_CLIENT_ID, client_secret:DISCORD_CLIENT_SECRET,
        grant_type:"authorization_code", code, redirect_uri:REDIRECT_URI, scope:"identify" }),
      { headers:{ "Content-Type":"application/x-www-form-urlencoded" } });
    const u = (await axios.get("https://discord.com/api/users/@me",
      { headers:{ Authorization:`Bearer ${tok.data.access_token}` } })).data;
    const tag = u.discriminator==="0" ? u.username : `${u.username}#${u.discriminator}`;
    const av  = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
                         : `https://cdn.discordapp.com/embed/avatars/0.png`;
    getUser(u.id);
    updateUser(u.id, { username:tag, avatar:av });
    req.session.user = { id:u.id, username:tag, avatar:av };
    res.redirect("/");
  } catch(e) {
    console.error("OAuth error:", e.response?.data || e.message);
    res.redirect("/?error=oauth_failed");
  }
});

app.get("/auth/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// ── API: me ────────────────────────────────────────────────────────────────
app.get("/api/me", auth, (req, res) => {
  const u = getUser(req.session.user.id);
  const p = PLANS[u.plan] || PLANS.free;
  const limit = p.limit === Infinity ? null : p.limit;
  const left  = limit === null ? null : Math.max(0, limit - u.generationsThisMonth);
  res.json({ id:u.discordId, username:u.username, avatar:u.avatar,
    plan:u.plan, generationsThisMonth:u.generationsThisMonth, generationsLeft:left, limit });
});

// ── Stripe: checkout ───────────────────────────────────────────────────────
app.post("/api/subscribe", auth, async (req, res) => {
  const { plan } = req.body;
  if (!PRICE_IDS[plan]) return res.status(400).json({ error:"Invalid plan" });
  const u = getUser(req.session.user.id);
  let cid = u.stripeCustomerId;
  if (!cid) {
    const c = await stripe.customers.create({ name:u.username, metadata:{ discordId:u.discordId } });
    cid = c.id;
    updateUser(u.discordId, { stripeCustomerId:cid });
  }
  const sess = await stripe.checkout.sessions.create({
    customer: cid,
    payment_method_types: ["card"],
    line_items: [{ price:PRICE_IDS[plan], quantity:1 }],
    mode: "subscription",
    success_url: `${SITE_URL}/?subscribed=1`,
    cancel_url:  `${SITE_URL}/?cancelled=1`,
    metadata: { discordId:u.discordId, plan },
  });
  res.json({ url:sess.url });
});

// ── Stripe: billing portal ─────────────────────────────────────────────────
app.post("/api/portal", auth, async (req, res) => {
  const u = getUser(req.session.user.id);
  if (!u.stripeCustomerId) return res.status(400).json({ error:"No subscription" });
  const s = await stripe.billingPortal.sessions.create({
    customer: u.stripeCustomerId, return_url: SITE_URL });
  res.json({ url:s.url });
});

// ── Stripe: webhook ────────────────────────────────────────────────────────
app.post("/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    // handle events...

    res.json({ received: true });
  }
);

// AFTER webhook:
app.use(express.json());

// ── API: generate ──────────────────────────────────────────────────────────
app.post("/api/generate", auth, async (req, res) => {
  const { appId } = req.body;
  if (!appId || isNaN(parseInt(appId))) return res.status(400).json({ error:"Invalid App ID" });

  const u = getUser(req.session.user.id);
  const p = PLANS[u.plan] || PLANS.free;

  if (p.limit !== Infinity && u.generationsThisMonth >= p.limit) {
    return res.status(429).json({
      error: `Monthly limit of ${p.limit} reached for your ${u.plan} plan.`,
      upgrade: true,
    });
  }

  const id  = parseInt(appId);
  const log = [];

  // Speed throttle per plan
  if (p.delayMs > 0) {
    await sleep(p.delayMs + Math.random() * 5000);
  }

  try {
    let name = `App ${id}`;
    try {
      const r = await axios.get(
        `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`, { timeout:8000 });
      if (r.data[id]?.data?.name) name = r.data[id].data.name;
    } catch {}
    log.push({ text:`Resolved: ${name}`, type:"ok" });

    const depots = await fetchDepots(id);
    log.push({ text:`${depots.length} depot(s): ${depots.join(", ")}`, type:"ok" });

    const keys = await fetchKeys();
    const matched = depots.filter(d=>keys[d]).map(d=>({ id:d, key:keys[d] }));
    const skipped = depots.filter(d=>!keys[d]);
    matched.forEach(d=>log.push({ text:`Key matched: depot ${d.id}`, type:"ok" }));
    skipped.forEach(d=>log.push({ text:`No key: depot ${d}`, type:"dim" }));

    if (!matched.length) return res.status(404).json({ error:"No decryption keys found.", log });

    const lua = [
      `-- ${name} (AppID: ${id})`,
      `-- FCV Manifest Generator  ${new Date().toISOString().split("T")[0]}`,
      ``, `addappid(${id})`, ``, `-- Depots`,
      ...matched.map(d=>`addappid(${d.id}, 1, "${d.key}")`),
    ].join("\n");

    updateUser(req.session.user.id, { generationsThisMonth: u.generationsThisMonth + 1 });
    const newU = getUser(req.session.user.id);
    const left = p.limit === Infinity ? null : Math.max(0, p.limit - newU.generationsThisMonth);
    log.push({ text:`Done — ${matched.length} depot(s) keyed`, type:"ok" });

    res.json({ success:true, name, appId:id, depotCount:matched.length,
      lua, filename:`${id}_manifest.lua`, generationsLeft:left, log });

  } catch(e) {
    console.error("Generate error:", e.message);
    res.status(500).json({ error:"Generation failed.", log });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDepots(appId) {
  try {
    const r = await axios.get(`https://api.steamcmd.net/v1/info/${appId}`, { timeout:12000 });
    const d = r.data?.data?.[String(appId)]?.depots;
    if (d) {
      const ids = [];
      for (const [id, info] of Object.entries(d)) {
        if (isNaN(parseInt(id))) continue;
        if (info.sharedinstall==="1"||info.sharedinstall===1) continue;
        const os = info?.config?.oslist ?? "";
        if (os===""||os.includes("windows")) ids.push(id);
      }
      if (ids.length) return ids;
    }
  } catch {}
  return [String(appId+1)];
}

let keyCache = null;
async function fetchKeys() {
  if (keyCache) return keyCache;
  keyCache = (await axios.get(KEYS_URL, { timeout:15000 })).data;
  return keyCache;
}

app.listen(PORT, () => console.log(`✅ FCV running on port ${PORT}`));
