// memo(fn) remembers what fn returned, so the same lookup is not done twice.
// A result is filed under the call's first argument; pass keyOf to file it under something else.
export function memo(fn, keyOf = (first) => first) {
  const results = new Map()
  return function memoized(...args) {
    const key = keyOf(...args)
    if (!results.has(key)) results.set(key, fn(...args))
    return results.get(key)
  }
}
