import type {
  CrashCategory,
  CrashContext,
  FixAction,
  FixActionKind,
} from '@shared/crash'

export interface CrashRule {
  id: string
  category: Exclude<CrashCategory, 'unknown'>
  confidence: 'high' | 'medium'
  title: string
  phenomenon: string
  cause: string
  patterns: RegExp[]
  priority: number
}

export interface RuleMatch {
  rule: CrashRule
  evidence: string[]
  lastIndex: number
}

function action(
  rule: CrashRule,
  kind: FixActionKind,
  label: string,
  description: string,
  risk: FixAction['risk'],
  params: Record<string, unknown> = {},
): FixAction {
  return {
    id: `${rule.id}-${kind}`,
    kind,
    label,
    description,
    risk,
    automatic: kind !== 'manual',
    params,
  }
}

function suggestedJava(ctx: CrashContext, evidence: string[]): number {
  for (const line of [...evidence].reverse()) {
    const requires = line.match(/requires Java\s*(\d+)/i)
    if (requires) return Number(requires[1])
    const classFile = line.match(/class file version\s+(\d+)/i)
    if (classFile) return Math.max(8, Number(classFile[1]) - 44)
  }
  const version = ctx.mcVersion ?? ''
  const minor = Number(version.split('.')[1] ?? 0)
  const patch = Number(version.split('.')[2] ?? 0)
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 17) return 17
  return 8
}

export const CRASH_RULES: CrashRule[] = [
  {
    id: 'java',
    category: 'java-version',
    confidence: 'high',
    title: 'Java 版本不匹配',
    phenomenon: '启动时出现 UnsupportedClassVersionError / class file version / requires Java。',
    cause: '当前选择的 Java 版本低于游戏或模组编译时使用的版本。',
    priority: 10,
    patterns: [
      /UnsupportedClassVersionError/i,
      /Unsupported major\.minor version/i,
      /class file version \d+/i,
      /requires Java \d+/i,
      /compiled by a more recent version/i,
      /Java version .* is not supported/i,
    ],
  },
  {
    id: 'missing-library',
    category: 'missing-library',
    confidence: 'high',
    title: '缺失库或类文件',
    phenomenon: '日志出现 NoClassDefFoundError、ClassNotFoundException、Failed to find library 或找不到主类。',
    cause: '版本库/模组依赖文件缺失、下载不完整，或前置模组未安装。',
    priority: 20,
    patterns: [
      /NoClassDefFoundError/i,
      /ClassNotFoundException/i,
      /Failed to find library/i,
      /Could not find or load main class/i,
      /java\.lang\.module\.FindException/i,
      /UnsatisfiedLinkError/i,
    ],
  },
  {
    id: 'mod-conflict',
    category: 'mod-conflict',
    confidence: 'medium',
    title: '模组冲突或缺失前置',
    phenomenon: '日志出现 Mixin apply failed、Duplicate mods、Mod requires 或 ModLoadingException。',
    cause: '两个模组修改同一处代码、前置模组缺失，或模组与当前加载器/游戏版本不兼容。',
    priority: 30,
    patterns: [
      /Mixin apply failed/i,
      /MixinTransformerError/i,
      /Incompatible mod set/i,
      /Duplicate mods?/i,
      /Mod .* requires .* which is missing/i,
      /ModLoadingException/i,
      /fml\.modloading/i,
      /Missing or unsupported mandatory dependencies/i,
      /NoSuchMethodError/i,
      /NoSuchFieldError/i,
      /ModResolutionException/i,
    ],
  },
  {
    id: 'memory',
    category: 'out-of-memory',
    confidence: 'high',
    title: '内存不足',
    phenomenon: '日志出现 OutOfMemoryError、Java heap space 或 unable to allocate bytes。',
    cause: '分配给游戏的堆内存不足，或模组/资源包一次性占用过多内存。',
    priority: 15,
    patterns: [
      /java\.lang\.OutOfMemoryError/i,
      /Java heap space/i,
      /GC overhead limit exceeded/i,
      /unable to allocate .* bytes/i,
      /insufficient memory/i,
      /Could not reserve enough space for object heap/i,
    ],
  },
  {
    id: 'graphics',
    category: 'graphics-driver',
    confidence: 'medium',
    title: '显卡/OpenGL 初始化失败',
    phenomenon: '日志出现 GLFW/OpenGL/WGL 错误、Pixel format not accelerated 或无法创建显示窗口。',
    cause: '显卡驱动过旧、OpenGL 不可用，或光影/渲染类模组与当前驱动不兼容。',
    priority: 25,
    patterns: [
      /GLFW error/i,
      /Pixel format not accelerated/i,
      /Failed to create display/i,
      /OpenGL.*(?:error|not supported)/i,
      /WGL: (?:Failed|The driver)/i,
      /Could not initialize GL/i,
      /GL_INVALID/i,
      /GLException/i,
      /No OpenGL context/i,
      /Failed to create window/i,
    ],
  },
  {
    id: 'auth',
    category: 'auth-failed',
    confidence: 'high',
    title: '正版/会话验证失败',
    phenomenon: '日志出现 AuthenticationException、Invalid credentials、Failed to verify username 或 401。',
    cause: '登录令牌过期、账户会话失效，或 Microsoft/服务器认证暂时不可用。',
    priority: 18,
    patterns: [
      /AuthenticationException/i,
      /Failed to verify username/i,
      /Invalid credentials/i,
      /authentication servers? (?:are|is) down/i,
      /401 Unauthorized/i,
      /Authentication failed/i,
      /Failed to login/i,
      /Invalid session/i,
      /Multiplayer authentication/i,
    ],
  },
  {
    id: 'corrupt',
    category: 'corrupt-files',
    confidence: 'high',
    title: '游戏文件损坏',
    phenomenon: '日志出现 ZipException、invalid LOC header、Corrupted 或无效的 jar/资源文件。',
    cause: '客户端 jar、库或资源文件下载不完整/被篡改，导致无法读取。',
    priority: 22,
    patterns: [
      /java\.util\.zip\.ZipException/i,
      /invalid LOC header/i,
      /Invalid or corrupt jarfile/i,
      /Corrupted(?: file| zip| jar)?/i,
      /invalid distance too far/i,
      /Error reading .*\.jar/i,
      /EOFException/i,
      /Unexpected end of ZLIB input stream/i,
      /invalid CEN header/i,
      /Zip file is corrupt/i,
      /corrupt jar/i,
      /checksum mismatch/i,
    ],
  },
  {
    id: 'port',
    category: 'port-in-use',
    confidence: 'high',
    title: '端口被占用',
    phenomenon: '日志出现 Address already in use、BindException 或 Failed to bind to port。',
    cause: '上一次游戏进程尚未退出，或其它程序占用了需要监听的端口。',
    priority: 24,
    patterns: [
      /Address already in use/i,
      /java\.net\.BindException/i,
      /Failed to bind to port/i,
      /port .* already in use/i,
      /Cannot assign requested address/i,
    ],
  },
  {
    id: 'jvm-args',
    category: 'jvm-args',
    confidence: 'medium',
    title: 'JVM 启动参数错误',
    phenomenon: '日志出现 Unrecognized VM option、Invalid heap size 或 Could not create the Java Virtual Machine。',
    cause: '实例的 JVM 参数包含当前 Java 不支持的选项，或内存参数无效。',
    priority: 26,
    patterns: [
      /Unrecognized VM option/i,
      /Invalid (?:maximum|initial) heap size/i,
      /Could not create the Java Virtual Machine/i,
      /Too small maximum heap/i,
      /Error: Could not find or load main class/i,
    ],
  },
]

export function actionsFor(rule: CrashRule, ctx: CrashContext, evidence: string[]): FixAction[] {
  const commonExport = action(
    rule,
    'export-diagnostics',
    '导出诊断包',
    '把本次分析、原始日志和实例信息打包，便于发到求助群/论坛。',
    'safe',
  )
  switch (rule.category) {
    case 'java-version': {
      const major = suggestedJava(ctx, evidence)
      return [
        action(rule, 'set-java', `改用 Java ${major}`, `把本实例的 Java 选择切换为 Java ${major}，下次启动生效。`, 'safe', { major }),
        action(rule, 'open-url', '打开 Java 下载页', '如果本机没有对应 Java，打开 Adoptium 下载页。', 'safe', {
          url: 'https://adoptium.net/temurin/releases/',
        }),
        commonExport,
      ]
    }
    case 'missing-library':
    case 'corrupt-files':
      return [
        action(rule, 'repair-files', '校验并重下文件', '调用安装链校验缺失/损坏的版本文件并重新下载。', 'caution', {
          versionId: ctx.mcVersion ?? '',
        }),
        action(rule, 'open-folder', '打开实例目录', '检查 mods 目录是否有半下载的 jar。', 'safe', { area: 'mods' }),
        commonExport,
      ]
    case 'mod-conflict':
      return [
        action(rule, 'disable-mods', '进入安全模式', '暂时禁用本实例全部模组；可随后一键恢复。', 'caution'),
        action(rule, 'open-folder', '打开 mods 目录', '查看最近新增的模组，逐个排查冲突。', 'safe', { area: 'mods' }),
        action(rule, 'restore-mods', '恢复模组', '撤销安全模式，恢复之前被禁用的模组。', 'safe'),
        commonExport,
      ]
    case 'out-of-memory': {
      const current = ctx.memory?.maxMb ?? 4096
      const next = Math.min(16_384, Math.max(4096, current + 2048))
      return [
        action(rule, 'set-memory', `提高内存到 ${next} MB`, `把本实例最大内存从 ${current} MB 调整为 ${next} MB。`, 'safe', {
          minMb: Math.min(1024, next),
          maxMb: next,
        }),
        action(rule, 'open-folder', '打开日志目录', '查看是否持续出现 OutOfMemoryError。', 'safe', { area: 'logs' }),
        commonExport,
      ]
    }
    case 'graphics-driver':
      return [
        action(rule, 'open-url', '打开显卡驱动下载页', '优先更新 NVIDIA/AMD/Intel 官方驱动后重试。', 'safe', {
          url: 'https://www.nvidia.com/Download/index.aspx',
        }),
        action(rule, 'disable-mods', '安全模式（禁用模组）', '如果安装过光影/渲染模组，先禁用全部模组定位问题。', 'caution'),
        action(rule, 'restore-mods', '恢复模组', '撤销安全模式。', 'safe'),
        commonExport,
      ]
    case 'auth-failed':
      return [
        action(rule, 'open-url', '打开 Minecraft 登录页', '重新登录正版账户；离线账户请先在账户页切换。', 'safe', {
          url: 'https://www.minecraft.net/login',
        }),
        action(rule, 'open-folder', '打开日志目录', '确认认证失败的完整堆栈。', 'safe', { area: 'logs' }),
        commonExport,
      ]
    case 'port-in-use':
      return [
        action(rule, 'copy-text', '复制端口排查命令', '在 PowerShell 中运行，找出占用端口的进程。', 'manual', {
          text: 'Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Format-Table LocalAddress,LocalPort,OwningProcess',
        }),
        action(rule, 'manual', '关闭上一个游戏进程', '若日志是上次启动残留，结束 java.exe 后重试；不要结束正在使用的其它程序。', 'manual'),
        commonExport,
      ]
    case 'jvm-args':
      return [
        action(rule, 'manual', '重置 JVM 参数', '在实例设置中清空自定义 JVM 参数，尤其是 -Xmx/-Xms/--add-opens 之外的选项。', 'manual'),
        action(rule, 'set-memory', '恢复安全内存', '把内存恢复为 4096 MB 后重试。', 'safe', { minMb: 1024, maxMb: 4096 }),
        commonExport,
      ]
    default:
      return [commonExport]
  }
}
