# Fire-and-forget — callback receiver

Gate a consequential action **without blocking**: pass a `callbackUrl`, return
immediately, and let ClearedBy POST the verdict to your endpoint when a human
decides — minutes or days later. Ideal for long / out-of-hours reviews where you
don't want to hold a process open.

This single file is both halves:

1. **Submit** a gated `refund.create` with a `callbackUrl`. The gate returns
   `pending` and hands you a `resume.signing_secret`.
2. **Receive** the verdict on a tiny webhook server, **verify** its
   `X-ClearedBy-Signature`, and act (proceed / stand down / revise).

## Why the signature matters

Anyone who learns your callback URL could POST a fake verdict. So every callback
is signed:

```
X-ClearedBy-Signature: sha256=hmac(resume.signing_secret, rawBody)
```

The receiver recomputes the HMAC over the **raw** body and compares (constant-time)
before trusting the verdict.

## Run it

ClearedBy (in the cloud) must be able to reach your receiver, so for local runs
expose the port with a tunnel:

```bash
# 1. tunnel this port (pick one)
ngrok http 4500            # → https://abcd-1234.ngrok-free.app
# or: cloudflared tunnel --url http://localhost:4500

# 2. run, pointing PUBLIC_URL at the tunnel
CLEAREDBY_API_KEY=cb_live_… PUBLIC_URL=https://abcd-1234.ngrok-free.app pnpm start
```

Then decide the item in the ClearedBy workspace and watch the receiver log:

```
Receiver up on :4500; ClearedBy will call https://…/hooks/clearedby
Gated → pending. Parked, holding no compute. Waiting for the verdict on the hook…
✓ verified callback — cleared (item wi_…)
   → safe to proceed: doing the work now (issue refund / send / etc.)
```

See also: [`shopify-refund-agent`](../shopify-refund-agent) (the blocking + revise loop) ·
[`@clearedby/sdk`](../../packages/sdk).
