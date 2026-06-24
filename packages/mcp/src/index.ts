#!/usr/bin/env node
// ClearedBy MCP server (CLE-20). Exposes three tools to any MCP client
// (Claude Code/Desktop, etc.): request_clearance, check_policy, get_ledger.
// Reads CLEAREDBY_API_KEY; talks to the gate via @clearedby/sdk over stdio.
//
//   CLEAREDBY_API_KEY=cb_live_… npx @clearedby/mcp

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ClearedBy } from '@clearedby/sdk'
import { checkPolicy, getLedger, requestClearance } from './tools.js'

async function main() {
  const apiKey = process.env.CLEAREDBY_API_KEY
  if (!apiKey) {
    console.error('CLEAREDBY_API_KEY is required')
    process.exit(1)
  }
  const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })
  const server = new McpServer({ name: 'clearedby', version: '0.0.1' })

  server.tool(
    'request_clearance',
    'Gate a consequential action before doing it. Returns one of: cleared (safe to proceed), rejected (do NOT proceed), or sent_back (revise & resubmit — NOT a rejection: address the reviewer note, then call this tool again with parentItemId set to the returned parent_item_id). If held for a human it waits up to 10 minutes. Pass model + confidence + reason + evidence cards so the reviewer sees a real proof case, not placeholders.',
    {
      action: z.string().describe('e.g. refund.create, ad.launch'),
      params: z.record(z.unknown()).optional().describe('the action parameters, e.g. { amount: 250 }'),
      policy: z.string().optional(),
      summary: z.string().optional().describe('one-line human summary for the reviewer'),
      model: z.string().optional().describe('the model proposing this action, e.g. claude-opus-4-8'),
      confidence: z.number().min(0).max(1).optional().describe('your confidence this should be cleared, 0..1'),
      reason: z.string().optional().describe('why this should be cleared — your justification'),
      recommendedOutcome: z.string().optional().describe('the outcome you recommend, e.g. approve_refund — shown to the reviewer as a "recommends ·" pill'),
      riskFlags: z.array(z.string()).optional().describe('things the reviewer should weigh, e.g. ["high_value","first_order"]'),
      evidence: z
        .array(z.object({ type: z.string(), value: z.unknown() }))
        .optional()
        .describe(
          'typed evidence cards the reviewer sees. Known types render as friendly cards: ' +
            'threshold {label,value,limit?,unit?} · entity {name,subtitle?,fields?:[{label,value}],badges?:[{label,tone?}]} · ' +
            'timeline [{label,at?,detail?}] · table {columns,rows} · media {url|dataUrl,caption?} · source {title?,url?,snippet?} · ' +
            'conversation {title?,messages:[{from?,text?,image?,at?}]} (a chat/support thread shown as bubbles; a message can carry an image). ' +
            'Any other type falls back to a generic key/value card.',
        ),
      parentItemId: z
        .string()
        .optional()
        .describe('when resubmitting a revised action after a sent_back verdict, the parent_item_id you were given — keeps the revise chain on one auditable lineage'),
    },
    async (args) => {
      // agent_id from the connecting MCP client (e.g. "claude-code") so the
      // provenance record shows the real agent rather than the 'agent' default.
      const agentId = server.server.getClientVersion()?.name
      const r = await requestClearance(cb, { ...args, agentId } as Parameters<typeof requestClearance>[1])
      return { content: [{ type: 'text', text: r.text }], isError: r.isError, structuredContent: r.structured }
    },
  )

  server.tool(
    'check_policy',
    'Dry-run: preview what the policy WOULD decide for an action, without recording anything.',
    {
      action: z.string(),
      params: z.record(z.unknown()).optional(),
      policy: z.string().optional(),
    },
    async (args) => {
      const r = await checkPolicy(cb, args as any)
      return { content: [{ type: 'text', text: r.text }], isError: r.isError, structuredContent: r.structured }
    },
  )

  server.tool(
    'get_ledger',
    'Recent entries from the tamper-evident attestation ledger (signed decisions), newest first.',
    { limit: z.number().int().positive().max(200).optional() },
    async (args) => {
      const r = await getLedger(cb, args as any)
      return { content: [{ type: 'text', text: r.text }], isError: r.isError, structuredContent: r.structured }
    },
  )

  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('clearedby-mcp fatal:', err)
  process.exit(1)
})
