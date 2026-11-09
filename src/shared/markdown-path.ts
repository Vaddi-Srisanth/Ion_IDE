export const maxMarkdownPreviewSourceLength = 160 * 1024

export function isMarkdownFile(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path)
}
