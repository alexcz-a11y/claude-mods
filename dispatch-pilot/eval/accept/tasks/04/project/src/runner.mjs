import { fields } from './fields/index.mjs'

// Checks every row against the schema. A row with any bad cell is rejected as a whole;
// an accepted row comes back with its values in the form they are stored in.
export function checkRows(table, schema) {
  for (const [column, rule] of Object.entries(schema)) {
    if (!fields[rule.type]) throw new Error(`column ${column}: unknown field type ${rule.type}`)
    if (!table.header.includes(column)) throw new Error(`the file has no column ${column}`)
  }

  const problems = []
  const accepted = []
  table.rows.forEach((cells, index) => {
    const row = index + 1
    const cleaned = []
    let bad = false
    table.header.forEach((column, position) => {
      const value = cells[position] ?? ''
      const rule = schema[column]
      if (!rule) {
        cleaned.push(value)
        return
      }
      const field = fields[rule.type]
      if (value === '') {
        if (rule.required) {
          problems.push({ row, column, message: 'a value is required' })
          bad = true
        }
        cleaned.push('')
        return
      }
      if (!field.isValid(value)) {
        problems.push({ row, column, message: `${JSON.stringify(value)} is not a valid ${field.name} (like ${field.hint})` })
        bad = true
        cleaned.push(value)
        return
      }
      cleaned.push(field.normalize ? field.normalize(value) : value)
    })
    if (!bad) accepted.push(cleaned)
  })
  return { problems, accepted }
}
