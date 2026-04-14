require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ─────────────────────────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI          = process.env.REDIRECT_URI; // e.g. https://yourapp.railway.app/auth/callback
const SESSION_SECRET        = process.env.SESSION_SECRET || "change_this_secret";
const KEYS_URL              = "https://raw.githubusercontent.com/proxyss1/HomeDepot/refs/heads/main/depotkeys.json";
const FREE_LIMIT            = 10;
const USERS_FILE            = path.join(__dirname, "users.json");

// ── User store (JSON) ──────────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function getUser(discordId) {
  const users = loadUsers();
  if (!users[discordId]) {
    users[discordId] = {
      discordId,
      username: "",
      avatar: "",
      plan: "free",
      generationsThisMonth: 0,
      monthKey: currentMonthKey(),
      createdAt: new Date().toISOString(),
    };
    saveUsers(users);
  }
  // Reset if new month
  const users2 = loadUsers();
  if (users2[discordId].monthKey !== currentMonthKey()) {
    users2[discordId].generationsThisMonth = 0;
    users2[discordId].monthKey = currentMonthKey();
    saveUsers(users2);
  }
  return loadUsers()[discordId];
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function incrementGeneration(discordId) {
  const users = loadUsers();
  users[discordId].generationsThisMonth += 1;
  saveUsers(users);
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  next();
}

// ── Discord OAuth ──────────────────────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

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
        scope: "identify",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token } = tokenRes.data;

    // Fetch Discord user
    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const { id, username, discriminator, avatar } = userRes.data;
    const discordTag = discriminator === "0" ? username : `${username}#${discriminator}`;
    const avatarUrl = avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    // Create/update user record
    const user = getUser(id);
    const users = loadUsers();
    users[id].username = discordTag;
    users[id].avatar = avatarUrl;
    saveUsers(users);

    req.session.user = { id, username: discordTag, avatar: avatarUrl };
    res.redirect("/?logged_in=1");

  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.redirect("/?error=oauth_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ── API: current user ──────────────────────────────────────────────────────
app.get("/api/me", requireAuth, (req, res) => {
  const user = getUser(req.session.user.id);
  res.json({
    id: user.discordId,
    username: user.username,
    avatar: user.avatar,
    plan: user.plan,
    generationsThisMonth: user.generationsThisMonth,
    generationsLeft: Math.max(0, FREE_LIMIT - user.generationsThisMonth),
    limit: FREE_LIMIT,
  });
});

// ── API: generate manifest ─────────────────────────────────────────────────
app.post("/api/generate", requireAuth, async (req, res) => {
  const { appId } = req.body;
  if (!appId || isNaN(parseInt(appId))) {
    return res.status(400).json({ error: "Invalid App ID" });
  }

  const user = getUser(req.session.user.id);

  // Check generation limit
  if (user.generationsThisMonth >= FREE_LIMIT) {
    return res.status(429).json({
      error: `Monthly limit reached. You've used all ${FREE_LIMIT} free generations this month. Upgrade to Basic for more.`,
    });
  }

  const id = parseInt(appId);
  const log = [];

  try {
    // App name
    let name = `App ${id}`;
    try {
      const r = await axios.get(
        `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`,
        { timeout: 8000 }
      );
      if (r.data[id]?.data?.name) name = r.data[id].data.name;
    } catch {}
    log.push({ text: `Resolved: ${name}`, type: "ok" });

    // Depots
    const depots = await fetchDepots(id);
    log.push({ text: `${depots.length} depot(s) found: ${depots.join(", ")}`, type: "ok" });

    // Keys
    const keys = await fetchKeys();
    const matched = depots.filter(d => keys[d]).map(d => ({ id: d, key: keys[d] }));
    const skipped = depots.filter(d => !keys[d]);

    matched.forEach(d => log.push({ text: `Key matched: depot ${d.id}`, type: "ok" }));
    skipped.forEach(d => log.push({ text: `No key: depot ${d} — skipped`, type: "dim" }));

    if (matched.length === 0) {
      return res.status(404).json({ error: "No decryption keys found for this game.", log });
    }

    // Build lua
    const date = new Date().toISOString().split("T")[0];
    const lua = [
      `-- ${name} (AppID: ${id})`,
      `-- FCV Manifest Generator  ${date}`,
      ``,
      `addappid(${id})`,
      ``,
      `-- Depots`,
      ...matched.map(d => `addappid(${d.id}, 1, "${d.key}")`),
    ].join("\n");

    // Increment counter
    incrementGeneration(req.session.user.id);
    const updated = getUser(req.session.user.id);

    log.push({ text: `Manifest built — ${matched.length} depot(s) keyed`, type: "ok" });

    res.json({
      success: true,
      name,
      appId: id,
      depotCount: matched.length,
      lua,
      filename: `${id}_manifest.lua`,
      generationsLeft: Math.max(0, FREE_LIMIT - updated.generationsThisMonth),
      log,
    });

  } catch (err) {
    console.error("Generate error:", err.message);
    res.status(500).json({ error: "Generation failed. Try again.", log });
  }
});

// ── Steam helpers ──────────────────────────────────────────────────────────
async function fetchDepots(appId) {
  try {
    const r = await axios.get(`https://api.steamcmd.net/v1/info/${appId}`, { timeout: 12000 });
    const depots = r.data?.data?.[String(appId)]?.depots;
    if (depots) {
      const ids = [];
      for (const [id, info] of Object.entries(depots)) {
        if (isNaN(parseInt(id))) continue;
        if (info.sharedinstall === "1" || info.sharedinstall === 1) continue;
        const os = info?.config?.oslist ?? "";
        if (os === "" || os.includes("windows")) ids.push(id);
      }
      if (ids.length) return ids;
    }
  } catch {}
  return [String(appId + 1)];
}

let keyCache = null;
async function fetchKeys() {
  if (keyCache) return keyCache;
  const r = await axios.get(KEYS_URL, { timeout: 15000 });
  keyCache = r.data;
  return keyCache;
}

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ FCV server running on port ${PORT}`));
