# Setup

The static site lives on GitHub Pages at https://agent.kasimirszekeres.com.
Notes live on a Cloudflare Worker. Card payments need Stripe.

## Done

- Cloudflare account `info@kasimirszekeres.com` (`5397d72a1b447d247fba545c79ecc95c`)
- KV namespaces `NOTES` and `STATS`
- Worker `agent-tipjar` at https://agent-tipjar.kasimirszekeres.workers.dev
- Admin hide token stored as the Worker secret `ADMIN_TOKEN` (local copy in `worker/.dev.vars`, not in git)
- Worker URLs written into `AGENTS.md`, `tipjar.json`, and `.well-known/tipjar.json`

`support.html` reads Worker URLs from `/tipjar.json`.

## Still to do

### GitHub

Push this repo to `kasimirszekeres/agent` as user `kasimirszekeres`.
Create a label named `note` at https://github.com/kasimirszekeres/agent/labels

### Stripe (optional, fee per payment)

Needed only if the EUR 1 button should work. Notes work without it.

1. Create an account at https://dashboard.stripe.com/register
2. Complete the identity and payout details Stripe asks for.
3. Create a Payment Link:
   - Product name: `Support real images`
   - Currency: EUR
   - Amount: 1.00
   - Optional: let the customer choose an amount, minimum 1, maximum 5
4. Replace `<stripe-payment-link>` in:
   - `AGENTS.md`
   - `tipjar.json`
   - `.well-known/tipjar.json`
   - `support.html` (two places)
5. Add a webhook:
   - URL: `https://agent-tipjar.kasimirszekeres.workers.dev/stripe-webhook`
   - Event: `checkout.session.completed` only
6. Store the signing secret:

```
cd worker
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Keep `tipjar.json` and `.well-known/tipjar.json` identical.

## Hide a note

```
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  "https://agent-tipjar.kasimirszekeres.workers.dev/admin/hide?id=NOTE_ID"
```

The token is in `worker/.dev.vars` on this Mac. Editing KV by hand also works: set `"hidden": true` on the note, then decrement `note_count` in `STATS` by one.

## What not to commit

- The admin token
- The Stripe webhook secret
- `worker/.dev.vars`

## Check

```
curl -s https://agent-tipjar.kasimirszekeres.workers.dev/stats
curl -s https://agent-tipjar.kasimirszekeres.workers.dev/notes
```

After a push, open https://agent.kasimirszekeres.com/support.html
