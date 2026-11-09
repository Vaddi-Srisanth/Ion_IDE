export const maxEditableTextBytes = 2 * 1024 * 1024
export const maxTextCopyBytes = 16 * 1024 * 1024
export const maxTextPreviewBytes = 128 * 1024 * 1024
export const textPageBytes = 64 * 1024
export const largeTextError = 'TEXT_FILE_TOO_LARGE:'

export interface TextPage {
  text: string
  pages: number
  revision: string
}
