# FCV Site — Full Setup Tutorial

## File Structure
```
fcv-site/
├── server.js
├── package.json
├── .env
├── users.json          ← auto-created
└── public/
    └── index.html
```

---

## STEP 1 — Discord OAuth App

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "FCV Generator"
3. Go to **OAuth2 → General**
4. Under **Redirects** add:
   - `http://localhost:3000/auth/callback`
   - `https://your-app.railway.app/auth/callback`
5. Copy your **Client ID** and **Client Secret**

---

## STEP 2 — Stripe Setup

### Create products
1. Go to https://stripe.com → sign in → stay in **Test mode** (toggle top right)
2. Go to **Products** → **Add product**
3. Create **Basic**: $2.00 / month (Recurring) → copy the Price ID
4. Create **Enterprise**: $5.00 / month (Recurring) → copy the Price ID

### Get API keys
Go to **Developers → API keys** → copy **Secret key** (sk_test_...)

### Webhook for local testing
Install Stripe CLI: https://stripe.com/docs/stripe-cli
```bash
stripe login
stripe listen --forward-to localhost:3000/stripe/webhook
```
Copy the `whsec_...` it gives you.

### Webhook for production
1. **Developers → Webhooks → Add endpoint**
2. URL: `https://your-app.railway.app/stripe/webhook`
3. Events: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`
4. Copy the signing secret

---

## STEP 3 — Fill in .env

```
DISCORD_CLIENT_ID=paste_here
DISCORD_CLIENT_SECRET=paste_here
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any_long_random_string_abc123xyz
SITE_URL=http://localhost:3000

STRIPE_SECRET_KEY=sk_test_paste_here
STRIPE_PRICE_BASIC=price_paste_here
STRIPE_PRICE_ENTERPRISE=price_paste_here
STRIPE_WEBHOOK_SECRET=whsec_paste_here
```

---

## STEP 4 — Run locally

```bash
npm install
node server.js
```
Open http://localhost:3000

---

## STEP 5 — Test payments (no real money ever)

Use these test card numbers at checkout:

| Card                  | Result        |
|-----------------------|---------------|
| 4242 4242 4242 4242   | Success       |
| 4000 0000 0000 0002   | Declined      |
| 4000 0025 0000 3155   | 3D Secure     |

Expiry: any future date | CVC: any 3 digits | ZIP: any 5 digits

### Full test flow:
1. Open http://localhost:3000
2. Login with Discord
3. Go to Pricing → Upgrade to Basic
4. Enter `4242 4242 4242 4242`
5. Complete checkout → redirected back → nav shows "Basic" badge
6. Now get 20 generations at faster speed

### Watch webhooks:
```bash
stripe listen --forward-to localhost:3000/stripe/webhook
```
You'll see "Upgraded discord_id → basic" in your server logs.

---

## STEP 6 — Deploy to Railway

1. Push to GitHub (.env in .gitignore!)
2. Railway → New Project → Deploy from GitHub
3. Add all Variables in Railway dashboard
4. Change REDIRECT_URI and SITE_URL to your Railway domain
5. Use the production webhook secret from Stripe

---

## Plan limits

| Plan       | Generations/month | Speed      | Price |
|------------|-------------------|------------|-------|
| Free       | 5                 | ~15s       | $0    |
| Basic      | 20                | ~7-10s     | $2/mo |
| Enterprise | Unlimited         | Instant    | $5/mo |
