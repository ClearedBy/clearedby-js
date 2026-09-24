#!/usr/bin/env node
// The `clearedby` bin: `npx @clearedby/sdk doctor [options]` (CLE-226).
import { runDoctorCli } from './doctor.js'

runDoctorCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exitCode = 2
  },
)
