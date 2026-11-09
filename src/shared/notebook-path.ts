export const maxNotebookBytes = 16 * 1024 * 1024

export function isNotebookName(name: string): boolean {
  return /\.ipynb$/i.test(name)
}
