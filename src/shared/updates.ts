export type UpdateStatus = { current: string } & (
  | { state: 'unchecked' | 'current' | 'no-release' | 'unsupported' }
  | { state: 'asset-missing'; latest: string }
  | { state: 'available'; latest: string; name: string; bytes: number }
)

export interface UpdatesBridge {
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  download(): Promise<{ name: string }>
  cancel(): Promise<void>
}
