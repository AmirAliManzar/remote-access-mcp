export type AgentProfileId = 'explorer' | 'planner' | 'implementer' | 'tester' | 'reviewer' | 'security' | 'deployer';

export interface AgentProfile {
  id: AgentProfileId;
  description: string;
  allowedScopes: string[];
  defaultAutonomy: 'readonly' | 'safe' | 'supervised' | 'autonomous';
}

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
  explorer: { id: 'explorer', description: 'Read-only environment and project inspection.', allowedScopes: ['system','logs','project','diagnostics','monitoring','filesystem','database','resources','context','router','intelligence','integrations','browser','infrastructure'], defaultAutonomy: 'readonly' },
  planner: { id: 'planner', description: 'Read-only discovery and workflow planning.', allowedScopes: ['system','logs','project','diagnostics','filesystem','database','resources','context','router','intelligence','planning','integrations'], defaultAutonomy: 'readonly' },
  implementer: { id: 'implementer', description: 'Controlled implementation using filesystem, git, jobs and planning tools.', allowedScopes: ['filesystem','git','jobs','planning','diagnostics','project','intelligence','browser','infrastructure'], defaultAutonomy: 'safe' },
  tester: { id: 'tester', description: 'Run diagnostics and tests with bounded shell/job access.', allowedScopes: ['shell','jobs','filesystem','project','diagnostics','system','intelligence','browser','infrastructure'], defaultAutonomy: 'safe' },
  reviewer: { id: 'reviewer', description: 'Read-only quality and regression review.', allowedScopes: ['filesystem','git','project','diagnostics','security','logs','system','database','resources','context','router','intelligence','integrations','browser','infrastructure'], defaultAutonomy: 'readonly' },
  security: { id: 'security', description: 'Read-only security and policy analysis.', allowedScopes: ['security','filesystem','project','logs','system','diagnostics','resources','context','router','intelligence','integrations','browser','infrastructure'], defaultAutonomy: 'readonly' },
  deployer: { id: 'deployer', description: 'Supervised deployment and service/package operations.', allowedScopes: ['filesystem','shell','git','jobs','transfer','planning','services','packages','diagnostics','monitoring','project','browser','infrastructure'], defaultAutonomy: 'supervised' },
};

export function getAgentProfile(id: string): AgentProfile | undefined { return AGENT_PROFILES[id as AgentProfileId]; }
export function listAgentProfiles(): AgentProfile[] { return Object.values(AGENT_PROFILES); }
