// Splits a command line into the command, its flags and the words that belong to no flag.
// `--name value` gives flags.name = 'value'; a flag with nothing after it is true.
export function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]
    if (!word.startsWith('--')) {
      positional.push(word)
      continue
    }
    const name = word.slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i += 1
    }
  }
  return { command, flags, positional }
}
