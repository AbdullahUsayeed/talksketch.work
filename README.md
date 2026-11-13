# talksketch.work

Landing page for **TalkSketch** — an AI meeting partner with live notes, proactive
suggestions and a shared whiteboard. Static HTML/CSS/JS, no build step, deployed to
GitHub Pages.

## Local

```bash
python -m http.server 8080
# or: npx serve .
```

Open http://localhost:8080.

## Deploy

Pushes to `main` deploy through `.github/workflows/pages.yml`. In the repo settings:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Custom domain: `talksketch.work` (the `CNAME` file is already here)
3. DNS at your registrar:
   - `A` records for `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www`: `abdullausayeed.github.io`
4. Enable **Enforce HTTPS** once the certificate is issued.

## Billing

The Pro button is a live PayPal subscription:

- Plan: `P-6YB06036H1886744ENL3HT5A`
- 7-day free trial, then **$12/month USD**
- Product: `PROD-06C413632R371032G`

The plan ID lives in `assets/app.js` and is public by design. The PayPal **secret** is
never used in this repo — it belongs in the backend that verifies webhooks and issues
entitlements. If a secret is ever pasted into a chat or committed, rotate it in the
PayPal dashboard.

To change the price, create a new plan (PayPal plans are immutable) and replace `PLAN_ID`.

## Structure

```
index.html            landing page
welcome.html          post-subscription page
assets/styles.css     design system + animations
assets/app.js         nav, reveals, typewriter, PayPal
assets/logo.svg       wordmark
assets/og.svg         social card
```

The software itself (desktop app + AI platform) is Apache-2.0 and lives alongside this
site as it is published.
