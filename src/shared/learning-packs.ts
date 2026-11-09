export interface PackSummary {
  id: string
  name: string
  summary: string
  version: number
  topicCount: number
}

export interface PackTopic {
  id: string
  title: string
  section: string
}

export interface PackLesson extends PackTopic {
  explanation: string
  example: string
  api: Array<{ name: string; description: string }>
  practice: string
  pitfall?: string
}

export interface PackLibrary {
  catalog: PackSummary[]
  installed: PackSummary[]
  selected: string | null
}

export interface LearningPacksBridge {
  getLibrary(): Promise<PackLibrary>
  install(id: string): Promise<PackLibrary>
  remove(id: string): Promise<PackLibrary>
  select(id: string | null): Promise<PackLibrary>
  importPack(): Promise<PackLibrary | null>
  getTopics(id: string): Promise<PackTopic[]>
  getLesson(id: string, topic: string): Promise<PackLesson>
}
