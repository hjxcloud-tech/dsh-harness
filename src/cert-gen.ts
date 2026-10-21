/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Node builtin APIs (crypto/https/fs) are fully typed by the local tsconfig; the review scanner runs without Node type declarations and flags them as any. */
/**
 * 证书生成模块（v2.9.1「手机访问配置」）：不依赖 openssl / mkcert 的自签 HTTPS 证书。
 *
 * 背景：手机远程访问 DSH 需要 HTTPS（浏览器在非安全上下文下限制能力），而用户机器普遍
 * 没有 openssl / mkcert。本模块只用 Node 内置模块，自己手写**最小 DER 编码器**拼 X.509 v3
 * 自签证书，然后以「本地真实 HTTPS 回环」做自检：带 ca 必须 200，不带 ca 必须被拒。
 *
 * 设计要点（与 spec §3 对齐）：
 * - 单证书同时充当「服务器证书」与「根证书」：`--tls-cert` 与插件 `ca` 用同一份 PEM；
 *   桌面 `rootCA.pem` 就是证书 PEM 原样复制（用户装进系统/手机信任库的根）。
 * - 固定算法：RSA-2048、SHA-256 签名（sha256WithRSAEncryption）、CA:TRUE、
 *   keyUsage（digitalSignature/keyEncipherment/keyCertSign）、extKeyUsage serverAuth、
 *   SAN = DNS:localhost + IP:127.0.0.1 + IP:::1 + IP:<局域网 IPv4>。
 * - 默认有效期 825 天（浏览器对自签根的最大容忍期量级），每次生成覆盖旧文件、不追加密钥历史。
 * - 失败一律抛带 `code` 的 Error（`no-lan-address` / `desktop-missing` / `self-check` 等），
 *   由调用方（`main.ts`）映射成可翻译文案。
 *
 * 依赖注入面：{@link detectLanIPv4} 接 `interfaces`、{@link desktopDir} / {@link defaultCertDir} 接
 * `home`，测试不需要读真实网卡/用户目录即可覆盖全部真值表。
 */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https'
import { isIP } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

/** 生成结果（T2 据此写设置；`host` 是要填进「服务地址」的那一项）。 */
export interface GeneratedCerts {
  /** 主地址（填入服务地址）：检测到的局域网 IPv4 */
  host: string
  /** 证书 SAN 覆盖的主机/地址（含 127.0.0.1、::1、localhost） */
  hosts: string[]
  certPath: string
  keyPath: string
  rootCaPath: string
  certPem: string
  /** ISO 时间串（DER 时间为秒精度，这里已按秒截断） */
  notBefore: string
  notAfter: string
}

/** 生成参数（全部可注入，便于测试与调用方定制）。 */
export interface CertGenOptions {
  hosts?: string[]
  outDir?: string
  desktopDir?: string
  /** 有效期天数，默认 825 */
  validDays?: number
  /** 基准时间（测试注入；默认当前时间） */
  now?: Date
}

/** 默认有效期（天）：825 ≈ 浏览器对自签根证书可接受的最长区间量级。 */
export const DEFAULT_VALID_DAYS = 825

const OID_SHA256_RSA = '1.2.840.113549.1.1.11'
const OID_CN = '2.5.4.3'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_KEY_USAGE = '2.5.29.15'
const OID_EXT_KEY_USAGE = '2.5.29.37'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

/** 回环 host 判定（与 service-endpoint.isLoopbackHost 同义，此处自包含以免跨模块耦合）。 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** 构造带 code 的 Error：code 供调用方映射 i18n 文案。 */
function certError(code: string, detail?: string): Error & { code: string } {
  const error = new Error(detail === undefined ? code : `${code}: ${detail}`) as Error & { code: string }
  error.code = code
  return error
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// 最小 DER 编码器（只实现 X.509 用到的类型：SEQUENCE/SET/INTEGER/BOOLEAN/NULL/
// OID/UTF8String/IA5String/OCTET STRING/BIT STRING/UTCTime/GeneralizedTime/显式标签）
// ---------------------------------------------------------------------------

/** DER 长度：<128 单字节；否则 0x80|字节数 后跟大端字节。 */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** 通用 TLV：单字节 tag + DER 长度 + 内容。 */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derSeq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items))
}

function derSet(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items))
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00])
}

function derBooleanTrue(): Buffer {
  return Buffer.from([0x01, 0x01, 0xff])
}

function derOctetString(content: Buffer): Buffer {
  return tlv(0x04, content)
}

function derUtf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, 'utf8'))
}

/** 小正整数 INTEGER（本模块只用于 version，值 ≤ 2）。 */
function derSmallInteger(value: number): Buffer {
  if (value < 0x80) return tlv(0x02, Buffer.from([value]))
  throw certError('der', `derSmallInteger 仅支持 < 128 的正整数：${String(value)}`)
}

/** 正整数 INTEGER：入参是大端无符号字节；首字节 ≥0x80 时补 0x00 防被解释为负数。 */
function derPositiveInteger(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1
  const body = bytes.subarray(start)
  return tlv(0x02, body[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body)
}

/** base-128 变长整数（OID 后续弧段）。 */
function base128(value: number): number[] {
  const out = [value & 0x7f]
  let rest = Math.floor(value / 128)
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  return out
}

/** 点分 OID → DER OBJECT IDENTIFIER（首两弧合并为 40*arc1+arc2）。 */
function derOid(dotted: string): Buffer {
  const parts = dotted.split('.').map((part) => Number(part))
  const body = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    body.push(...base128(part))
  }
  return tlv(0x06, Buffer.from(body))
}

/** BIT STRING：unusedBits 为末尾未用位数，bytes 为有效位（MSB first）。 */
function derBitString(bytes: Buffer, unusedBits: number): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]))
}

/** CN=RDN：SEQUENCE { SET { SEQUENCE { OID(2.5.4.3), UTF8String } } }。 */
function derName(commonName: string): Buffer {
  return derSeq(derSet(derSeq(derOid(OID_CN), derUtf8(commonName))))
}

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/** Time：1950–2049 用 UTCTime（YYMMDDHHMMSSZ），否则 GeneralizedTime。 */
function derTime(date: Date): Buffer {
  const year = date.getUTCFullYear()
  const tail =
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  if (year >= 1950 && year < 2050) {
    return tlv(0x17, Buffer.from(pad2(year % 100) + tail, 'ascii'))
  }
  return tlv(0x18, Buffer.from(String(year) + tail, 'ascii'))
}

/** AlgorithmIdentifier：sha256WithRSAEncryption + NULL 参数。 */
function derSha256WithRsaAlgorithm(): Buffer {
  return derSeq(derOid(OID_SHA256_RSA), derNull())
}

/** Extension：SEQUENCE { extnID, critical?, extnValue OCTET STRING }。 */
function derExtension(oid: string, critical: boolean, value: Buffer): Buffer {
  const items = [derOid(oid)]
  if (critical) items.push(derBooleanTrue())
  items.push(derOctetString(value))
  return derSeq(...items)
}

function ipv4Bytes(address: string): Buffer {
  return Buffer.from(address.split('.').map((part) => Number(part)))
}

/** IPv6 点分文本（支持 `::` 压缩）→ 16 字节（iPAddress GeneralName 用）。 */
function ipv6Bytes(address: string): Buffer {
  const parts = address.split('::')
  const head = parts[0] === undefined || parts[0] === '' ? [] : parts[0].split(':')
  const tail = parts[1] === undefined || parts[1] === '' ? [] : parts[1].split(':')
  const fill = Math.max(0, 8 - head.length - tail.length)
  const groups = [...head, ...new Array<string>(fill).fill('0'), ...tail]
  const out = Buffer.alloc(16)
  groups.forEach((group, index) => {
    out.writeUInt16BE(Number.parseInt(group, 16), index * 2)
  })
  return out
}

/** GeneralName：IP 字面量走 [7] iPAddress（4/16 字节），其余走 [2] dNSName。 */
function derGeneralName(host: string): Buffer {
  const kind = isIP(host)
  if (kind === 4) return tlv(0x87, ipv4Bytes(host))
  if (kind === 6) return tlv(0x87, ipv6Bytes(host))
  return tlv(0x82, Buffer.from(host, 'ascii'))
}

/** 主机名可用性：IP 字面量放行；DNS 名只允许 ASCII 字母数字与 `.-_`（dNSName 是 IA5String）。 */
function assertHostsUsable(hosts: string[]): void {
  for (const host of hosts) {
    if (host === '') throw certError('invalid-host', '主机名为空')
    if (isIP(host) !== 0) continue
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host)) {
      throw certError('invalid-host', `不是合法的 IPv4/IPv6 地址或 ASCII DNS 名：${host}`)
    }
  }
}

function toPem(label: string, der: Buffer): string {
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n+$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 首个非内部、非 169.254、非 127/8 的 IPv4；没有返回 null。
 *
 * `interfaces` 可注入（默认读真实网卡），测试用真值表覆盖「跳过 internal / 链路本地 /
 * 回环」「取接口枚举顺序中的第一个」「只有 IPv6 时返回 null」等分支。
 */
export function detectLanIPv4(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  for (const list of Object.values(interfaces)) {
    if (list === undefined) continue
    for (const info of list) {
      if (info.family !== 'IPv4') continue
      if (info.internal) continue
      if (info.address.startsWith('127.')) continue
      if (info.address.startsWith('169.254.')) continue
      return info.address
    }
  }
  return null
}

/** 证书输出目录：`<home>/.dsh-obsidian/certs`（自动 mkdir）。 */
export function defaultCertDir(home: string = homedir()): string {
  const dir = join(home, '.dsh-obsidian', 'certs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 桌面目录：优先 `~/Desktop`，其次 `~/OneDrive/Desktop`、`~/桌面`；都不存在抛
 * `desktop-missing`（重定向过的桌面无法可靠推导，交给调用方提示用户）。
 */
export function desktopDir(home: string = homedir()): string {
  const candidates = [join(home, 'Desktop'), join(home, 'OneDrive', 'Desktop'), join(home, '桌面')]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 候选不存在或不可访问：继续尝试下一个
    }
  }
  throw certError('desktop-missing', `未找到桌面目录（已尝试 ${candidates.join(' / ')}）`)
}

/** 解析 hosts：显式给出就用（去重、取首个非回环为主地址）；否则默认 = localhost + 两个回环 + LAN。 */
function resolveHosts(given: string[] | undefined): { host: string; hosts: string[] } {
  if (given === undefined) {
    const lan = detectLanIPv4()
    if (lan === null) throw certError('no-lan-address', '未检测到局域网 IPv4 地址')
    return { host: lan, hosts: ['localhost', '127.0.0.1', '::1', lan] }
  }
  const hosts = [...new Set(given.map((host) => host.trim()).filter((host) => host !== ''))]
  if (hosts.length === 0) throw certError('no-lan-address', 'hosts 为空且未检测到局域网地址')
  assertHostsUsable(hosts)
  return { host: hosts.find((host) => !isLoopbackHost(host)) ?? hosts[0], hosts }
}

interface CertMaterial {
  certPem: string
  keyPem: string
  notBefore: Date
  notAfter: Date
}

/** 组装 X.509 v3 自签证书（RSA-2048 / SHA-256 / CA:TRUE / SAN=hosts）。 */
function createSelfSignedCert(hosts: string[], primaryHost: string, now: Date, validDays: number): CertMaterial {
  const notBeforeMs = Math.floor(now.getTime() / 1000) * 1000
  const notBefore = new Date(notBeforeMs)
  const notAfter = new Date(notBeforeMs + validDays * 24 * 60 * 60 * 1000)

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const algorithm = derSha256WithRsaAlgorithm()
  const name = derName(`DSH Obsidian (${primaryHost})`)
  const extensions = derSeq(
    // basicConstraints critical: CA:TRUE（自签单证书同时当根，Windows/iOS/安卓装进信任库后可用）
    derExtension(OID_BASIC_CONSTRAINTS, true, derSeq(derBooleanTrue())),
    // keyUsage critical: digitalSignature(0) + keyEncipherment(5) + keyCertSign(6) => 0x86
    derExtension(OID_KEY_USAGE, true, derBitString(Buffer.from([0x86]), 1)),
    // extKeyUsage: serverAuth（1.3.6.1.5.5.7.3.1）
    derExtension(OID_EXT_KEY_USAGE, false, derSeq(derOid(OID_SERVER_AUTH))),
    // subjectAltName: DNS:localhost + IP:127.0.0.1 + IP:::1 + IP:<lan>
    derExtension(OID_SUBJECT_ALT_NAME, false, derSeq(...hosts.map((host) => derGeneralName(host)))),
  )

  const tbs = derSeq(
    tlv(0xa0, derSmallInteger(2)), // [0] EXPLICIT version = v3
    derPositiveInteger(randomBytes(16)), // serialNumber（随机 16 字节，补正数）
    algorithm,
    name, // issuer（自签：与 subject 相同）
    derSeq(derTime(notBefore), derTime(notAfter)),
    name, // subject
    publicKey, // SPKI DER 原样嵌入（KeyObject.export({type:'spki',format:'der'})）
    tlv(0xa3, extensions), // [3] EXPLICIT extensions
  )

  const signature = sign('sha256', tbs, privateKey)
  const certDer = derSeq(tbs, algorithm, derBitString(signature, 0))
  return { certPem: toPem('CERTIFICATE', certDer), keyPem: String(privateKey), notBefore, notAfter }
}

/** SAN 文本 → 条目数组（形如 `DNS:localhost`、`IP Address:127.0.0.1`）。 */
function parseSanEntries(subjectAltName: string | undefined): string[] {
  if (subjectAltName === undefined || subjectAltName === '') return []
  return subjectAltName.split(',').map((entry) => entry.trim())
}

/** SAN 是否覆盖某 host（IPv6 不同渲染形态按字节比较，避免依赖 OpenSSL 打印格式）。 */
function sanCovers(entries: string[], host: string): boolean {
  const kind = isIP(host)
  if (kind === 0) return entries.includes(`DNS:${host}`)
  if (kind === 4) return entries.includes(`IP Address:${host}`)
  return entries.some((entry) => {
    if (!entry.startsWith('IP Address:')) return false
    const value = entry.slice('IP Address:'.length)
    return isIP(value) === 6 && ipv6Bytes(value).equals(ipv6Bytes(host))
  })
}

/** 自检第一层：证书可解析、SAN 覆盖 hosts、有效期与预期一致、CN 带产品名。 */
function assertCertMaterial(material: CertMaterial, hosts: string[]): void {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(material.certPem)
  } catch (error) {
    throw certError('self-check', `生成的证书无法被 X509Certificate 解析：${messageOf(error)}`)
  }
  const entries = parseSanEntries(cert.subjectAltName)
  const missing = hosts.filter((host) => !sanCovers(entries, host))
  if (missing.length > 0) {
    throw certError('self-check', `证书 SAN 未覆盖：${missing.join(', ')}（实际：${cert.subjectAltName ?? '无'}）`)
  }
  if (!cert.subject.includes('CN=DSH Obsidian')) {
    throw certError('self-check', `证书 subject 非预期：${cert.subject}`)
  }
  if (Date.parse(cert.validFrom) > material.notBefore.getTime() + 1000) {
    throw certError('self-check', `证书 notBefore 晚于预期：${cert.validFrom}`)
  }
  if (Date.parse(cert.validTo) < material.notAfter.getTime() - 1000) {
    throw certError('self-check', `证书 notAfter 早于预期：${cert.validTo}`)
  }
}

/** 选择自检用的连接目标：优先回环 IP，其次 localhost，最后第一个 IP。 */
function pickCheckTarget(hosts: string[]): string {
  for (const candidate of ['127.0.0.1', '::1', 'localhost']) {
    if (hosts.includes(candidate)) return candidate
  }
  return hosts.find((host) => isIP(host) !== 0) ?? hosts[0]
}

function listenOn(server: HttpsServer, host: string): Promise<number> {
  return new Promise((resolve) => {
    server.once('error', (error) => {
      throw certError('self-check', `自检 HTTPS 服务无法监听 ${host}：${messageOf(error)}`)
    })
    server.listen(0, host, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw certError('self-check', '自检 HTTPS 服务未返回端口')
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => {
      resolve()
    })
    server.closeAllConnections()
  })
}

/** 发一次 HTTPS GET（ca 为空则用系统信任库），返回状态码；连接/证书错误走 reject。 */
function httpsGetStatus(port: number, host: string, ca: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host,
        port,
        path: '/',
        method: 'GET',
        ca,
        rejectUnauthorized: true,
        agent: false,
        family: isIP(host) === 0 ? 4 : undefined,
        timeout: 5000,
      },
      (res) => {
        const status = res.statusCode ?? 0
        res.resume()
        resolve(status)
      },
    )
    req.on('timeout', () => {
      req.destroy(certError('self-check', 'HTTPS 自检请求超时'))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 自检第二层：本地起 HTTPS 服务（用刚生成的 cert/key），
 * ① 带 ca 严格校验必须 200；② 不带 ca 必须被拒（自签不在系统信任库）。
 * 任一不满足即抛 `self-check`，并保证 server 已关闭。
 */
async function verifyWithLocalHttps(certPem: string, keyPem: string, hosts: string[]): Promise<void> {
  const target = pickCheckTarget(hosts)
  const listenHost = isIP(target) === 0 ? '127.0.0.1' : target
  const server = createHttpsServer({ cert: certPem, key: keyPem }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('ok')
  })
  try {
    const port = await listenOn(server, listenHost)
    let trustedStatus = 0
    try {
      trustedStatus = await httpsGetStatus(port, target, certPem)
    } catch (error) {
      throw certError('self-check', `带 ca 的 HTTPS 自检失败：${messageOf(error)}`)
    }
    if (trustedStatus !== 200) {
      throw certError('self-check', `带 ca 的 HTTPS 自检返回 ${String(trustedStatus)}，期望 200`)
    }
    let untrustedRejected = false
    try {
      await httpsGetStatus(port, target, undefined)
    } catch {
      untrustedRejected = true
    }
    if (!untrustedRejected) {
      throw certError('self-check', '不带 ca 的 HTTPS 请求未被拒绝：自签证书必须无法通过系统信任库校验')
    }
  } finally {
    await closeServer(server)
  }
}

/**
 * 生成 RSA-2048 自签证书（X.509 v3，CA:TRUE，SAN=hosts），
 * 写 `outDir/cert.pem`、`outDir/key.pem`（PKCS#8，尽量 0600）与桌面 `rootCA.pem`（证书 PEM 原样）；
 * 随后做两层自检（X509Certificate 解析断言 + 本地真实 HTTPS 回环），失败关闭服务并抛可读错误。
 *
 * 默认 hosts = `['localhost','127.0.0.1','::1', lanIPv4]`；检测不到 LAN 抛 `no-lan-address`。
 * 每次覆盖写入，不追加密钥历史。
 */
export async function generateCerts(opts: CertGenOptions = {}): Promise<GeneratedCerts> {
  const { host, hosts } = resolveHosts(opts.hosts)
  const validDays = opts.validDays ?? DEFAULT_VALID_DAYS
  if (!Number.isFinite(validDays) || validDays <= 0) {
    throw certError('invalid-valid-days', `有效期必须为正数（收到 ${String(validDays)}）`)
  }
  const certDir = opts.outDir ?? defaultCertDir()
  mkdirSync(certDir, { recursive: true })
  const deskDir = opts.desktopDir ?? desktopDir()
  mkdirSync(deskDir, { recursive: true })

  const material = createSelfSignedCert(hosts, host, opts.now ?? new Date(), validDays)
  const certPath = join(certDir, 'cert.pem')
  const keyPath = join(certDir, 'key.pem')
  const rootCaPath = join(deskDir, 'rootCA.pem')
  writeFileSync(certPath, material.certPem, 'utf8')
  writeFileSync(keyPath, material.keyPem, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(rootCaPath, material.certPem, 'utf8')

  assertCertMaterial(material, hosts)
  await verifyWithLocalHttps(material.certPem, material.keyPem, hosts)

  return {
    host,
    hosts,
    certPath,
    keyPath,
    rootCaPath,
    certPem: material.certPem,
    notBefore: material.notBefore.toISOString(),
    notAfter: material.notAfter.toISOString(),
  }
}

/** 「电脑端自动信任」的结果：Windows 自动装进当前用户信任根；macOS/其它平台 skipped，由 UI 给手动步骤。 */
export interface TrustInstallResult {
  ok: boolean
  skipped: boolean
  error?: string
}

/** 把 PEM 证书转成 DER（certutil 对 PEM 的接受度依发行版而异；统一转 DER 最稳）。 */
function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

/**
 * 把自签根证书装进**当前用户的 Windows「受信任的根证书颁发机构」**（v2.9.2「生成并填入」的一步）。
 *
 * - Windows：`certutil -user -addstore Root <der>` —— `-user` 只影响当前用户、**不需要管理员**；
 *   Obsidian / Chrome 的证书校验读同一个用户 Root 库，所以内嵌面板立刻不再报「证书不受信任」。
 *   临时 `.cer` 写在证书同目录，命令结束即删。
 * - macOS：系统信任需钥匙串交互（可能弹密码/无法静默），不擅自改，返回 skipped 由 Done 弹窗给手动步骤。
 * - 其它平台同样 skipped。
 *
 * 注入面：`platform` / `execFile` / `pemText` 供单测使用（测试里不触碰真实证书库）。
 */
export function trustRootCertificate(
  certPath: string,
  opts: {
    platform?: NodeJS.Platform
    execFile?: (file: string, args: string[], options?: unknown) => unknown
    pemText?: string
  } = {},
): TrustInstallResult {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return { ok: false, skipped: true, error: `manual trust on ${platform}` }
  const derPath = join(dirname(certPath), 'rootCA.cer')
  try {
    const pem = opts.pemText ?? readFileSync(certPath, 'utf8')
    writeFileSync(derPath, pemToDer(pem))
    const exec =
      opts.execFile ?? ((file: string, args: string[], options?: unknown) => execFileSync(file, args, options as Parameters<typeof execFileSync>[2]))
    exec('certutil', ['-user', '-addstore', 'Root', derPath], {
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, skipped: false }
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown }
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : ''
    const message = stderr !== '' ? stderr : typeof e.message === 'string' ? e.message : String(err)
    return { ok: false, skipped: false, error: message }
  } finally {
    try {
      unlinkSync(derPath)
    } catch {
      // 临时文件不存在时静默
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- restore rules after the Node-API exemption for non-type-aware review scans */