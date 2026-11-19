// A small CSV reader and writer: commas, double quotes, "" for a quote inside quotes.

export function parseCsv(text) {
  const records = []
  let record = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      record.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      record.push(cell)
      records.push(record)
      record = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell)
    records.push(record)
  }
  const filled = records.filter((cells) => cells.some((value) => value !== ''))
  if (filled.length === 0) throw new Error('the file has no header row')
  const [header, ...rows] = filled
  return { header, rows }
}

function quote(value) {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function toCsv(header, rows) {
  return [header, ...rows].map((cells) => cells.map(quote).join(',')).join('\n') + '\n'
}
