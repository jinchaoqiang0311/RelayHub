import { runningAgents } from '../src/main/services/procs.js';
import { AGENT_IDS } from '../src/shared/constants.js';
const r = await runningAgents(AGENT_IDS);
console.log('运行中的 agent:', r.length ? r.join(', ') : '(无)');
process.exit(0);
