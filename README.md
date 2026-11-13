# talksketch.work

Landing page for **TalkSketch** - an AI meeting partner with live notes, decisions
and a local whiteboard. Static HTML/CSS/JS, no build step, deployed to
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

- **Desktop app (Electron + cloud transcription + Excalidraw):** [`desktop/`](desktop/)
- **Self-hosted platform (Vexa-compatible transcript API, stateless AI, demo, extension):** [`platform/`](platform/)

The site is static; the app is a Windows installer; the platform is Node and can be
self-hosted with your own model key.

## Download

- Windows installer (~86 MB):
  <https://54.255.181.218.sslip.io/download/TalkSketch-Setup-0.1.0.exe>
- The installer is currently unsigned, so Windows SmartScreen warns on first run.

## Billing

Checkout lives in the desktop app, not the site:

- The 3-day trial starts on the first Google sign-in. No card required.
- **Upgrade — $12/mo** opens PayPal Checkout inside the app and activates the account
  immediately. Plan: `P-0ET25800HC594571SNL3ONGY` (no trial, $12/month).
- The server verifies the subscription via `/v1/billing/activate`; PayPal webhooks handle
  cancellation, suspension and expiry.
- The site has no subscription button — it only links to the installer.

The plan ID and PayPal client ID are served by `/v1/config`; the PayPal **secret** never
leaves the server. If a secret is ever pasted into a chat or committed, rotate it in the
PayPal dashboard.

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
desktop/              Electron app (capture, cloud transcription, Excalidraw)
platform/             self-hostable backend (auth, trials, billing, AI call)
```

Everything here is Apache-2.0. Build the app from `desktop/` and the backend from
`platform/`; neither contains secrets.
