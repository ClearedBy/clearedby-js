/**
 * A *real* agent conversation, gated. A Claude support agent (Anthropic SDK,
 * tool-use loop) talks to a customer and, when a refund is warranted, calls its
 * `issue_refund` tool — which it CANNOT execute on its own. That tool gates the
 * action through ClearedBy first: policy clears it, rejects it, or holds it for
 * a human. The agent reads the verdict and continues the conversation honestly
 * (issues it / stands down / tells the customer it's pending).
 *
 * This is the missing piece the other examples only described: an LLM deciding
 * to do something consequential, mid-conversation, behind the gate — with a
 * typed Proof Case (SDK 0.0.3) so the reviewer sees friendly evidence cards.
 *
 *   ANTHROPIC_API_KEY=sk-ant-…  CLEAREDBY_API_KEY=cb_live_…  pnpm start
 *   # or pass your own opening line:
 *   pnpm start "my SO-118 never arrived, I want my money back"
 *
 * Tip: set the £842 path (an order over the £500 auto-clear line) to watch the
 * agent gate → get "pending" → tell the customer it's awaiting a human.
 */
import Anthropic from '@anthropic-ai/sdk'
import { ClearedBy, type Evidence } from '@clearedby/sdk'

const anthropicKey = process.env.ANTHROPIC_API_KEY
const clearedbyKey = process.env.CLEAREDBY_API_KEY
if (!anthropicKey || !clearedbyKey) {
  console.error('Set ANTHROPIC_API_KEY and CLEAREDBY_API_KEY.')
  process.exit(1)
}
const anthropic = new Anthropic({ apiKey: anthropicKey })
const cb = new ClearedBy({ apiKey: clearedbyKey, baseUrl: process.env.CLEAREDBY_BASE_URL })

// A stub order book — enough for the agent to assemble a rich Proof Case
// (customer profile, fulfilment timeline, the support thread + a photo).
interface Order {
  customer: string
  name: string
  total: number
  item: string
  tenure: string
  orders: number
  lifetime: number
  priorRefunds: number
  chargebacks: number
  timeline: { label: string; at: string }[]
  thread?: { id: string; snippet: string; url?: string }
  photo?: { url: string; caption: string }
}
const ORDERS: Record<string, Order> = {
  'SO-118': {
    customer: 'jordan.avery@example.com', name: 'Jordan Avery', total: 420, item: 'Studio Lamp',
    tenure: '2y 4m', orders: 14, lifetime: 2310, priorRefunds: 1, chargebacks: 0,
    timeline: [
      { label: 'Order placed', at: 'Jun 2' }, { label: 'Delivered', at: 'Jun 9' },
      { label: 'Damage reported', at: 'Jun 10' }, { label: 'Refund requested', at: 'Jun 11' },
    ],
    thread: { id: '4821', snippet: 'the lamp arrived cracked at the base, it won’t stand up.', url: 'https://support.example.com/threads/4821' },
    photo: { url: 'https://cdn.example.com/tickets/4821/damage_photo.jpg', caption: 'damage_photo.jpg' },
  },
  'SO-842': {
    customer: 'm.chen@example.com', name: 'Morgan Chen', total: 842, item: 'Carry-on Pro 40L',
    tenure: '5m', orders: 2, lifetime: 980, priorRefunds: 0, chargebacks: 0,
    timeline: [{ label: 'Order placed', at: 'Jun 8' }, { label: 'Delivered', at: 'Jun 15' }, { label: 'Refund requested', at: 'Jun 16' }],
    thread: { id: '5012', snippet: 'the zip broke on first use — I’d like a full refund.', url: 'https://support.example.com/threads/5012' },
  },
}

const SYSTEM = `You are a support agent for an online store. Be concise and warm.
When a refund is warranted, call the issue_refund tool — you CANNOT issue refunds yourself.
issue_refund is gated by ClearedBy: the policy may clear it, reject it, or hold it for a human.
Only tell the customer their refund is DONE if the tool returns a result starting with "issued".
If it returns "pending", tell them it's awaiting human approval (not yet done). If "blocked" or
"sent_back", do not promise the refund — explain honestly. Look up the order first.`

const tools: Anthropic.Tool[] = [
  {
    name: 'lookup_order',
    description: 'Look up an order by number to see the customer, total, and item.',
    input_schema: { type: 'object', properties: { order: { type: 'string', description: 'e.g. SO-118' } }, required: ['order'] },
  },
  {
    name: 'issue_refund',
    description:
      'Issue a refund on an order. CONSEQUENTIAL — gated by ClearedBy. Returns "issued …" (done), "pending …" (held for a human), "blocked …" (rejected), or "sent_back …" (revise & retry).',
    input_schema: {
      type: 'object',
      properties: {
        order: { type: 'string' },
        amount: { type: 'number', description: 'Refund amount in GBP' },
        reason: { type: 'string', description: 'Why the refund is warranted' },
      },
      required: ['order', 'amount', 'reason'],
    },
  },
]

// The gate lives HERE — the agent's consequential tool runs the action through
// ClearedBy and only "executes" (stub) when cleared.
async function issueRefund(args: { order: string; amount: number; reason: string }): Promise<string> {
  const o = ORDERS[args.order]
  // The agent's case, as typed evidence cards (SDK 0.0.3) — the reviewer sees a
  // threshold bar, a customer profile, the fulfilment timeline, the damage
  // photo, and the support thread, not raw JSON.
  const evidence: Evidence[] = []
  if (o) {
    const lowRisk = o.chargebacks === 0 && o.priorRefunds <= 1
    evidence.push({ type: 'threshold', value: { label: 'Amount vs policy cap', value: args.amount, limit: 500, unit: '£', status: args.amount > 500 ? 'over' : 'ok' } })
    evidence.push({
      type: 'entity',
      value: {
        name: o.name,
        subtitle: `Customer · ${o.tenure}`,
        badges: [{ label: lowRisk ? 'low risk' : 'review', tone: lowRisk ? 'ok' : 'risk' }],
        fields: [
          { label: 'Orders', value: o.orders },
          { label: 'Lifetime', value: `£${o.lifetime.toLocaleString('en-GB')}` },
          { label: 'Prior refunds', value: o.priorRefunds },
          { label: 'Chargebacks', value: o.chargebacks },
        ],
      },
    })
    evidence.push({ type: 'timeline', value: o.timeline })
    if (o.photo) evidence.push({ type: 'media', value: { url: o.photo.url, caption: o.photo.caption } })
    if (o.thread) evidence.push({ type: 'source', value: { title: `Support thread #${o.thread.id}`, snippet: o.thread.snippet, url: o.thread.url, verified: true } })
  }
  const r = await cb.gate({
    action: 'refund.create',
    params: { amount: args.amount, currency: 'GBP', order: args.order, customer: o?.customer },
    policy: 'commerce-ops',
    context: { agent_id: 'support-agent', model: 'claude-opus-4-8', summary: `Refund £${args.amount} on ${args.order}` },
    proof: {
      reason: args.reason,
      confidence: 0.9,
      recommended_outcome: 'approve_refund',
      risk_flags: o && args.amount >= o.total ? ['full_order_value'] : [],
      evidence,
    },
  })

  if (r.shadow || r.status === 'cleared') {
    const ref = `re_sim_${args.order}_${args.amount}`
    await cb.complete(r.id, { status: 'done', executedParams: { amount: args.amount, currency: 'GBP', order: args.order }, externalRef: ref }).catch(() => {})
    return `issued — refund of £${args.amount} on ${args.order} (ref ${ref})`
  }
  if (r.status === 'rejected') return `blocked by policy: ${r.reason ?? 'rejected'}`
  if (r.status === 'sent_back') return `sent_back to revise: ${r.reason ?? '(no note)'}`
  return `pending — held for a human (item ${r.id})`
}

async function runTool(name: string, input: unknown): Promise<string> {
  if (name === 'lookup_order') {
    const order = (input as { order: string }).order
    const o = ORDERS[order]
    return o ? JSON.stringify({ order, ...o }) : `No order ${order} found.`
  }
  if (name === 'issue_refund') return issueRefund(input as { order: string; amount: number; reason: string })
  return `unknown tool ${name}`
}

async function main() {
  const opening = process.argv.slice(2).join(' ') || 'Hi — my order SO-118 (a studio lamp) arrived cracked at the base and won’t stand up. I’d like a full refund please.'
  console.log(`\n👤 Customer: ${opening}\n`)

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }]

  for (let turn = 0; turn < 8; turn++) {
    const res = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools,
      messages,
    })

    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) console.log(`🤖 Agent: ${block.text}\n`)
    }
    if (res.stop_reason !== 'tool_use') break

    messages.push({ role: 'assistant', content: res.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type === 'tool_use') {
        const out = await runTool(block.name, block.input)
        console.log(`   ⚙️  ${block.name}(${JSON.stringify(block.input)}) → ${out}`)
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out })
      }
    }
    messages.push({ role: 'user', content: results })
  }
}

main().catch((err) => {
  console.error('\nfailed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
