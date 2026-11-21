import type { AgentMuxApi } from './index'

declare global {
  interface Window {
    agentmux: AgentMuxApi
  }
}

export {}
