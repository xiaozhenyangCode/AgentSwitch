/**
 * AgentSwitch was called AgentMux: its localStorage keys (`agentmux.*`: draft, sidebar
 * width, settings) are copied to `agentswitch.*` once. Old keys are left in place.
 * Imported first in main.tsx, before any store reads localStorage at module load.
 */
try {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
  for (const key of keys) {
    // Chat storage reads the old key directly only until its backup exists.
    if (!key?.startsWith('agentmux.') || key === 'agentmux.threads.v2') continue
    const next = 'agentswitch.' + key.slice('agentmux.'.length)
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? '')
  }
} catch {
  /* storage unavailable */
}

export {}
