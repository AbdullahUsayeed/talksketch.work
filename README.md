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

## Software

- **Desktop app (Electron + local Whisper + Excalidraw):** [`desktop/`](desktop/)
- **Self-hosted platform (Vexa-compatible transcript API, stateless AI, demo, extension):** [`platform/`](platform/)

The site is static; the app is a Windows installer; the platform is Node and can be
self-hosted with your own model key.

## Download

- Windows installer (~209 MB, includes the local Whisper model):
  <https://54.255.181.218.sslip.io/download/TalkSketch-Setup-0.1.0.exe>
- The installer is currently unsigned, so Windows SmartScreen warns on first run.

## Billing

The Pro button is a live PayPal subscription:

- Plan: `P-9E290320FG523503DNL3OJ2Y` (3-day trial, then $12/month)
- 3-day free trial, then **$12/month USD**
- Product: `PROD-06C413632R371032G`

The plan ID lives in `assets/app.js` and is public by design. The PayPal **secret** is
never used in this repo — it belongs in the backend that verifies webhooks and issues
entitlements. If a secret is ever pasted into a chat or committed, rotate it in the
PayPal dashboard.

To change the price, create a new plan (PayPal plans are immutable) and replace `PLAN_ID`.

## Structure

```
index.html            landing page
start.html            pilot onboarding
welcome.html          post-subscription page
terms.html            terms of service
privacy.html          privacy policy
assets/styles.css     design system + animations
assets/app.js         nav, reveals, typewriter, PayPal
assets/logo.svg       wordmark
assets/og.svg         social card
desktop/              Electron app (capture, local Whisper, Excalidraw)
platform/             self-hostable backend (auth, trials, billing, AI call)
```

Everything here is Apache-2.0. Build the app from `desktop/` and the backend from
`platform/`; neither contains secrets.
