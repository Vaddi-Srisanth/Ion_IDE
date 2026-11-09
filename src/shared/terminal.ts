export type BottomTab = 'terminal' | 'run'
export const maxTerminalSessions = 6

export interface TerminalSessionInfo {
  id: string
  title: string
}

export type TerminalEvent =
  | { id: string; kind: 'data'; text: string; sequence: number }
  | { id: string; kind: 'exit'; code: number | null; detail?: string }

export interface TerminalBridge {
  create(columns: number, rows: number): Promise<TerminalSessionInfo>
  attach(id: string): Promise<void>
  ack(id: string, sequence: number): Promise<void>
  input(id: string, text: string): Promise<void>
  resize(id: string, columns: number, rows: number): Promise<void>
  close(id: string): Promise<void>
  setFocus(focused: boolean): Promise<void>
  copy(text: string): Promise<void>
  paste(): Promise<void>
  onEvent(callback: (event: TerminalEvent) => void): () => void
}
