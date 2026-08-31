// Publishes agents/<AGENT>.jsonc to AssemblyAI and records the resulting id.
// Re-running updates the same agent in place (PUT) rather than creating a copy.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(join(ROOT, '.env')) } catch {}
const BASE = 'https://agents.assemblyai.com'
const AGENT = process.env.AGENT ?? 'ronda'
const API_KEY = process.env.ASSEMBLYAI_API_KEY

if (!API_KEY) { console.error('ASSEMBLYAI_API_KEY is not set.'); process.exit(1) }

// Strip // and /* */ comments without touching anything inside a string.
export function stripJsonComments(src) {
  let out = ''
  let inString = false, escaped = false, line = false, block = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1]
    if (line) { if (c === '\n') { line = false; out += c } continue }
    if (block) { if (c === '*' && next === '/') { block = false; i++ } continue }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { line = true; i++; continue }
    if (c === '/' && next === '*') { block = true; i++; continue }
    out += c
  }
  return out
}

async function main() {
  const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')
  const secret = process.env.TOOL_SECRET ?? ''

  const raw = await readFile(join(ROOT, 'agents', `${AGENT}.jsonc`), 'utf8')
  const config = JSON.parse(stripJsonComments(raw))

  const usesTools = JSON.stringify(config).includes('{{PUBLIC_URL}}')
  if (usesTools && !publicUrl) {
    console.error('PUBLIC_URL is not set, but the agent defines HTTP tools.')
    console.error('AssemblyAI calls tools from its own servers and blocks private/loopback')
    console.error('addresses, so localhost will not work. Expose the server over HTTPS first.')
    process.exit(1)
  }
  if (publicUrl && !publicUrl.startsWith('https://')) {
    console.error(`PUBLIC_URL must be https, got: ${publicUrl}`)
    process.exit(1)
  }

  const body = JSON.parse(
    JSON.stringify(config).replaceAll('{{PUBLIC_URL}}', publicUrl).replaceAll('{{TOOL_SECRET}}', secret),
  )

  const existing = process.env.AGENT_ID
  const res = await fetch(existing ? `${BASE}/v1/agents/${existing}` : `${BASE}/v1/agents`, {
    method: existing ? 'PUT' : 'POST',
    headers: { authorization: API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error(`${existing ? 'PUT' : 'POST'} /v1/agents -> ${res.status}`)
    console.error(text.slice(0, 1200))
    process.exit(1)
  }

  const agent = JSON.parse(text)
  console.log(`${existing ? 'updated' : 'created'} agent ${agent.id} (${agent.name})`)

  if (!existing) {
    const envPath = join(ROOT, '.env')
    const env = await readFile(envPath, 'utf8')
    await writeFile(envPath, env.replace(/^AGENT_ID=.*$/m, `AGENT_ID=${agent.id}`), { mode: 0o600 })
    console.log('wrote AGENT_ID to .env')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
