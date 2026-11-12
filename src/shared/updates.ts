export type UpdateStatus = { current: string; notice?: string } & (
  | { state: 'unchecked' | 'current' | 'no-release' | 'unsupported' }
  | { state: 'asset-missing'; latest: string }
  | { state: 'available'; latest: string; name: string; bytes: number; ready?: boolean }
)

export interface UpdatesBridge {
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  download(): Promise<{ name: string }>
  install(): Promise<boolean>
  cancel(): Promise<void>
}
