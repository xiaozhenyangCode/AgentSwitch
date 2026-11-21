import type { AgentSwitchApi } from './index'

declare global {
  interface Window {
    agentswitch: AgentSwitchApi
  }
}

export {}
