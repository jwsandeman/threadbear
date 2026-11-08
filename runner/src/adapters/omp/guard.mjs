// Installed explicitly even with extension discovery disabled. Errors block the call.
import fs from 'node:fs';

export default function threadbearGuard(pi) {
  const policyFile = process.env.THREADBEAR_OMP_POLICY;
  const readPolicy = () => {
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    if (!['full', 'ask', 'auto'].includes(policy.mode) || typeof policy.nonce !== 'string' || !Array.isArray(policy.hostTools)) {
      throw new Error('Threadbear approval policy is unavailable');
    }
    return policy;
  };
  readPolicy();
  pi.on('session_start', (_event, ctx) => {
    const policy = readPolicy();
    if (ctx.agent?.kind !== 'sub') ctx.ui.notify(`threadbear-guard-ready:${policy.nonce}`, 'info');
  });
  // OMP 18.18 resets its active tools before a prompt, dropping newly registered host tools.
  pi.on('before_agent_start', async () => {
    const policy = readPolicy();
    const active = pi.getActiveTools();
    const missing = policy.hostTools.filter((name) => !active.includes(name));
    if (missing.length) await pi.setActiveTools([...active, ...missing]);
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      const policy = readPolicy();
      if (policy.mode === 'full') return;
      const input = event.input ?? {};
      // Host tools are validated and gated in the runner, including calls by children.
      if (policy.hostTools.includes(event.toolName)) return;
      if (['grep', 'glob', 'ask', 'todo'].includes(event.toolName)) return;
      if (event.toolName === 'task')
        return { block: true, reason: 'Oh My Pi subagents are unavailable in Ask mode. Perform the task in this thread so Threadbear can approve each action.' };
      if (event.toolName === 'read' && typeof input.path === 'string' && !input.path.includes('://')) return;
      // Headless children cannot ask Threadbear: their mutating calls fail closed.
      if (!ctx.hasUI || ctx.agent?.kind === 'sub') return { block: true, reason: 'Threadbear requires approval for this subagent tool. Ask the parent to perform the action.' };
      const request = JSON.stringify({ nonce: policy.nonce, toolCallId: event.toolCallId, name: event.toolName, input });
      if (!(await ctx.ui.confirm('Threadbear tool approval', request))) return { block: true, reason: 'The user denied this tool call.' };
    } catch {
      return { block: true, reason: 'Threadbear could not verify approval for this tool call.' };
    }
  });
}
