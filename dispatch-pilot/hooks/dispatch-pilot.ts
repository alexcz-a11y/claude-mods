import type { Register } from 'claude-code'

import { readConfig } from './config.ts'

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
}
