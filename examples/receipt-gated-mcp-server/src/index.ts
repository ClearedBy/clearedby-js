#!/usr/bin/env node
/**
 * Stdio entry — run "Partner Billing" as a real MCP server for Claude
 * Desktop / Claude Code / any MCP client:
 *
 *   PARTNER_AUDIENCE=mcp://partner-billing.example pnpm start
 *
 * It fetches ClearedBy's published keys once at boot (the only ClearedBy
 * contact it ever makes — and it's a public, unauthenticated document), then
 * decides every tool call offline. Point CLEAREDBY_BASE_URL elsewhere for a
 * non-production gate.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fetchClearedByKeys } from '@clearedby/sdk/receipt'
import { buildPartnerServer } from './server.js'

const AUDIENCE = process.env.PARTNER_AUDIENCE || 'mcp://partner-billing.example'

async function main() {
  const keys = await fetchClearedByKeys({ baseUrl: process.env.CLEAREDBY_BASE_URL })
  if (Object.keys(keys).length === 0) {
    console.error('No Ed25519 keys published at /.well-known/clearedby-keys — receipts cannot be verified.')
    process.exit(1)
  }
  const { server } = buildPartnerServer({
    audience: AUDIENCE,
    keys,
    maxRefund: Number(process.env.MAX_REFUND) || 500,
  })
  await server.connect(new StdioServerTransport())
  console.error(`partner-billing MCP server up — audience ${AUDIENCE}, ${Object.keys(keys).length} verification key(s) cached`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
