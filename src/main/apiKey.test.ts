import { describe, expect, it } from 'vitest'
import {
  apiKeyEnv,
  displayModel,
  isClaudeModelWarning,
  isInvalidKeyError,
  maskEnv,
  maskSecret,
  resolveApiKeyConfig,
  stripCredentials,
  validateApiKeyConfig
} from './apiKey'

describe('apiKeyEnv', () => {
  it('claude official uses ANTHROPIC_API_KEY only', () => {
    expect(apiKeyEnv('claude', { provider: 'official' }, 'sk-ant-x', '')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' })
  })
  it('claude deepseek sets endpoint, bearer token, models and preset env', () => {
    const env = apiKeyEnv('claude', resolveApiKeyConfig('claude', { provider: 'deepseek' }), 'sk-d', '')
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-d',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432'
    })
  })
  it('account defaultModel overrides the first preset model', () => {
    const env = apiKeyEnv('claude', resolveApiKeyConfig('claude', { provider: 'deepseek' }), 'k', 'deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-flash')
  })
  it('custom uses its own models for every slot', () => {
    const env = apiKeyEnv('claude', { provider: 'custom', baseUrl: 'https://x.test/anthropic', models: ['m1', 'm2'] }, 'k', '')
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://x.test/anthropic',
      ANTHROPIC_MODEL: 'm1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm1',
      CLAUDE_CODE_SUBAGENT_MODEL: 'm1'
    })
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
  })
  it('codex uses CODEX_API_KEY, gemini uses GEMINI_API_KEY', () => {
    expect(apiKeyEnv('codex', { provider: 'official' }, 'sk-o', '')).toEqual({ CODEX_API_KEY: 'sk-o' })
    expect(apiKeyEnv('gemini', { provider: 'official' }, 'AIza', '')).toEqual({ GEMINI_API_KEY: 'AIza' })
  })
})

describe('stripCredentials (Review Focus 5)', () => {
  it('drops inherited credential vars of that kind only', () => {
    const base = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://evil', ANTHROPIC_API_KEY: 'a', CODEX_API_KEY: 'c', GEMINI_API_KEY: 'g' }
    expect(stripCredentials('claude', base)).toEqual({ PATH: '/bin', CODEX_API_KEY: 'c', GEMINI_API_KEY: 'g' })
    expect(stripCredentials('codex', base)).not.toHaveProperty('CODEX_API_KEY')
    expect(stripCredentials('gemini', base)).not.toHaveProperty('GEMINI_API_KEY')
  })
})

describe('masking (Review Focus 2)', () => {
  it('keeps first 3 and last 4 chars', () => expect(maskSecret('sk-1234567890abcd')).toBe('sk-…abcd'))
  it('fully masks short values', () => expect(maskSecret('short')).toBe('••••'))
  it('masks secret vars, including ones from extraEnv, and leaves others', () => {
    expect(maskEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-1234567890abcd', OPENAI_API_KEY: 'sk-abcdefghijkl', HOME: '/h' })).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-…abcd',
      OPENAI_API_KEY: 'sk-…ijkl',
      HOME: '/h'
    })
  })
})

describe('validateApiKeyConfig (Review Focus 3)', () => {
  it('normalizes custom baseUrl', () => {
    const c = { provider: 'custom' as const, baseUrl: '  https://h.test/anthropic/ ', models: ['m'] }
    expect(validateApiKeyConfig('claude', c)).toBeNull()
    expect(c.baseUrl).toBe('https://h.test/anthropic')
  })
  it('rejects non-http(s), missing models, third-party on codex/gemini', () => {
    expect(validateApiKeyConfig('claude', { provider: 'custom', baseUrl: 'ftp://h', models: ['m'] })).toBe('apikey.badUrl')
    expect(validateApiKeyConfig('claude', { provider: 'custom', baseUrl: 'https://h', models: [] })).toBe('apikey.noModels')
    expect(validateApiKeyConfig('codex', { provider: 'deepseek' })).toBe('apikey.badProvider')
  })
})

describe('helpers', () => {
  it('displayModel strips [1m]', () => expect(displayModel('deepseek-flash[1m]')).toBe('deepseek-flash'))
  it('recognizes invalid-key errors from all three vendors', () => {
    for (const s of ['Invalid API key · Fix external API key', '401 Unauthorized: invalid_api_key', 'Error 400, Message: API key not valid.'])
      expect(isInvalidKeyError(s)).toBe(true)
    expect(isInvalidKeyError('rate limited')).toBe(false)
  })
  it('recognizes Claude unknown-model warnings', () => {
    expect(isClaudeModelWarning('[claude-code:unrecognized_model] {"model":"deepseek-flash"}')).toBe(true)
    expect(isClaudeModelWarning(`Claude Code doesn't recognize the model "deepseek-flash", so it assumes …`)).toBe(true)
    expect(isClaudeModelWarning('Error: boom')).toBe(false)
  })
})
