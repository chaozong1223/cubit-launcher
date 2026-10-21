import { AppError } from '@shared/errors'

export const MCE_REVIEW_URL = 'https://aka.ms/mce-reviewappid'

export type AuthStage =
  | 'devicecode'
  | 'token'
  | 'refresh'
  | 'xbl'
  | 'xsts'
  | 'mc-login'
  | 'profile'
  | 'network'
  | 'storage'

export interface AuthFailureInput {
  stage: AuthStage
  status?: number
  error?: string
  errorDescription?: string
  xerr?: string | number | null
}

export interface AuthFailure {
  code: string
  message: string
  hint: string
  docs?: string
  retryable: boolean
  aadsts: string | null
}

function aadstsOf(description: string | undefined, error: string | undefined): string | null {
  const match = /AADSTS\d+/.exec(`${description ?? ''} ${error ?? ''}`)
  return match ? match[0] : null
}

/**
 * Maps the five observed Microsoft / Minecraft pre-conditions (plus the common
 * token/session failures) to Chinese, actionable errors. The raw AADSTS code is
 * kept in details for bug reports; no token ever reaches this function.
 */
export function classifyAuthFailure(input: AuthFailureInput): AuthFailure {
  const aadsts = aadstsOf(input.errorDescription, input.error)
  const description = input.errorDescription ?? ''
  const error = input.error ?? ''

  if (error === 'MS_CLIENT_ID_MISSING') {
    return {
      code: 'MS_CLIENT_ID_MISSING',
      message: '未配置微软应用 ID，正版登录暂不可用',
      hint: '设置环境变量 MCL_MS_CLIENT_ID（并可选 MCL_MS_TENANT），或在设置页填入 Azure 应用的客户端 ID；离线账户可正常使用。',
      docs: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
      retryable: false,
      aadsts,
    }
  }

  if (aadsts === 'AADSTS650053' || /650053/.test(description)) {
    return {
      code: 'MS_AUTH_NOT_APPROVED',
      message: '微软应用尚未获得 Xbox Live 权限，正版登录暂不可用',
      hint: `请到 ${MCE_REVIEW_URL} 提交 Minecraft API 审批；审批通过前请使用离线账户或 Authlib 账户。`,
      docs: MCE_REVIEW_URL,
      retryable: false,
      aadsts,
    }
  }

  if (aadsts === 'AADSTS70002' || /client must be.*mobile|public client/i.test(description)) {
    return {
      code: 'AUTH.AADSTS70002',
      message: '微软应用未启用公共客户端流',
      hint: 'Azure 门户 → 应用 → 身份验证 → “允许公共客户端流”设为“是”；应用清单 isFallbackPublicClient=true，保存后重试。',
      retryable: false,
      aadsts,
    }
  }

  if (aadsts === 'AADSTS50149' || /AADSTS50149/.test(description)) {
    return {
      code: 'AUTH.AADSTS50149',
      message: '微软拒绝了 PKCE 参数（租户/账号类型不匹配）',
      hint: '设备码流程不要发送 PKCE/code_challenge；请确认 tenant 使用创建应用的租户 ID，而不是 /common。',
      retryable: false,
      aadsts,
    }
  }

  if (error === 'unauthorized_client' || aadsts === 'AADSTS700016') {
    return {
      code: 'AUTH.UNAUTHORIZED_CLIENT',
      message: '微软登录租户路由错误：该入口找不到应用',
      hint: '把 tenant 设为创建应用的租户 ID（如 ff6186d9-…）或域名，不要使用 common/consumers 入口。',
      retryable: false,
      aadsts,
    }
  }

  if (input.xerr !== undefined && input.xerr !== null) {
    const xerr = String(input.xerr)
    if (xerr === '2148916233') {
      return {
        code: 'AUTH.XSTS_NO_XBOX',
        message: '该微软账号还没有 Xbox 档案',
        hint: '请先在 xbox.com 创建 Xbox 档案，再回来登录。',
        retryable: false,
        aadsts,
      }
    }
    if (xerr === '2148916235') {
      return {
        code: 'AUTH.XSTS_REGION',
        message: '该地区不支持 Xbox Live',
        hint: '请更换账号地区或使用离线账户。',
        retryable: false,
        aadsts,
      }
    }
    if (['2148916236', '2148916237', '2148916238'].includes(xerr)) {
      return {
        code: 'AUTH.XSTS_CHILD',
        message: '未成年账号需要家长授权',
        hint: '请让家长在 Microsoft 家庭中为该账号授权后重试。',
        retryable: false,
        aadsts,
      }
    }
  }

  if (input.stage === 'profile' || input.stage === 'mc-login') {
    if (input.status === 403) {
      return {
        code: 'MS_AUTH_NOT_APPROVED',
        message: 'Minecraft 服务拒绝访问（403）：应用未获批或账号未拥有游戏',
        hint: `确认已购买 Minecraft Java Edition；应用需通过 MCE 审批（${MCE_REVIEW_URL}）。刚购买可等待 24 小时再试。`,
        docs: MCE_REVIEW_URL,
        retryable: false,
        aadsts,
      }
    }
    if (input.status === 404) {
      return {
        code: 'AUTH.NO_PROFILE',
        message: '该微软账号没有 Minecraft Java Edition 档案',
        hint: '请确认使用已购买 Java 版的账号，或改用离线账户。',
        retryable: false,
        aadsts,
      }
    }
  }

  if (error === 'invalid_grant' || aadsts === 'AADSTS70008' || aadsts === 'AADSTS700082') {
    return {
      code: 'AUTH.INVALID_GRANT',
      message: '登录已过期，需要重新登录',
      hint: '刷新令牌已失效；请重新开始微软设备码登录。',
      retryable: false,
      aadsts,
    }
  }

  if (error === 'expired_token' || aadsts === 'AADSTS700030') {
    return {
      code: 'AUTH.DEVICE_CODE_EXPIRED',
      message: '设备码已过期',
      hint: '请重新点击“微软登录”获取新的设备码。',
      retryable: true,
      aadsts,
    }
  }

  if (input.stage === 'network') {
    return {
      code: 'AUTH.NETWORK',
      message: '无法连接微软登录服务',
      hint: '检查网络/代理后重试；本机 IPv4 可能不可用，可尝试关闭代理或启用 IPv6。',
      retryable: true,
      aadsts,
    }
  }

  return {
    code: 'AUTH.MICROSOFT_FAILED',
    message: '微软登录失败',
    hint: '请重试；若持续失败，请查看日志中的 AADSTS/XErr 代码并参考 docs/02 §3.1.1。',
    retryable: true,
    aadsts,
  }
}

export function toAuthError(input: AuthFailureInput): AppError {
  const failure = classifyAuthFailure(input)
  return new AppError(failure.code, failure.message, {
    retryable: failure.retryable,
    details: {
      hint: failure.hint,
      ...(failure.docs ? { docs: failure.docs } : {}),
      ...(failure.aadsts ? { aadsts: failure.aadsts } : {}),
      stage: input.stage,
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  })
}

export function appError(
  code: string,
  message: string,
  options: { hint?: string; docs?: string; retryable?: boolean; details?: Record<string, unknown> } = {},
): AppError {
  return new AppError(code, message, {
    retryable: options.retryable ?? false,
    details: {
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.docs ? { docs: options.docs } : {}),
      ...(options.details ?? {}),
    },
  })
}
