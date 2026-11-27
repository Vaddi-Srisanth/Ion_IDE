import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ProviderSettings, ProviderUpdate } from '../../shared/projects'
import './ProviderConfiguration.css'

export interface ProviderConfigurationProps {
  provider: ProviderSettings
  onConfigure(update: ProviderUpdate): Promise<ProviderSettings>
  onChange?(settings: ProviderSettings): void
  disabled?: boolean
}

/** Keys live only in the password field until an explicit submission. */
export function ProviderConfiguration({ provider, onConfigure, onChange, disabled = false }: ProviderConfigurationProps) {
  const key = useRef<HTMLInputElement>(null)
  const mounted = useRef(false), pendingRef = useRef(false), generation = useRef(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    mounted.current = true
    generation.current++
    const field = key.current
    return () => { mounted.current = false; generation.current++; if (field) field.value = '' }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pendingRef.current || disabled) return
    const epoch = generation.current
    pendingRef.current = true
    const data = new FormData(event.currentTarget)
    const forget = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-forget') === 'true'
    const apiKey = key.current?.value ?? ''
    data.delete('credential')
    if (key.current) key.current.value = ''
    setPending(true); setError('')
    try {
      const settings = await onConfigure({ endpoint: String(data.get('endpoint') ?? ''), model: String(data.get('model') ?? ''),
        ...(forget ? { forgetKey: true } : apiKey ? { apiKey } : {}) })
      if (mounted.current && generation.current === epoch) onChange?.(settings)
    } catch {
      // Provider errors must not echo credentials or the submitted request.
      if (mounted.current && generation.current === epoch) setError('Could not save provider settings. Check the HTTPS URL and model ID.')
    } finally {
      pendingRef.current = false
      if (mounted.current && generation.current === epoch) setPending(false)
    }
  }
  return <form className="explanation-provider" onSubmit={submit} key={provider.endpoint + '|' + provider.model}>
    <p>Optional online explanations use your configured provider. Offline editing and lessons work independently.</p>
    <label>Provider base URL<input name="endpoint" type="url" defaultValue={provider.endpoint} maxLength={500} required disabled={disabled || pending}/></label>
    <label>Model ID<input name="model" defaultValue={provider.model} maxLength={120} required disabled={disabled || pending}/></label>
    <label>API key<input ref={key} name="credential" type="password" autoComplete="off" spellCheck={false} maxLength={4096}
      placeholder={provider.hasKey ? 'Key saved locally' : 'Enter your provider key'} disabled={disabled || pending}/></label>
    <div className="explanation-actions"><button className="button" disabled={disabled || pending} type="submit">Save Provider</button>
      {provider.hasKey && <button className="button" disabled={disabled || pending} type="submit" data-forget="true">Forget Key</button>}</div>
    {error && <p role="alert" className="explanation-error">{error}</p>}
  </form>
}
