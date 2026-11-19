const OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/g

export const name = 'ipv4'
export const hint = '10.4.0.17'

export function isValid(value) {
  const match = OCTETS.exec(value)
  return match !== null && match.slice(1).every((part) => Number(part) <= 255)
}
