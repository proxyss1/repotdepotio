# FCV Site — Steam Manifest Generator with Discord Auth

## File Structure
```
fcv-site/
├── server.js          ← Node.js backend
├── package.json
├── .env               ← Your secrets
├── users.json         ← Auto-created, stores user data
└── public/
    └── index.html     ← Frontend
```

---

## Step 1 — Create Discord OAuth App

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "FCV Generator"
3. Go to **OAuth2** in the left sidebar
4. Under **Redirects** click **Add Redirect** and enter:
   `https://your-app.railway.app/auth/callback`
   (use `http://localhost:3000/auth/callback` for local testing)
5. Copy your **Client ID** and **Client Secret**

---

## Step 2 — Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to https://railway.app → **New Project → Deploy from GitHub**
3. Select your repo
4. Go to **Variables** tab and add:

```
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
REDIRECT_URI=https://your-app.railway.app/auth/callback
SESSION_SECRET=any_long_random_string_here
```

5. Railway auto-detects Node.js and runs `npm start`
6. Go to **Settings → Networking → Generate Domain** to get your URL
7. Update the Discord OAuth redirect URL with your Railway domain

---

## Step 3 — Test locally first (optional)

```bash
npm install
# Fill in .env with localhost values
node server.js
# Open http://localhost:3000
```

---

## How it works

- User visits site → sees login gate on the generator card
- Clicks "Login with Discord" → Discord OAuth flow
- After auth, backend creates a user record in `users.json`
- Each generation call checks: is user logged in? how many this month?
- If under 10 → runs generation, increments counter, returns .lua
- If at 10 → returns 429 error with upgrade message
- Counter resets automatically at the start of each calendar month
