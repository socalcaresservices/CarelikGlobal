# App icon and link preview (2026-11-17)

Status: **implemented, not deployed.**

## Owner brief
- Browser tab for app.ogevia.com shows a generic globe; texted links show no image.
- Owner approved (2026-11-17) a pull request for the Ogevia icon and link preview first, then branded invitation
  emails tested on demo.ogevia.com before any production change.

## Decisions
- Owner supplied the Ogevia logo (512×512 PNG) on 2026-11-17. Icons use the logo's symbol only (no wordmark, which is
  unreadable at 16–48 px); the link-preview image uses the full logo on white.
- The in-app sidebar still shows the text "O" tile; replacing it with the logo is a separate, unrequested change.
- A higher-resolution or vector (SVG) master would sharpen the preview image; the supplied 512 px file is adequate.
- Browser tab and home-screen icon show **Ogevia** (shared product), not an agency name.
- `og:image` uses the absolute URL `https://app.ogevia.com/og-image.png` because link-preview crawlers require one.

## Files
- `apps/web/public/favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`,
  `site.webmanifest`, `og-image.png`
- `apps/web/index.html`: icon, manifest and Open Graph tags.

## Security / cost
- Static same-origin files; compatible with the existing CSP (`img-src 'self'`, manifest falls back to `default-src 'self'`).
- No AWS changes. No cost.

## Tests (local, 2026-11-17)
- `pnpm lint`, `pnpm typecheck`, `pnpm build` (apps/web): pass; icon files present in `dist/`.
- `pnpm test` (apps/web): 1218 passed, 1 failed. The failure
  (`calendar-authorised-hours.test.tsx`, "updates when the client changes and when the month changes") also fails on
  unmodified `main` at 466f8ac and is unrelated to this change.

## Not yet verified
- Rendering on demo.ogevia.com / app.ogevia.com after deployment, and link previews in iMessage/SMS (previews are cached by
  some apps; a new link may be needed to see the change).

## Next
- Part B: branded staff invitation email via Cognito custom-message trigger (agency name/logo from the inviting agency,
  Ogevia fallback), SES delivery from ogevia.com. Test two agencies, a resent invite, and password reset on demo first.
