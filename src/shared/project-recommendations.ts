import type { ExplanationReply, ReviewedSource } from './explanations'
import type { ProjectSpec } from './projects'

type Recommendation = ExplanationReply['recommendations'][number]
type Source = Pick<ReviewedSource, 'id' | 'label' | 'startLine' | 'endLine'>
const invalid = (message = 'Review the selected recommendations, dependencies and project limits before adding milestones.'): never => { throw new Error(message) }
const milestoneId = /^[a-z][a-z0-9-]{0,39}$/
const recommendationId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
function text(value: unknown, max: number, empty = false, label = 'Draft text'): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF]/u.test(value)) {
    invalid(label + ' must be valid plain text within the ' + max + '-character limit' + (empty ? '.' : ' and cannot be empty.'))
  }
  return value as string
}
function unique(values: string[]) { if (new Set(values).size !== values.length) invalid() }
function graph(items: Array<{ id: string; dependsOn: string[] }>) {
  const pending = new Map(items.map(item => [item.id, [...item.dependsOn]]))
  while (pending.size) {
    const next = [...pending].find(([, dependencies]) => dependencies.length === 0)
    if (!next) invalid('Milestone or recommendation dependencies contain a cycle or an unavailable prerequisite.')
    pending.delete(next![0])
    for (const [id, dependencies] of pending) pending.set(id, dependencies.filter(item => item !== next![0]))
  }
}

/** Pure draft merge, never a save, approval, test result or execution operation.
 * The existing main-process Projects.save validator/revision check remains authoritative.
 */
export function mergeProjectRecommendations(existing: ProjectSpec, recommendations: readonly Recommendation[],
  selectedIds: readonly string[], sources: readonly Source[]): { spec: ProjectSpec; idMap: Record<string, string> } {
  if (!existing || existing.version !== 1 || !Array.isArray(existing.milestones)
    || existing.milestones.length > 16 || !Array.isArray(existing.tests) || existing.tests.length > 16
    || !Array.isArray(recommendations) || recommendations.length > 12
    || !Array.isArray(selectedIds) || selectedIds.length > 12 || !Array.isArray(sources) || sources.length > 8) invalid()
  const oldIds = existing.milestones.map(item => {
    if (!item || !milestoneId.test(item.id) || !Array.isArray(item.dependsOn) || item.dependsOn.length > 15
      || item.dependsOn.some(id => !milestoneId.test(id))
      || !['not-started', 'in-progress', 'manually-completed'].includes(item.status)) invalid()
    unique(item.dependsOn)
    text(item.title, 120); text(item.description, 800, true)
    if (!Array.isArray(item.acceptance) || !item.acceptance.length || item.acceptance.length > 8) invalid()
    item.acceptance.forEach(value => text(value, 400))
    return item.id
  })
  unique(oldIds)
  graph(existing.milestones)
  if (existing.tests.some(test => !oldIds.includes(test.milestoneId))) invalid()
  const byId = new Map<string, Recommendation>()
  for (const item of recommendations) {
    if (!item || !recommendationId.test(item.id) || byId.has(item.id) || !Array.isArray(item.dependsOn)
      || item.dependsOn.length > 12 || item.dependsOn.some(id => !recommendationId.test(id))) invalid()
    unique(item.dependsOn)
    byId.set(item.id, item)
  }
  graph([...byId.values()])
  const selected = [...selectedIds]
  unique(selected)
  if (!oldIds.length && !selected.length) invalid('Select at least one recommendation to create a new roadmap.')
  if (selected.some(id => typeof id !== 'string' || !byId.has(id))) invalid()
  const selectedSet = new Set(selected)
  for (const id of selected) if (byId.get(id)!.dependsOn.some(dependency => !selectedSet.has(dependency))) {
    invalid('Select every prerequisite recommendation before adding these milestones.')
  }
  if (oldIds.length + selected.length > 16) {
    invalid('Project plans support up to 16 milestones. Select fewer recommendations or edit the existing plan first.')
  }
  const bySource = new Map<string, Source>()
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !recommendationId.test(source.id) || bySource.has(source.id)
      || !Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine)
      || source.startLine < 1 || source.endLine < source.startLine) invalid()
    text(source.label, 256)
    if (/[\r\n]/.test(source.label)) invalid()
    bySource.set(source.id, source)
  }
  const used = new Set(oldIds), idMap: Record<string, string> = Object.create(null)
  let sequence = 1
  for (const id of selected) {
    while (used.has('lens-' + sequence)) sequence++
    const mapped = 'lens-' + sequence++
    idMap[id] = mapped; used.add(mapped)
  }
  const additions = selected.map(id => {
    const item = byId.get(id)!
    const title = text(item.title, 120, false, 'Recommendation title'), description = text(item.description, 800, true, 'Recommendation description')
    if (!Array.isArray(item.acceptance) || !item.acceptance.length || item.acceptance.length > 8
      || !Array.isArray(item.citations) || item.citations.length > 8) invalid()
    const acceptance = item.acceptance.map(value => text(value, 400, false, 'Recommendation acceptance criterion'))
    const notes = item.citations.map(citation => {
      if (!citation || typeof citation.sourceId !== 'string') invalid()
      const source = bySource.get(citation.sourceId)
      if (!source) return invalid('A reviewed citation is unavailable or outside its selected excerpt. Review the context again.')
      if (!Number.isSafeInteger(citation.startLine) || !Number.isSafeInteger(citation.endLine)
        || citation.startLine < source.startLine || citation.endLine > source.endLine || citation.endLine < citation.startLine) {
        invalid('A reviewed citation is unavailable or outside its selected excerpt. Review the context again.')
      }
      return source.label + ': lines ' + citation.startLine + '–' + citation.endLine
    })
    const distinctNotes = [...new Set(notes)]
    const combined = description + (distinctNotes.length ? '\n\nReviewed context (not verification):\n' + distinctNotes.join('\n') : '')
    return { id: idMap[id], title, description: text(combined, 800, true, 'Recommendation description including citation notes'), acceptance,
      dependsOn: item.dependsOn.map(dependency => idMap[dependency]), status: 'not-started' as const }
  })
  const spec = structuredClone(existing)
  spec.milestones.push(...additions)
  graph(spec.milestones)
  return { spec, idMap }
}
