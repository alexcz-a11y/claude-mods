import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCsv, toCsv } from '../src/csv.mjs'
import { fields } from '../src/fields/index.mjs'

// One value each field takes and one it refuses.
const SAMPLES = {
  amount: ['1,250.00', '12,50'],
  appVersion: ['3.12.0', '3.12'],
  birthYear: ['1988', '88'],
  countryCode: ['nl', 'NLD'],
  deviceId: ['3f2a9c1e-77b0-4d2a-9c1e5a7b3d10', '3f2a9c1e-77b0'],
  email: ['ilse@fernhill.example', 'ilse.fernhill.example'],
  hexColor: ['#1A9', '#12'],
  ipv4: ['10.4.0.17', '10.4.0.256'],
  isoDate: ['2031-03-04', '2031-13-01'],
  lockerCode: ['BC-7', 'bc7'],
  memberId: ['M-004217', 'M-4217'],
  name: ['Ilse Marrow', '   '],
  phone: ['+00 555 010 2030', '12-34'],
  postcode: ['40212-0031', '4021'],
  referral: ['K7QM-22XA', 'K7QM22XA'],
  slug: ['ilse-marrow', 'Ilse_Marrow'],
  tags: ['chess;rowing', 'chess; rowing'],
  time24: ['18:45', '24:00'],
  username: ['ilse_m', '9lives'],
  yesNo: ['YES', 'maybe'],
}

for (const [type, [good, bad]] of Object.entries(SAMPLES)) {
  test(`${type} takes ${JSON.stringify(good)} and refuses ${JSON.stringify(bad)}`, () => {
    assert.equal(fields[type].isValid(good), true)
    assert.equal(fields[type].isValid(bad), false)
  })
}

test('every field type has a sample here', () => {
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(SAMPLES).sort())
})

test('values are stored in one spelling', () => {
  assert.equal(fields.email.normalize('Tobin@Aske.example'), 'tobin@aske.example')
  assert.equal(fields.phone.normalize('+00 (555) 010-2030'), '+005550102030')
  assert.equal(fields.hexColor.normalize('#1A9'), '#11aa99')
  assert.equal(fields.amount.normalize('1,250.00'), '1250.00')
  assert.equal(fields.tags.normalize('rowing;chess'), 'chess;rowing')
  assert.equal(fields.yesNo.normalize('Y'), 'yes')
})

test('csv keeps commas and quotes inside quoted cells', () => {
  const table = parseCsv('a,b\n"1,250.00","say ""hi"""\n')
  assert.deepEqual(table.rows, [['1,250.00', 'say "hi"']])
  assert.equal(toCsv(table.header, table.rows), 'a,b\n"1,250.00","say ""hi"""\n')
})
