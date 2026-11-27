export interface CopilotPosition { line: number; character: number }
export interface CopilotDocument { uri: string; languageId: string; version: number; text: string }
export interface CopilotInlineCompletion { id: string; text: string; range: { start: CopilotPosition; end: CopilotPosition }; version: number }
export interface CopilotStatus { kind: 'Normal' | 'Error' | 'Warning' | 'Inactive'; message: string; busy: boolean }

export interface CopilotBridge {
  activate(): Promise<CopilotStatus>
  deactivate(): Promise<void>
  status(): Promise<CopilotStatus>
  beginSignIn(): Promise<{ status: string; user?: string }>
  signOut(): Promise<{ status: string; user?: string }>
  closeDocument(): Promise<void>
  complete(requestId: string, document: CopilotDocument, position: CopilotPosition, triggerKind: 1 | 2): Promise<CopilotInlineCompletion[]>
  cancelCompletion(requestId: string): Promise<void>
  shown(id: string): Promise<void>
  partiallyAccepted(id: string, acceptedLength: number): Promise<void>
  accepted(id: string): Promise<void>
}
