// Agent 适配器公共元数据 —— 与 GPTZZZ 逆向结论对齐（见 README「逆向结论」一节）
export const AGENT_META = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    platform: 'anthropic',
    envVar: 'CLAUDE_CONFIG_DIR',
    defaultDirName: '.claude',
    mainFile: 'settings.json',
    altFile: 'claude.json',
    experimental: false,
    hint: '重启 Claude Code 会话后生效',
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    platform: 'openai',
    envVar: 'CODEX_HOME',
    defaultDirName: '.codex',
    mainFile: 'config.toml',
    extraFiles: ['auth.json'],
    experimental: false,
    hint: '重启 Codex 后生效；写入时会移除 auth.json 以强制 API Key 鉴权',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    platform: 'gemini',
    envVar: 'GEMINI_CLI_HOME',
    defaultDirName: '.gemini',
    mainFile: '.env',
    experimental: false,
    hint: '重启 Gemini CLI 后生效',
  },
  grok: {
    id: 'grok',
    name: 'Grok Build',
    platform: 'grok',
    envVar: 'GROK_CONFIG_DIR',
    defaultDirName: '.grok',
    mainFile: 'config.toml',
    experimental: true,
    hint: '实验支持：重启 Grok Build 后生效',
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    platform: 'openclaw',
    envVar: 'OPENCLAW_CONFIG_DIR',
    defaultDirName: '.openclaw',
    mainFile: 'openclaw.json',
    experimental: true,
    hint: '实验支持：重启 OpenClaw 后生效',
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    platform: 'hermes',
    envVar: 'HERMES_CONFIG_DIR',
    defaultDirName: '.hermes',
    mainFile: 'config.yaml',
    winLocalAppData: 'hermes',
    experimental: true,
    hint: '实验支持：重启 Hermes 后生效',
  },
};

export const AGENT_IDS = Object.keys(AGENT_META);

export const APP_PROTOCOLS = {
  newapi: {
    id: 'newapi',
    name: 'new-api / one-api 系（绝大多数中转站）',
    needsLogin: true,
  },
  sub2api: {
    id: 'sub2api',
    name: 'Sub2API（订阅号池：Claude/OpenAI/Gemini/Grok 统一转 API）',
    needsLogin: true,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic 直连（官方 / anthropic 协议透传）',
    needsLogin: false,
  },
  generic: {
    id: 'generic',
    name: '通用（手动粘贴 Key / 官方 API）',
    needsLogin: false,
  },
};

export const QUOTA_PER_UNIT_DEFAULT = 500000; // new-api 默认 $1 = 500000 quota
