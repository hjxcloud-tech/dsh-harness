/* eslint-disable @typescript-eslint/no-unsafe-argument -- 脏值真值表刻意用非法类型喂给纯函数（模拟手改 data.json / 旧版本字段） */
import { describe, expect, it } from 'vitest'
import {
  applyEndpointFlags,
  classifyConnectFailure,
  endpointFromSettings,
  endpointOrigin,
  hasTlsFlagsInCommand,
  hostFlagInCommand,
  httpsSwitchNeedsPair,
  normalizeServiceHost,
  quoteCommandArg,
  testEndpoint,
  tlsErrorKind,
  type ServiceEndpoint,
} from '../src/service-endpoint'

/**
 * v2.9.0 外壳侧（设置页 / main）用到的纯策略函数真值表。
 *
 * 为什么不测 settings.ts：它 import obsidian，而 node_modules/obsidian 只有 .d.ts（package.json main 为空），
 * vitest 解析不了该模块。所以设置页的判据全部收敛到 service-endpoint 的纯函数，这里直接测这些函数。
 */

describe('设置页「服务地址」校验（normalizeServiceHost 的 ok / reason）', () => {
  it('合法：回环、本机其它 IPv4、IPv6（含方括号）、localhost', () => {
    for (const raw of ['127.0.0.1', '127.0.0.2', '192.168.1.5', '::1', '[::1]', 'fe80::1', 'localhost', 'LOCALHOST']) {
      expect(normalizeServiceHost(raw), raw).toMatchObject({ ok: true })
    }
    // 归一后的值：IPv6 去方括号、小写
    expect(normalizeServiceHost('[::1]')).toEqual({ ok: true, host: '::1' })
    expect(normalizeServiceHost(' 192.168.1.5 ')).toEqual({ ok: true, host: '192.168.1.5' })
  })

  it('非法原因可分类（设置页据此只给一条通用提示，不回填脏值）', () => {
    expect(normalizeServiceHost('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeServiceHost('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeServiceHost('http://127.0.0.1')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeServiceHost('127.0.0.1/foo')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('user@host')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('127.0.0.1:3080')).toEqual({ ok: false, reason: 'port' })
    expect(normalizeServiceHost('[::1]:3080')).toEqual({ ok: false, reason: 'port' })
    expect(normalizeServiceHost('0.0.0.0')).toEqual({ ok: false, reason: 'wildcard' })
    expect(normalizeServiceHost('::')).toEqual({ ok: false, reason: 'wildcard' })
    expect(normalizeServiceHost('fe80::1%12')).toEqual({ ok: false, reason: 'zone' })
    expect(normalizeServiceHost('example.com')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('v2.9.0 切 https 的成对校验（httpsSwitchNeedsPair）', () => {
  const cert = 'C:\\certs\\a.pem'
  const key = 'C:\\certs\\a-key.pem'

  it('启动命令留空（插件生成默认命令）时，证书 / 私钥必须成对', () => {
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: '', tlsCertPath: '', tlsKeyPath: '' })).toBe(true)
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: '', tlsCertPath: cert, tlsKeyPath: '' })).toBe(true)
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: '', tlsCertPath: '', tlsKeyPath: key })).toBe(true)
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: '   ', tlsCertPath: cert, tlsKeyPath: key })).toBe(false)
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: '', tlsCertPath: cert, tlsKeyPath: key })).toBe(false)
  })

  it('自定义启动命令没有 TLS 参数时，证书 / 私钥也必须成对（v2.9.2：插件会替它补 --tls-*）', () => {
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: 'dsh web --port {port} --no-open', tlsCertPath: '', tlsKeyPath: '' })).toBe(true)
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: 'dsh web --port {port} --no-open', tlsCertPath: cert, tlsKeyPath: key })).toBe(false)
  })

  it('自定义启动命令自带 TLS 参数时，以命令为准，不拦切换', () => {
    expect(httpsSwitchNeedsPair({ scheme: 'https', startupCommand: 'dsh web --tls-cert a --tls-key b', tlsCertPath: '', tlsKeyPath: '' })).toBe(false)
  })

  it('http 永远不需要成对', () => {
    expect(httpsSwitchNeedsPair({ scheme: 'http', startupCommand: '', tlsCertPath: '', tlsKeyPath: '' })).toBe(false)
  })
})

describe('v2.9.2 启动命令统一补齐端点参数（生成命令与自定义命令同一策略）', () => {
  /** 与 v2.9.2 的 main.buildService 同一条策略：不论命令来自生成还是用户，都只补缺失的端点参数。 */
  const effectiveCommand = (userCommand: string, generated: string, ep: ServiceEndpoint, key: string): string =>
    applyEndpointFlags(userCommand === '' ? generated : userCommand, ep, key)

  const generated = 'dsh web --port 3080 --no-open'

  it('默认回环 http：命令逐字不变（历史行为不变）', () => {
    const ep = testEndpoint(3080)
    expect(effectiveCommand('', generated, ep, '')).toBe(generated)
  })

  it('非回环地址追加 --host（IPv6 直接写字面量，与 dsh web --host 一致）', () => {
    expect(effectiveCommand('', generated, testEndpoint(3080, '192.168.1.5'), '')).toBe(`${generated} --host 192.168.1.5`)
    expect(effectiveCommand('', generated, testEndpoint(3080, '::1'), '')).toBe(`${generated} --host ::1`)
  })

  it('https + 证书/私钥：追加带引号的两个 flag（路径含空格也不被拆段）', () => {
    const ep: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: 3443, caCertPath: 'C:\\my certs\\a.pem' }
    const key = 'C:\\my certs\\a-key.pem'
    expect(effectiveCommand('', generated, ep, key)).toBe(
      `${generated} --tls-cert ${quoteCommandArg('C:\\my certs\\a.pem')} --tls-key ${quoteCommandArg('C:\\my certs\\a-key.pem')}`,
    )
    expect(quoteCommandArg('C:\\my certs\\a.pem')).toBe('"C:\\my certs\\a.pem"')
  })

  it('自定义命令也补缺失参数（v2.9.2 修复「设置里填了地址/TLS 却不生效」）', () => {
    const custom = 'dsh web --port 4000 --no-open'
    const ep: ServiceEndpoint = { scheme: 'https', host: '192.168.1.5', port: 3080, caCertPath: 'C:\\certs\\a.pem' }
    expect(effectiveCommand(custom, generated, ep, 'C:\\certs\\a-key.pem')).toBe(
      `${custom} --host 192.168.1.5 --tls-cert ${quoteCommandArg('C:\\certs\\a.pem')} --tls-key ${quoteCommandArg('C:\\certs\\a-key.pem')}`,
    )
  })

  it('自定义命令已有同名参数：不重复、不覆盖（命令优先）', () => {
    const custom = 'dsh web --port 4000 --host 192.168.1.5 --tls-cert old.pem --tls-key old-key.pem'
    const ep: ServiceEndpoint = { scheme: 'https', host: '10.0.0.9', port: 3080, caCertPath: 'C:\\certs\\a.pem' }
    expect(effectiveCommand(custom, generated, ep, 'C:\\certs\\a-key.pem')).toBe(custom)
  })

  it('hostFlagInCommand / hasTlsFlagsInCommand 真值表（设置页告警与生成预检共用）', () => {
    expect(hostFlagInCommand('dsh web --host 192.168.1.5 --no-open')).toBe('192.168.1.5')
    expect(hostFlagInCommand('dsh web --host=::1')).toBe('::1')
    expect(hostFlagInCommand('dsh web --host "192.168.1.5"')).toBe('192.168.1.5')
    expect(hostFlagInCommand('dsh web --port 3080')).toBeNull()
    expect(hasTlsFlagsInCommand('dsh web --tls-cert a --tls-key b')).toBe(true)
    expect(hasTlsFlagsInCommand('dsh web --port 3080')).toBe(false)
  })
})

describe('v2.9.0 「测试连接」失败分类（classifyConnectFailure + tlsErrorKind）', () => {
  const withCode = (code: string, message = 'boom'): Error => Object.assign(new Error(message), { code })

  it('连接被拒 / 主机不可达 → refused', () => {
    expect(classifyConnectFailure(withCode('ECONNREFUSED')).kind).toBe('refused')
    expect(classifyConnectFailure(withCode('EHOSTUNREACH')).kind).toBe('refused')
  })

  it('超时 → timeout', () => {
    expect(classifyConnectFailure(withCode('ETIMEDOUT')).kind).toBe('timeout')
    // endpointRequest 的超时错误把「timed out」写进 message（code=ETIMEDOUT）
    expect(classifyConnectFailure(new Error('request to https://127.0.0.1:3443/ timed out after 4000ms (code=ETIMEDOUT)')).kind).toBe('timeout')
  })

  it('TLS 证书错误按 tlsErrorKind 细分（未受信任 / SAN 不匹配 / 过期 / 其它）', () => {
    expect(classifyConnectFailure(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'))).toEqual({ kind: 'tls', tls: 'untrusted' })
    expect(classifyConnectFailure(withCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toEqual({ kind: 'tls', tls: 'untrusted' })
    expect(classifyConnectFailure(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))).toEqual({ kind: 'tls', tls: 'altname' })
    expect(classifyConnectFailure(withCode('CERT_HAS_EXPIRED'))).toEqual({ kind: 'tls', tls: 'expired' })
    expect(classifyConnectFailure(withCode('ERR_SSL_WRONG_VERSION_NUMBER'))).toEqual({ kind: 'tls', tls: 'other' })
  })

  it('endpointRequest 包装后的错误（只有 message 带 code=…）也能分类——设置页就是按这段文本选文案的', () => {
    const wrapped = new Error(
      'request to https://127.0.0.1:3443 failed: self-signed certificate (code=DEPTH_ZERO_SELF_SIGNED_CERT)',
    )
    expect(classifyConnectFailure(wrapped)).toEqual({ kind: 'tls', tls: 'untrusted' })
    expect(tlsErrorKind(wrapped)).toBe('untrusted')
  })

  it('其它错误 → other（不冒充 TLS/超时）', () => {
    expect(classifyConnectFailure(new Error('socket hang up'))).toEqual({ kind: 'other', tls: 'none' })
    expect(classifyConnectFailure(undefined)).toEqual({ kind: 'other', tls: 'none' })
  })
})

describe('v2.9.0 「连接地址」展示串与设置片段一致', () => {
  it('端点 origin 与设置片段同源（IPv6 带方括号、https 用 https）', () => {
    const ep = endpointFromSettings({ port: 3443, serviceHost: '[::1]', serviceScheme: 'https', tlsCertPath: 'C:\\certs\\a.pem' })
    expect(endpointOrigin(ep)).toBe('https://[::1]:3443')
    const lan = endpointFromSettings({ port: 3080, serviceHost: '192.168.1.5' })
    expect(endpointOrigin(lan)).toBe('http://192.168.1.5:3080')
  })
})
