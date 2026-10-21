/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (http/https/fs) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
/**
 * 服务端点（v2.9.0）：把「连到哪个 DSH」收敛成**一个事实源**。
 *
 * 背景：DSH 0.2.1-rc.2 的 `dsh --profile web` 支持 `--host <本机 IPv4/IPv6 字面量>` 与
 * `--tls-cert/--tls-key`（原生 HTTPS）。插件旧版把 `127.0.0.1` 写死在探活、端口占用识别、
 * Node HTTP 请求、iframe 地址、postMessage targetOrigin、AED 启动校验里——用户改用自定义
 * 地址后，插件探测 127.0.0.1 失败 ⇒ 判服务离线、重复拉起、面板打不开。
 *
 * 本模块只做三件事：①把设置归一成 {@link ServiceEndpoint}；②由端点派生 URL/展示串/启动参数；
 * ③提供插件 Node 侧**唯一**的 HTTP(S) 出口 {@link endpointRequest}（https 用设置里的 PEM 严格校验）。
 * 浏览器侧（iframe/postMessage）不经过这里，由调用方用 {@link endpointOrigin} 派生。
 */
import { readFileSync } from 'node:fs'
import { request as nodeHttpRequest, type IncomingMessage } from 'node:http'
import { request as nodeHttpsRequest } from 'node:https'

/** 连接协议：DSH 原生 HTTP 或原生 HTTPS（反代场景不支持）。 */
export type ServiceScheme = 'http' | 'https'

/** 一个「连到哪个 DSH」的完整描述（插件内唯一事实源）。 */
export interface ServiceEndpoint {
  scheme: ServiceScheme
  /** 无方括号、无 zone、小写；默认 '127.0.0.1' */
  host: string
  port: number
  /** 仅 https 使用：证书链 PEM 路径，用于 Node 侧校验（也可填签发它的 CA） */
  caCertPath?: string
}

/** 默认服务地址（回环 IPv4）；host 归一失败时一律回退到它。 */
export const DEFAULT_SERVICE_HOST = '127.0.0.1'

/** 端口缺省值（与设置页默认端口一致）。 */
const DEFAULT_SERVICE_PORT = 3080

/** host 归一结果：失败时给出可分类的原因，设置页据此提示。 */
export type HostCheck =
  | { ok: true; host: string }
  | { ok: false; reason: 'empty' | 'scheme' | 'path' | 'port' | 'wildcard' | 'zone' | 'invalid' }

/** 去方括号（`[::1]` → `::1`）；不成对时返回 null。 */
function unwrapBrackets(host: string): string | null {
  if (host.startsWith('[') || host.endsWith(']')) {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : null
  }
  return host
}

/** IPv4 点分四段字面量（每段 0–255，允许前导零）。 */
function isIpv4Literal(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * IPv6 字面量（小写、无 zone、无方括号）：支持 `::` 压缩与省略写法。
 * 不收录 IPv4-mapped（`::ffff:1.2.3.4`）——DSH `--host` 只接受纯 IPv4/IPv6 字面量。
 */
function isIpv6Literal(host: string): boolean {
  if (!host.includes(':') || host.includes(':::')) return false
  const firstDouble = host.indexOf('::')
  if (firstDouble !== -1 && host.indexOf('::', firstDouble + 1) !== -1) return false
  const head = firstDouble === -1 ? host : host.slice(0, firstDouble)
  const tail = firstDouble === -1 ? '' : host.slice(firstDouble + 2)
  const groups = [...(head === '' ? [] : head.split(':')), ...(tail === '' ? [] : tail.split(':'))]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false
  return firstDouble === -1 ? groups.length === 8 : groups.length < 8
}

/**
 * 归一用户填写的服务地址（设置页入参）。
 *
 * 规则：trim、去 `[ ]`、小写；拒绝协议前缀（`http://`）、含 `/ ? # @` 或空白（那是 URL 片段）、
 * 含端口的值（单冒号+数字）、通配地址（`0.0.0.0` / `::`）、带 zone 的 IPv6（`fe80::1%12`）；
 * 其余必须是 `localhost` / IPv4 字面量 / IPv6 字面量，否则 reason='invalid'。
 */
export function normalizeServiceHost(raw: string): HostCheck {
  const input = String(raw ?? '').trim()
  if (input === '') return { ok: false, reason: 'empty' }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) return { ok: false, reason: 'scheme' }
  if (/[\s/?#@]/.test(input)) return { ok: false, reason: 'path' }
  // 端口形态：`127.0.0.1:3080` / `[::1]:3080`（值本身就是 URL 的一部分，不该填进 host 框）
  if (/^\[[^\]]*\]:\d+$/.test(input) || /^[^:[\]%]+:\d+$/.test(input)) {
    return { ok: false, reason: 'port' }
  }
  const unwrapped = unwrapBrackets(input)
  if (unwrapped === null) return { ok: false, reason: 'invalid' }
  const host = unwrapped.toLowerCase()
  if (host === '') return { ok: false, reason: 'invalid' }
  if (host.includes('%')) return { ok: false, reason: 'zone' }
  if (host === '0.0.0.0' || host === '::') return { ok: false, reason: 'wildcard' }
  if (host === 'localhost' || isIpv4Literal(host) || isIpv6Literal(host)) {
    return { ok: true, host }
  }
  return { ok: false, reason: 'invalid' }
}

/** 是否回环地址（127.0.0.0/8、::1、localhost）。 */
export function isLoopbackHost(host: string): boolean {
  const unwrapped = unwrapBrackets(String(host ?? '').trim())
  if (unwrapped === null) return false
  const h = unwrapped.toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** 是否通配地址（绑全部网卡：0.0.0.0 / ::）。DSH `--host` 拒绝这类值，插件也不接受。 */
export function isWildcardHost(host: string): boolean {
  const unwrapped = unwrapBrackets(String(host ?? '').trim())
  if (unwrapped === null) return false
  const h = unwrapped.toLowerCase()
  return h === '0.0.0.0' || h === '::'
}

/** 端口夹紧到 1..65535（非数字回退默认端口）。 */
function clampPort(port: number): number {
  const n = Number(port)
  if (!Number.isFinite(n)) return DEFAULT_SERVICE_PORT
  return Math.min(65535, Math.max(1, Math.trunc(n)))
}

/**
 * 设置片段 → 端点（唯一归一出入口）：
 * 端口夹紧 1..65535；host 非法回退 127.0.0.1；scheme 仅 `https` 生效、其余按 http；
 * TLS 证书路径仅 https 且非空时进 `caCertPath`（http 下不携带，避免陈旧路径误导）。
 */
export function endpointFromSettings(s: {
  port: number
  serviceHost?: string
  serviceScheme?: string
  tlsCertPath?: string
}): ServiceEndpoint {
  const check = normalizeServiceHost(s.serviceHost ?? '')
  const scheme: ServiceScheme = String(s.serviceScheme ?? '').trim().toLowerCase() === 'https' ? 'https' : 'http'
  const caCertPath = String(s.tlsCertPath ?? '').trim()
  const ep: ServiceEndpoint = {
    scheme,
    host: check.ok ? check.host : DEFAULT_SERVICE_HOST,
    port: clampPort(s.port),
  }
  if (scheme === 'https' && caCertPath !== '') ep.caCertPath = caCertPath
  return ep
}

/** URL 主机段：IPv6 自动加方括号（`::1` → `[::1]`）。 */
function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/** `http://[::1]:3080`（IPv6 加方括号；不带结尾斜杠）。 */
export function endpointOrigin(ep: ServiceEndpoint): string {
  return `${ep.scheme}://${hostForUrl(ep.host)}:${String(ep.port)}`
}

/** 给人看的端点串（与 origin 同形；i18n 的 `{addr}` 参数用它）。 */
export function endpointLabel(ep: ServiceEndpoint): string {
  return endpointOrigin(ep)
}

/**
 * 解析 URL → 端点（供 launch URL 自适应用途；非法返回 null）。
 * 端口缺省按 scheme 取 80/443；host 仍走 {@link normalizeServiceHost} 校验（非法字面量一律 null）。
 */
export function endpointFromUrl(url: string): ServiceEndpoint | null {
  let parsed: URL
  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    return null
  }
  const scheme: ServiceScheme | null =
    parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : null
  if (scheme === null) return null
  const check = normalizeServiceHost(parsed.hostname)
  if (!check.ok) return null
  const port = parsed.port !== '' ? Number(parsed.port) : scheme === 'https' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { scheme, host: check.host, port }
}

/**
 * 参数加引号（含空白或引号时用 "..."，内部 `"` 转义为 `\"`）。
 * Windows 路径里的反斜杠原样保留——只有 `\"` 这一种转义对 cmd 有意义。
 */
export function quoteCommandArg(value: string): string {
  const raw = String(value ?? '')
  if (!/[\s"]/.test(raw)) return raw
  return `"${raw.replaceAll('"', '\\"')}"`
}

/**
 * 纯函数：给启动命令补上端点参数（v2.9.2 起**插件生成命令与用户自定义命令共用**）：
 * - host ≠ 127.0.0.1 → 追加 `--host <host>`（已有 `--host` 不重复、不覆盖）；
 * - scheme=https 且 cert/key 都非空 → 追加 `--tls-cert "<cert>" --tls-key "<key>"`（带引号；
 *   已有任一同名 flag 则整对跳过，避免半截覆盖）；
 * - 默认回环 http 命令逐字返回（历史行为不变）。
 *
 * 为什么 v2.9.2 改成也处理自定义命令：v2.9.0 起「服务地址/协议/TLS」是端点事实源，但旧实现只给
 * 插件生成的命令附加参数；一旦设置里存着 `dsh web --port {port} --no-open`（一键检测配置会写入），
 * 这些设置就**静默失效**——DSH 仍绑 127.0.0.1 明文，插件却按 https/局域网 IP 探活，表现为「拉不起服务」。
 */
export function applyEndpointFlags(command: string, ep: ServiceEndpoint, tlsKeyPath = ''): string {
  const base = String(command ?? '').trim()
  if (base === '') return ''
  const parts: string[] = []
  if (ep.host !== DEFAULT_SERVICE_HOST && !/(?:^|\s)--host(?:[=\s]|$)/.test(base)) {
    parts.push('--host', quoteCommandArg(ep.host))
  }
  const cert = String(ep.caCertPath ?? '').trim()
  const key = String(tlsKeyPath ?? '').trim()
  const hasTlsFlag = /(?:^|\s)--tls-(?:cert|key)(?:[=\s]|$)/.test(base)
  if (ep.scheme === 'https' && cert !== '' && key !== '' && !hasTlsFlag) {
    parts.push('--tls-cert', quoteCommandArg(cert), '--tls-key', quoteCommandArg(key))
  }
  return parts.length === 0 ? base : `${base} ${parts.join(' ')}`
}

/** 启动命令里显式写的 `--host` 值（支持 `--host x` / `--host=x` / 引号形式）；没有返回 null。 */
export function hostFlagInCommand(command: string): string | null {
  const m = /(?:^|\s)--host(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(String(command ?? ''))
  if (m === null) return null
  return m[1] ?? m[2] ?? m[3] ?? null
}

/** 启动命令里是否已显式写了 TLS 参数（`--tls-cert` 或 `--tls-key`）。 */
export function hasTlsFlagsInCommand(command: string): boolean {
  return /(?:^|\s)--tls-(?:cert|key)(?:=|\s|$)/.test(String(command ?? ''))
}

/**
 * 设置页策略（v2.9.0，纯函数；v2.9.2 起也覆盖自定义命令）：切到 HTTPS 是否**必须先补成对证书/私钥**。
 *
 * 背景：v2.9.2 起 {@link applyEndpointFlags} 对自定义命令同样补参数——只要设置里有证书/私钥，
 * 命令缺 `--tls-*` 就会被补上；反之证书/私钥不全且命令自己也没写 TLS 参数时，切 HTTPS 必然连不上。
 * 因此只有「scheme=https 且命令里没有 TLS 参数 且证书/私钥不全」这一种组合要拒绝切换。
 * 设置页与单测共用本函数，避免「页面拦一套、flags 生成一套」两处判据漂移。
 */
export function httpsSwitchNeedsPair(input: {
  scheme: ServiceScheme
  startupCommand: string
  tlsCertPath: string
  tlsKeyPath: string
}): boolean {
  if (input.scheme !== 'https') return false
  if (hasTlsFlagsInCommand(input.startupCommand)) return false
  const cert = String(input.tlsCertPath ?? '').trim()
  const key = String(input.tlsKeyPath ?? '').trim()
  return cert === '' || key === ''
}

/** Node 侧 HTTP(S) 响应（set-cookie 只取首值，与旧 dsh-api 行为一致）。 */
export interface EndpointResponse {
  status: number
  text: string
  headers: Record<string, string | string[] | undefined>
  setCookie: string
}

/** endpointRequest 请求参数。 */
export interface EndpointRequest {
  path: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** 默认请求超时（毫秒；与 dsh-api 历史值一致）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 8000

/** 证书 PEM 按路径缓存（同一路径只读一次盘）。 */
const certCache = new Map<string, Buffer>()

/** 标记「已包装过」的错误，避免超时错误被二次加前缀。 */
const WRAPPED_MARK = Symbol('endpointRequestError')

interface WrappedError extends Error {
  code?: string
  [WRAPPED_MARK]?: boolean
}

/** 保留原始 err.code 的可读错误（上层据此翻译证书/连接错误）。 */
function wrapRequestError(err: unknown, ep: ServiceEndpoint): WrappedError {
  if (err instanceof Error && (err as WrappedError)[WRAPPED_MARK] === true) return err
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const detail =
    err instanceof Error
      ? err.message
      : typeof e.message === 'string' && e.message !== ''
        ? e.message
        : String(err)
  const out = new Error(
    `request to ${endpointOrigin(ep)} failed: ${detail}${code === '' ? '' : ` (code=${code})`}`,
  ) as WrappedError
  if (code !== '') out.code = code
  out[WRAPPED_MARK] = true
  return out
}

/** 读 TLS 证书 PEM（按路径缓存；读失败抛可读错误，不泄漏堆栈）。 */
function caPemOf(path: string): Buffer {
  const cached = certCache.get(path)
  if (cached !== undefined) return cached
  try {
    const pem = readFileSync(path)
    certCache.set(path, pem)
    return pem
  } catch {
    const err = new Error(`cannot read TLS certificate: ${path}`) as WrappedError
    err.code = 'ENOENT'
    throw err
  }
}

/**
 * Node http/https 请求（插件 Node 侧**唯一** HTTP(S) 出口）。
 *
 * - 按 `ep.scheme` 选 `node:http` / `node:https` 模块；
 * - https：`ca` 取 `ep.caCertPath` 的 PEM（也可填签发它的 CA），`rejectUnauthorized: true` 严格校验，
 *   不提供「跳过校验」开关；未填 PEM 时按系统信任根校验（公信证书场景）；
 * - Host 头为 `<host>:<port>`（IPv6 自动带方括号）；
 * - 错误统一包成 Error，`message` 里保留原始 `err.code`（如 `DEPTH_ZERO_SELF_SIGNED_CERT`），
 *   便于上层翻译成「证书未受信任 / SAN 不含该地址 / 证书过期」并指向 README 故障排查。
 */
export function endpointRequest(ep: ServiceEndpoint, req: EndpointRequest): Promise<EndpointResponse> {
  return new Promise<EndpointResponse>((resolve, reject) => {
    const timeoutMs = req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const headers: Record<string, string> = { ...(req.headers ?? {}) }
    // Host 头显式给全：IPv6 必须带方括号（`[::1]:3080`），DSH 的 origin/认证判据依赖它
    const hasHostHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'host')
    if (!hasHostHeader) headers.host = `${hostForUrl(ep.host)}:${String(ep.port)}`
    if (req.method === 'POST') {
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json'
      }
      headers['content-length'] = String(Buffer.byteLength(req.body ?? ''))
    }
    const baseOptions = {
      host: ep.host,
      port: ep.port,
      path: req.path,
      method: req.method,
      timeout: timeoutMs,
      headers,
    }
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const rawCookie = res.headers['set-cookie']
        const firstCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
          setCookie: firstCookie ?? '',
        })
      })
    }
    let client: ReturnType<typeof nodeHttpRequest>
    try {
      if (ep.scheme === 'https') {
        const certPath = String(ep.caCertPath ?? '').trim()
        // 未填 PEM 时按系统信任根校验（公信证书场景）；填了则用它做校验锚点
        const tlsOptions = { ...baseOptions, rejectUnauthorized: true }
        client = certPath === ''
          ? nodeHttpsRequest(tlsOptions, onResponse)
          : nodeHttpsRequest({ ...tlsOptions, ca: caPemOf(certPath) }, onResponse)
      } else {
        client = nodeHttpRequest(baseOptions, onResponse)
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    client.on('timeout', () => {
      const timedOut = new Error(
        `request to ${endpointOrigin(ep)}${req.path} timed out after ${String(timeoutMs)}ms`,
      ) as WrappedError
      timedOut.code = 'ETIMEDOUT'
      timedOut[WRAPPED_MARK] = true
      client.destroy(timedOut)
    })
    client.on('error', (err: Error) => reject(wrapRequestError(err, ep)))
    if (req.method === 'POST') client.end(req.body ?? '')
    else client.end()
  })
}

/**
 * TLS 证书错误分类（纯函数，不依赖 i18n）：把 Node 的原始 code 归到产品要求的三种可读文案
 * （证书未受信任 / SAN 不含该地址 / 证书过期）或 other；非 TLS 证书错误返回 'none'。
 *
 * 为什么单独导出：endpointRequest 只保留原始 `err.code`（不吞细节），文案由外壳层（设置页/Notice）
 * 按本函数的分类取 i18n 键，避免核心模块为一个错误串反向依赖 UI 文案。
 */
export type TlsErrorKind = 'untrusted' | 'altname' | 'expired' | 'other' | 'none'

export function tlsErrorKind(err: unknown): TlsErrorKind {
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const hay = `${code} ${message}`
  if (/CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|certificate has expired|certificate is not yet valid/i.test(hay)) return 'expired'
  if (/ERR_TLS_CERT_ALTNAME_INVALID|altnames?\/IP|does not match the certificate/i.test(hay)) return 'altname'
  if (
    /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|certificate chain|self[- ]signed certificate/i.test(
      hay,
    )
  ) {
    return 'untrusted'
  }
  if (/TLS|SSL|certificate/i.test(hay)) return 'other'
  return 'none'
}

/**
 * 连接失败分类（v2.9.0，纯函数）：「测试连接」按钮把底层错误归到 refused / timeout / tls / other，
 * TLS 再细分为 untrusted / altname / expired / other（文案由设置页按 {@link TlsErrorKind} 取 i18n 键）。
 *
 * 输入可以是 {@link endpointRequest} reject 出来的 Error（message 里带 `(code=…)`），
 * 也可以是 Node 原始错误对象 —— 两者都只看 code/message 文本，不做类型判断。
 */
export type ConnectFailureKind = 'refused' | 'timeout' | 'tls' | 'other'

export function classifyConnectFailure(err: unknown): { kind: ConnectFailureKind; tls: TlsErrorKind } {
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const hay = `${code} ${message}`
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|address not available/i.test(hay)) {
    return { kind: 'refused', tls: 'none' }
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed out/i.test(hay)) {
    return { kind: 'timeout', tls: 'none' }
  }
  const tls = tlsErrorKind(err)
  if (tls !== 'none') return { kind: 'tls', tls }
  return { kind: 'other', tls: 'none' }
}

/**
 * 测试辅助：按端口（可指定 host）造一个 http 端点，省得每个用例写全字段。
 * 放在本模块是为了让 service-manager / dsh-api / aed 的测试共用同一构造器。
 */
export function testEndpoint(port: number, host: string = DEFAULT_SERVICE_HOST): ServiceEndpoint {
  return { scheme: 'http', host, port }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */
