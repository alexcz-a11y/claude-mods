// Every field type, by the name the schema uses.
import * as amount from './amount.mjs'
import * as appVersion from './appVersion.mjs'
import * as birthYear from './birthYear.mjs'
import * as countryCode from './countryCode.mjs'
import * as deviceId from './deviceId.mjs'
import * as email from './email.mjs'
import * as hexColor from './hexColor.mjs'
import * as ipv4 from './ipv4.mjs'
import * as isoDate from './isoDate.mjs'
import * as lockerCode from './lockerCode.mjs'
import * as memberId from './memberId.mjs'
import * as name from './name.mjs'
import * as phone from './phone.mjs'
import * as postcode from './postcode.mjs'
import * as referral from './referral.mjs'
import * as slug from './slug.mjs'
import * as tags from './tags.mjs'
import * as time24 from './time24.mjs'
import * as username from './username.mjs'
import * as yesNo from './yesNo.mjs'

const all = [
  amount,
  appVersion,
  birthYear,
  countryCode,
  deviceId,
  email,
  hexColor,
  ipv4,
  isoDate,
  lockerCode,
  memberId,
  name,
  phone,
  postcode,
  referral,
  slug,
  tags,
  time24,
  username,
  yesNo,
]

export const fields = Object.fromEntries(all.map((field) => [field.name, field]))
