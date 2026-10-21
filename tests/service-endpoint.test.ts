import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyEndpointFlags,
  DEFAULT_SERVICE_HOST,
  endpointFromSettings,
  endpointFromUrl,
  endpointLabel,
  endpointOrigin,
  endpointRequest,
  isLoopbackHost,
  isWildcardHost,
  normalizeServiceHost,
  quoteCommandArg,
  testEndpoint,
  tlsErrorKind,
  type ServiceEndpoint,
} from '../src/service-endpoint'

/** openssl 可用性（https 自签证书用例需要它生成临时证书；不可用则整组跳过）。 */
const OPENSSL_AVAILABLE = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

/** 起本地服务并返回随机端口（host 可指定 127.0.0.1 / 127.0.0.2）。 */
async function listen(server: Server | HttpsServer, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const address = server.address() as AddressInfo
  return address.port
}

describe('normalizeServiceHost（host 归一真值表）', () => {
  it('合法回环 / 本机 IPv4 / IPv6（含方括号、大小写）归一为无括号小写字面量', () => {
    expect(normalizeServiceHost('127.0.0.1')).toEqual({ ok: true, host: '127.0.0.1' })
    expect(normalizeServiceHost('  127.0.0.1  ')).toEqual({ ok: true, host: '127.0.0.1' })
    expect(normalizeServiceHost('192.168.1.5')).toEqual({ ok: true, host: '192.168.1.5' })
    expect(normalizeServiceHost('localhost')).toEqual({ ok: true, host: 'localhost' })
    expect(normalizeServiceHost('LOCALHOST')).toEqual({ ok: true, host: 'localhost' })
    expect(normalizeServiceHost('::1')).toEqual({ ok: true, host: '::1' })
    expect(normalizeServiceHost('[::1]')).toEqual({ ok: true, host: '::1' })
    expect(normalizeServiceHost('[FE80::1]')).toEqual({ ok: true, host: 'fe80::1' })
    expect(normalizeServiceHost('2001:db8::1')).toEqual({ ok: true, host: '2001:db8::1' })
  })

  it('空值 / 协议前缀 / URL 片段 / 带端口 / 通配 / zone 各有可分类原因', () => {
    expect(normalizeServiceHost('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeServiceHost('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeServiceHost('http://127.0.0.1')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeServiceHost('https://example.com')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeServiceHost('127.0.0.1/foo')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('127.0.0.1?x=1')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('127.0.0.1#frag')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('user@127.0.0.1')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('127.0.0.1 3080')).toEqual({ ok: false, reason: 'path' })
    expect(normalizeServiceHost('127.0.0.1:3080')).toEqual({ ok: false, reason: 'port' })
    expect(normalizeServiceHost('[::1]:3080')).toEqual({ ok: false, reason: 'port' })
    expect(normalizeServiceHost('0.0.0.0')).toEqual({ ok: false, reason: 'wildcard' })
    expect(normalizeServiceHost('::')).toEqual({ ok: false, reason: 'wildcard' })
    expect(normalizeServiceHost('[::]')).toEqual({ ok: false, reason: 'wildcard' })
    expect(normalizeServiceHost('fe80::1%12')).toEqual({ ok: false, reason: 'zone' })
  })

  it('非法字面量（域名 / 越界 IPv4 / 残缺 IPv6 / 不成对方括号）→ invalid', () => {
    expect(normalizeServiceHost('example.com')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeServiceHost('256.1.1.1')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeServiceHost('1:2:3')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeServiceHost('[::1')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeServiceHost('::1]')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('isLoopbackHost / isWildcardHost', () => {
  it('回环：127.0.0.0/8、::1（含方括号）、localhost', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.5.6.7')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('128.0.0.1')).toBe(false)
  })

  it('通配：0.0.0.0 / ::（含方括号）', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true)
    expect(isWildcardHost('::')).toBe(true)
    expect(isWildcardHost('[::]')).toBe(true)
    expect(isWildcardHost('127.0.0.1')).toBe(false)
  })
})

describe('endpointOrigin / endpointLabel', () => {
  it('IPv4 与 https 用 origin 形态；IPv6 自动加方括号、不带结尾斜杠', () => {
    expect(endpointOrigin(testEndpoint(3080))).toBe('http://127.0.0.1:3080')
    expect(endpointOrigin({ scheme: 'https', host: '127.0.0.1', port: 8443 })).toBe('https://127.0.0.1:8443')
    expect(endpointOrigin({ scheme: 'http', host: '::1', port: 3080 })).toBe('http://[::1]:3080')
    expect(endpointOrigin({ scheme: 'https', host: 'fe80::1', port: 8443 })).toBe('https://[fe80::1]:8443')
    expect(endpointOrigin(testEndpoint(3080))).not.toMatch(/\/$/)
  })

  it('endpointLabel 与 origin 同形（i18n 的 {addr} 参数）', () => {
    const ep: ServiceEndpoint = { scheme: 'https', host: '::1', port: 8443 }
    expect(endpointLabel(ep)).toBe(endpointOrigin(ep))
  })
})

describe('endpointFromSettings（设置片段 → 端点）', () => {
  it('全缺省 → http://127.0.0.1:3080，且不带 caCertPath', () => {
    expect(endpointFromSettings({ port: 3080 })).toEqual({ scheme: 'http', host: DEFAULT_SERVICE_HOST, port: 3080 })
  })

  it('端口夹紧 1..65535（0/负数/超大/小数/非数字）', () => {
    expect(endpointFromSettings({ port: 0 }).port).toBe(1)
    expect(endpointFromSettings({ port: -5 }).port).toBe(1)
    expect(endpointFromSettings({ port: 70000 }).port).toBe(65535)
    expect(endpointFromSettings({ port: 3080.9 }).port).toBe(3080)
    expect(endpointFromSettings({ port: Number.NaN }).port).toBe(3080)
  })

  it('host 非法回退默认；scheme 仅 https 生效；TLS 路径仅 https 且非空时进 caCertPath', () => {
    expect(endpointFromSettings({ port: 3080, serviceHost: 'http://x' }).host).toBe(DEFAULT_SERVICE_HOST)
    expect(endpointFromSettings({ port: 3080, serviceHost: '::1' }).host).toBe('::1')
    expect(endpointFromSettings({ port: 3080, serviceScheme: 'HTTPS' }).scheme).toBe('https')
    expect(endpointFromSettings({ port: 3080, serviceScheme: 'ftp' }).scheme).toBe('http')
    expect(endpointFromSettings({ port: 3080, serviceScheme: 'http', tlsCertPath: 'ca.pem' }).caCertPath).toBeUndefined()
    expect(endpointFromSettings({ port: 8443, serviceScheme: 'https', tlsCertPath: '  D:\\certs\\ca.pem  ' }).caCertPath).toBe('D:\\certs\\ca.pem')
    expect(endpointFromSettings({ port: 8443, serviceScheme: 'https' }).caCertPath).toBeUndefined()
  })
})

describe('endpointFromUrl（launch URL 自适应）', () => {
  it('解析 http/https 与 IPv6；端口缺省按 scheme 取 80/443', () => {
    expect(endpointFromUrl('http://127.0.0.1:3080/?token=abc')).toEqual({ scheme: 'http', host: '127.0.0.1', port: 3080 })
    expect(endpointFromUrl('https://[::1]:8443/')).toEqual({ scheme: 'https', host: '::1', port: 8443 })
    expect(endpointFromUrl('http://[::1]:3080/?token=abc')).toEqual({ scheme: 'http', host: '::1', port: 3080 })
    expect(endpointFromUrl('http://127.0.0.1/')).toEqual({ scheme: 'http', host: '127.0.0.1', port: 80 })
    expect(endpointFromUrl('https://192.168.1.5/')).toEqual({ scheme: 'https', host: '192.168.1.5', port: 443 })
  })

  it('非法 URL / 非 http(s) / 通配地址 → null', () => {
    expect(endpointFromUrl('')).toBeNull()
    expect(endpointFromUrl('not a url')).toBeNull()
    expect(endpointFromUrl('ftp://127.0.0.1:3080/')).toBeNull()
    expect(endpointFromUrl('http://0.0.0.0:3080/')).toBeNull()
  })
})

describe('applyEndpointFlags（默认启动命令自动附加 --host / --tls-*）', () => {
  it('默认回环 + http：命令逐字返回', () => {
    expect(applyEndpointFlags('dsh web --port {port}', testEndpoint(3080))).toBe('dsh web --port {port}')
    expect(applyEndpointFlags('  dsh web --port 3080  ', testEndpoint(3080))).toBe('dsh web --port 3080')
  })

  it('非默认 host 追加 --host（IPv6 不加引号）', () => {
    expect(applyEndpointFlags('dsh web --port 3080', { scheme: 'http', host: '::1', port: 3080 })).toBe(
      'dsh web --port 3080 --host ::1',
    )
    expect(applyEndpointFlags('dsh web --port 3080', { scheme: 'http', host: '192.168.1.5', port: 3080 })).toBe(
      'dsh web --port 3080 --host 192.168.1.5',
    )
  })

  it('https + cert/key 都非空：追加带引号的两个 flag（路径含空格时加引号）', () => {
    const ep: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: 8443, caCertPath: 'C:\\my certs\\ca.pem' }
    expect(applyEndpointFlags('dsh web --port 8443', ep, 'C:\\my certs\\key.pem')).toBe(
      'dsh web --port 8443 --tls-cert "C:\\my certs\\ca.pem" --tls-key "C:\\my certs\\key.pem"',
    )
    // 无空格路径不加引号
    const ep2: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: 8443, caCertPath: 'C:\\certs\\ca.pem' }
    expect(applyEndpointFlags('dsh web --port 8443', ep2, 'C:\\certs\\key.pem')).toBe(
      'dsh web --port 8443 --tls-cert C:\\certs\\ca.pem --tls-key C:\\certs\\key.pem',
    )
  })

  it('https 但 cert/key 缺一：不追加（半截 TLS 参数会让 DSH 启动失败）', () => {
    const noKey: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: 8443, caCertPath: 'ca.pem' }
    expect(applyEndpointFlags('dsh web --port 8443', noKey, '')).toBe('dsh web --port 8443')
    const noCert: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: 8443 }
    expect(applyEndpointFlags('dsh web --port 8443', noCert, 'key.pem')).toBe('dsh web --port 8443')
  })

  it('已有同名 flag 不重复追加（--host / --tls-cert|--tls-key 任一即整对跳过）', () => {
    const ep: ServiceEndpoint = { scheme: 'https', host: '::1', port: 8443, caCertPath: 'ca.pem' }
    expect(applyEndpointFlags('dsh web --port 8443 --host ::1', ep, 'key.pem')).toBe(
      'dsh web --port 8443 --host ::1 --tls-cert ca.pem --tls-key key.pem',
    )
    expect(applyEndpointFlags('dsh web --port 8443 --tls-cert ca.pem --tls-key key.pem', ep, 'key.pem')).toBe(
      'dsh web --port 8443 --tls-cert ca.pem --tls-key key.pem --host ::1',
    )
    // 仅有一个 TLS flag 也按「已有」处理，不补另一半
    expect(applyEndpointFlags('dsh web --port 8443 --tls-cert x.pem', ep, 'key.pem')).toBe(
      'dsh web --port 8443 --tls-cert x.pem --host ::1',
    )
  })

  it('空命令返回空串（无可附加对象）', () => {
    expect(applyEndpointFlags('', { scheme: 'https', host: '::1', port: 8443, caCertPath: 'ca.pem' }, 'key.pem')).toBe('')
  })
})

describe('quoteCommandArg', () => {
  it('无空白无引号原样；含空白加双引号；内部 " 转义为 \\"；反斜杠原样保留', () => {
    expect(quoteCommandArg('abc')).toBe('abc')
    expect(quoteCommandArg('')).toBe('')
    expect(quoteCommandArg('-p 3080')).toBe('"-p 3080"')
    expect(quoteCommandArg('a"b')).toBe('"a\\"b"')
    expect(quoteCommandArg('C:\\Program Files\\x.pem')).toBe('"C:\\Program Files\\x.pem"')
    expect(quoteCommandArg('C:\\certs\\ca.pem')).toBe('C:\\certs\\ca.pem')
  })
})

describe('testEndpoint（测试辅助构造器）', () => {
  it('默认 127.0.0.1 + http，可指定 host', () => {
    expect(testEndpoint(3080)).toEqual({ scheme: 'http', host: '127.0.0.1', port: 3080 })
    expect(testEndpoint(3081, '::1')).toEqual({ scheme: 'http', host: '::1', port: 3081 })
  })
})

describe('tlsErrorKind（证书错误分类：供外壳层选可读文案）', () => {
  const withCode = (code: string, message = 'boom'): Error => Object.assign(new Error(message), { code })
  it('未受信任类：自签名 / 链路不可验证 / 缺签发者', () => {
    expect(tlsErrorKind(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('untrusted')
    expect(tlsErrorKind(withCode('SELF_SIGNED_CERT_IN_CHAIN'))).toBe('untrusted')
    expect(tlsErrorKind(withCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe('untrusted')
    expect(tlsErrorKind(withCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))).toBe('untrusted')
  })
  it('SAN 不含地址 / 过期', () => {
    expect(tlsErrorKind(withCode('ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname/IP does not match certificate'))).toBe('altname')
    expect(tlsErrorKind(withCode('CERT_HAS_EXPIRED'))).toBe('expired')
  })
  it('非 TLS 错误 → none；其它证书问题 → other', () => {
    expect(tlsErrorKind(withCode('ECONNREFUSED'))).toBe('none')
    expect(tlsErrorKind(undefined)).toBe('none')
    expect(tlsErrorKind(new Error('socket hang up'))).toBe('none')
    expect(tlsErrorKind(withCode('ERR_TLS_CERT_ALTNAME_INVALID_WEIRD', 'certificate problem'))).toBe('altname')
  })
})

describe('endpointRequest（真实本地 http server）', () => {
  let server: Server
  let port = 0
  let lastBody = ''
  const seen: { method?: string; url?: string; host?: string; type?: string; length?: string }[] = []

  beforeAll(async () => {
    server = createHttpServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const url = req.url ?? ''
        seen.push({
          method: req.method,
          url,
          host: req.headers.host ?? '',
          type: String(req.headers['content-type'] ?? ''),
          length: String(req.headers['content-length'] ?? ''),
        })
        if (url === '/slow') {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('late')
          }, 200)
          return
        }
        if (url === '/missing') {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        if (url === '/setcookie') {
          res.writeHead(200, { 'set-cookie': ['dsh-auth-A=v1.x.y; Path=/', 'other=1'], 'content-type': 'text/plain' })
          res.end('cookie')
          return
        }
        if (url === '/echo') {
          lastBody = Buffer.concat(chunks).toString('utf8')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html', 'x-test': 'yes' })
        res.end('hello')
      })
    })
    port = await listen(server)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('GET 返回 status / text / headers / setCookie 首值', async () => {
    const res = await endpointRequest(testEndpoint(port), { path: '/', method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.text).toBe('hello')
    expect(res.headers['x-test']).toBe('yes')
    expect(res.setCookie).toBe('')
    const withCookie = await endpointRequest(testEndpoint(port), { path: '/setcookie', method: 'GET' })
    expect(withCookie.setCookie).toBe('dsh-auth-A=v1.x.y; Path=/')
  })

  it('POST 自动带 content-type / content-length，body 原样送达', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session/list', payload: {} })
    const res = await endpointRequest(testEndpoint(port), { path: '/echo', method: 'POST', body })
    expect(res.status).toBe(200)
    expect(lastBody).toBe(body)
    const call = seen.find((s) => s.url === '/echo')
    expect(call?.type).toBe('application/json')
    expect(call?.length).toBe(String(Buffer.byteLength(body)))
  })

  it('Host 头为 <host>:<port>（自定义 header 不覆盖）', async () => {
    await endpointRequest(testEndpoint(port), { path: '/', method: 'GET' })
    expect(seen[seen.length - 1]?.host).toBe(`127.0.0.1:${String(port)}`)
  })

  it('404 等非 2xx 状态原样返回（不抛错，由上层判定）', async () => {
    const res = await endpointRequest(testEndpoint(port), { path: '/missing', method: 'GET' })
    expect(res.status).toBe(404)
    expect(res.text).toBe('not found')
  })

  it('超时 → 可读 Error，code=ETIMEDOUT', async () => {
    await expect(endpointRequest(testEndpoint(port), { path: '/slow', method: 'GET', timeoutMs: 30 })).rejects.toThrow(
      /timed out after 30ms/,
    )
    await expect(endpointRequest(testEndpoint(port), { path: '/slow', method: 'GET', timeoutMs: 30 })).rejects.toMatchObject(
      { code: 'ETIMEDOUT' },
    )
  })

  it('连接被拒 → message 保留原始 err.code（ECONNREFUSED）', async () => {
    // 先取一个确定无人监听的端口（listen 后立刻关掉）
    const probe = createHttpServer()
    const deadPort = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    await expect(endpointRequest(testEndpoint(deadPort), { path: '/', method: 'GET', timeoutMs: 500 })).rejects.toMatchObject(
      { code: 'ECONNREFUSED' },
    )
    await expect(endpointRequest(testEndpoint(deadPort), { path: '/', method: 'GET', timeoutMs: 500 })).rejects.toThrow(
      /code=ECONNREFUSED/,
    )
  })

  it('按 ep.host 建立连接（本机回环地址可换 localhost，Host 头同步）', async () => {
    const res = await endpointRequest(testEndpoint(port, 'localhost'), { path: '/', method: 'GET', timeoutMs: 3000 })
    expect(res.status).toBe(200)
    expect(res.text).toBe('hello')
  })
})

describe('endpointRequest https（证书路径 / 严格校验）', () => {
  it('传入不存在的证书路径 → 可读错误（不发起网络请求）', async () => {
    const ep: ServiceEndpoint = {
      scheme: 'https',
      host: '127.0.0.1',
      port: 1,
      caCertPath: join(tmpdir(), `dsh-nope-${String(process.pid)}-${String(Date.now())}.pem`),
    }
    await expect(endpointRequest(ep, { path: '/', method: 'GET', timeoutMs: 500 })).rejects.toThrow(
      /cannot read TLS certificate: /,
    )
  })

  describe.skipIf(!OPENSSL_AVAILABLE)('自签证书（openssl 生成临时证书）', () => {
    let dir = ''
    let certPath = ''
    let keyPath = ''
    let httpsServer: HttpsServer | null = null
    let httpsPort = 0

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'dsh-tls-test-'))
      certPath = join(dir, 'cert.pem')
      keyPath = join(dir, 'key.pem')
      // Windows 上部分 openssl 发行版（如 conda）把默认 openssl.cnf 编到不存在的路径，
      // 不带 -config 会直接失败；这里自带最小配置，任何发行版都能生成临时自签证书。
      const configPath = join(dir, 'openssl.cnf')
      writeFileSync(
        configPath,
        [
          '[ req ]',
          'distinguished_name = dn',
          'prompt = no',
          '',
          '[ dn ]',
          'CN = 127.0.0.1',
          '',
          '[ v3_req ]',
          'subjectAltName = @alt_names',
          '',
          '[ alt_names ]',
          'IP.1 = 127.0.0.1',
          'DNS.1 = localhost',
          '',
        ].join('\n'),
        'utf8',
      )
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath, '-out', certPath,
          '-days', '36500',
          '-config', configPath,
          '-extensions', 'v3_req',
        ],
        { stdio: 'ignore', timeout: 60000 },
      )
      httpsServer = createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('secure')
      })
      httpsPort = await listen(httpsServer)
    })

    afterAll(async () => {
      if (httpsServer !== null) await new Promise<void>((resolve) => httpsServer?.close(() => resolve()))
      if (dir !== '') rmSync(dir, { recursive: true, force: true })
    })

    it('caCertPath 指向自签证书 → 严格校验通过，返回 200', async () => {
      const ep: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: httpsPort, caCertPath: certPath }
      const res = await endpointRequest(ep, { path: '/', method: 'GET', timeoutMs: 3000 })
      expect(res.status).toBe(200)
      expect(res.text).toBe('secure')
    })

    it('未填 caCertPath（无信任锚）→ 拒绝自签证书，message 保留原始 code', async () => {
      const ep: ServiceEndpoint = { scheme: 'https', host: '127.0.0.1', port: httpsPort }
      const err = await endpointRequest(ep, { path: '/', method: 'GET', timeoutMs: 3000 }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      )
      expect(err).not.toBeNull()
      expect(err?.message).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/)
      expect(err?.code).toBeTruthy()
      expect(err?.message).toContain(String(err?.code))
      // 外壳层据此归类到「证书未受信任」文案
      expect(tlsErrorKind(err)).toBe('untrusted')
    })
  })
})
