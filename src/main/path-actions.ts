import type { WorkspaceFiles } from './files'

/**
 * Resolve an Explorer context action against Ion's existing filesystem grants.
 * This does not create a grant and rejects missing, redirected, or special files.
 */
export async function authorizedContextPath(scope: WorkspaceFiles, value: unknown): Promise<string> {
  return (await scope.inspect(value)).path
}

export async function copyAuthorizedPath(
  scope: WorkspaceFiles,
  value: unknown,
  write: (path: string) => void,
): Promise<string> {
  const path = await authorizedContextPath(scope, value)
  write(path)
  return path
}

export async function revealAuthorizedPath(
  scope: WorkspaceFiles,
  value: unknown,
  reveal: (path: string) => void,
): Promise<string> {
  const path = await authorizedContextPath(scope, value)
  reveal(path)
  return path
}
