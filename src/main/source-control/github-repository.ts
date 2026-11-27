export const accountName = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?$/

export function checkRepository(input: unknown) {
  if (typeof input !== 'string' || input.length > 140) throw new Error('Enter a GitHub repository as owner/name.')
  const [owner, name, ...extra] = input.split('/')
  if (!accountName.test(owner) || !name || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..' || extra.length) {
    throw new Error('Enter a GitHub repository as owner/name.')
  }
  return input
}
