#!/usr/bin/env node
import { main } from '../src/cli.mjs'

process.exitCode = main(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
