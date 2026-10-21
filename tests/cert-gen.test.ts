import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicKey, sign, verify, X509Certificate } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpsRequest, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { defaultCertDir, desktopDir, detectLanIPv4, generateCerts, type GeneratedCerts } from '../src/cert-gen'
import { tempDir } from './temp-track'

const DAY_MS = 24 * 60 * 60 * 1000

/** 造一条 networkInterfaces() 条目（注入用真值表）。 */
function iface(address: string, overrides: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const family = address.includes(':') ? 'IPv6' : 'IPv4'
  return {
    address,
    netmask: family === 'IPv6' ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
    family,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: family === 'IPv6' ? `${address}/64` : `${address}/24`,
    ...overrides,
  }
}

function sanEntries(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? '').split(',').map((entry) => entry.trim())
}

/** 起本地 HTTPS 服务并返回随机端口。 */
async function listen(server: HttpsServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return address.port
}

/** 一次严格校验的 HTTPS GET（ca 为空则用系统信任库）。 */
async function httpsGet(port: number, ca?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path: '/', method: 'GET', ca, rejectUnauthorized: true, agent: false },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('detectLanIPv4（注入 interfaces 真值表）', () => {
  it('全是 internal / 169.254 / 127/8 / IPv6 → null', () => {
    const interfaces = {
      lo: [iface('127.0.0.1', { internal: true })],
      ethernet: [iface('169.254.10.20'), iface('fe80::1234')],
    }
    expect(detectLanIPv4(interfaces)).toBeNull()
  })

  it('取接口枚举顺序中的第一个有效 IPv4（局域网优先于后者）', () => {
    const interfaces = {
      wifi: [iface('192.168.1.23')],
      ethernet: [iface('10.0.0.8')],
    }
    expect(detectLanIPv4(interfaces)).toBe('192.168.1.23')
  })

  it('跳过 internal 条目，取同接口的下一个有效 IPv4', () => {
    const interfaces = {
      ethernet: [iface('10.0.0.8', { internal: true }), iface('10.0.0.9')],
    }
    expect(detectLanIPv4(interfaces)).toBe('10.0.0.9')
  })

  it('跳过非 internal 的 127/8 与 169.254，取真正的局域网地址', () => {
    const interfaces = {
      weird: [iface('127.0.0.2'), iface('169.254.3.4'), iface('172.16.5.6')],
    }
    expect(detectLanIPv4(interfaces)).toBe('172.16.5.6')
  })

  it('空 interfaces / 空接口列表 → null', () => {
    expect(detectLanIPv4({})).toBeNull()
    expect(detectLanIPv4({ empty: [] })).toBeNull()
  })

  it('默认参数读真实网卡：返回 null 或合法 IPv4（且非回环/链路本地）', () => {
    const detected = detectLanIPv4()
    if (detected !== null) {
      expect(isIP(detected)).toBe(4)
      expect(detected.startsWith('127.')).toBe(false)
      expect(detected.startsWith('169.254.')).toBe(false)
    } else {
      expect(detected).toBeNull()
    }
  })
})

describe('desktopDir（注入 home 三态）', () => {
  it('~/Desktop 存在 → 返回它', () => {
    const home = tempDir('dsh-certgen-home-')
    mkdirSync(join(home, 'Desktop'))
    expect(desktopDir(home)).toBe(join(home, 'Desktop'))
  })

  it('只有 ~/OneDrive/Desktop 存在 → 返回它', () => {
    const home = tempDir('dsh-certgen-home-')
    mkdirSync(join(home, 'OneDrive', 'Desktop'), { recursive: true })
    expect(desktopDir(home)).toBe(join(home, 'OneDrive', 'Desktop'))
  })

  it('只有中文「桌面」存在 → 返回它', () => {
    const home = tempDir('dsh-certgen-home-')
    mkdirSync(join(home, '桌面'))
    expect(desktopDir(home)).toBe(join(home, '桌面'))
  })

  it('多个候选同时存在 → 优先级 Desktop > OneDrive/Desktop > 桌面', () => {
    const home = tempDir('dsh-certgen-home-')
    mkdirSync(join(home, 'Desktop'))
    mkdirSync(join(home, 'OneDrive', 'Desktop'), { recursive: true })
    mkdirSync(join(home, '桌面'))
    expect(desktopDir(home)).toBe(join(home, 'Desktop'))
  })

  it('三个候选都不存在 → 抛 desktop-missing（带候选路径，供弹窗展示）', () => {
    const home = tempDir('dsh-certgen-home-')
    let caught: (Error & { code?: string }) | null = null
    try {
      desktopDir(home)
    } catch (error) {
      caught = error as Error & { code?: string }
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('desktop-missing')
    expect(caught?.message).toContain('desktop-missing')
    expect(caught?.message).toContain(join(home, 'Desktop'))
  })
})

describe('defaultCertDir', () => {
  it('返回 <home>/.dsh-obsidian/certs 并自动创建目录', () => {
    const home = tempDir('dsh-certgen-home-')
    const dir = defaultCertDir(home)
    expect(dir).toBe(join(home, '.dsh-obsidian', 'certs'))
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('重复调用幂等（已存在时不抛）', () => {
    const home = tempDir('dsh-certgen-home-')
    expect(defaultCertDir(home)).toBe(defaultCertDir(home))
  })
})

// 共享一次生成：解析 / SAN / 私钥匹配 / 真 TLS 都复用它，避免每次 RSA-2048 生成的开销。
let outDir = ''
let deskDir = ''
let certs: GeneratedCerts

beforeAll(async () => {
  outDir = tempDir('dsh-certgen-out-')
  deskDir = tempDir('dsh-certgen-desk-')
  certs = await generateCerts({
    hosts: ['localhost', '127.0.0.1', '::1'],
    outDir,
    desktopDir: deskDir,
    validDays: 2,
  })
})

describe('generateCerts（产物与证书内容）', () => {
  it('裸 PEM 写入 outDir/cert.pem、outDir/key.pem，证书 PEM 原样写桌面 rootCA.pem', () => {
    expect(certs.certPath).toBe(join(outDir, 'cert.pem'))
    expect(certs.keyPath).toBe(join(outDir, 'key.pem'))
    expect(certs.rootCaPath).toBe(join(deskDir, 'rootCA.pem'))
    expect(statSync(certs.certPath).isFile()).toBe(true)
    expect(statSync(certs.keyPath).isFile()).toBe(true)
    expect(statSync(certs.rootCaPath).isFile()).toBe(true)

    expect(certs.certPem.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true)
    expect(certs.certPem.trimEnd().endsWith('-----END CERTIFICATE-----')).toBe(true)
    expect(readFileSync(certs.certPath, 'utf8')).toBe(certs.certPem)
    expect(readFileSync(certs.rootCaPath, 'utf8')).toBe(certs.certPem)
    expect(readFileSync(certs.keyPath, 'utf8').startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
  })

  it('显式 hosts 全为回环时 host 取 hosts[0]；hosts 去重保序', async () => {
    expect(certs.host).toBe('localhost')
    expect(certs.hosts).toEqual(['localhost', '127.0.0.1', '::1'])
    const deduped = await generateCerts({
      hosts: ['127.0.0.1', 'localhost', '127.0.0.1'],
      outDir: tempDir('dsh-certgen-out-'),
      desktopDir: tempDir('dsh-certgen-desk-'),
      validDays: 2,
    })
    expect(deduped.hosts).toEqual(['127.0.0.1', 'localhost'])
    expect(deduped.host).toBe('127.0.0.1')
  })

  it('X509Certificate 可解析：CN/CA:TRUE/keyUsage(serverAuth) 正确', () => {
    const cert = new X509Certificate(certs.certPem)
    expect(cert.subject).toContain('CN=DSH Obsidian')
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.ca).toBe(true)
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1')
  })

  it('SAN 覆盖 DNS:localhost、IP 127.0.0.1、IP ::1（IPv6 渲染展开形态）', () => {
    const entries = sanEntries(new X509Certificate(certs.certPem))
    expect(entries).toContain('DNS:localhost')
    expect(entries).toContain('IP Address:127.0.0.1')
    // Node/OpenSSL 把 16 字节 iPAddress 打印成展开形式；两种形态都接受
    expect(entries.some((entry) => /^IP Address:(::1|0:0:0:0:0:0:0:1)$/.test(entry))).toBe(true)
    expect(entries).toHaveLength(3)
  })

  it('有效期：notBefore/notAfter 为秒精度 ISO，跨度 = validDays，且与 X509 解析一致', () => {
    const cert = new X509Certificate(certs.certPem)
    expect(certs.notBefore.endsWith('.000Z')).toBe(true)
    expect(certs.notAfter.endsWith('.000Z')).toBe(true)
    const before = Date.parse(certs.notBefore)
    const after = Date.parse(certs.notAfter)
    expect(after - before).toBe(2 * DAY_MS)
    expect(before).toBeLessThanOrEqual(Date.now())
    expect(after).toBeGreaterThan(Date.now())
    expect(Date.parse(cert.validFrom)).toBe(before)
    expect(Date.parse(cert.validTo)).toBe(after)
  })

  it('默认有效期为 825 天', async () => {
    const generated = await generateCerts({
      hosts: ['127.0.0.1'],
      outDir: tempDir('dsh-certgen-out-'),
      desktopDir: tempDir('dsh-certgen-desk-'),
    })
    expect(Date.parse(generated.notAfter) - Date.parse(generated.notBefore)).toBe(825 * DAY_MS)
  })

  it('now 注入：按秒截断（毫秒被丢弃）', async () => {
    const now = new Date('2024-01-02T03:04:05.678Z')
    const generated = await generateCerts({
      hosts: ['127.0.0.1'],
      outDir: tempDir('dsh-certgen-out-'),
      desktopDir: tempDir('dsh-certgen-desk-'),
      validDays: 4000,
      now,
    })
    expect(generated.notBefore).toBe('2024-01-02T03:04:05.000Z')
    expect(generated.notAfter).toBe(new Date(Date.parse('2024-01-02T03:04:05.000Z') + 4000 * DAY_MS).toISOString())
    const cert = new X509Certificate(generated.certPem)
    expect(Date.parse(cert.validFrom)).toBe(Date.parse(generated.notBefore))
  })

  it('私钥与证书匹配（SPKI 相同 + 签名/验签往返）', () => {
    const keyPem = readFileSync(certs.keyPath, 'utf8')
    const certPublicKey = createPublicKey(certs.certPem)
    const keyPublicKey = createPublicKey(keyPem)
    expect(keyPublicKey.export({ type: 'spki', format: 'der' })).toEqual(
      certPublicKey.export({ type: 'spki', format: 'der' }),
    )
    const data = Buffer.from('cert-gen-key-match', 'utf8')
    const signature = sign('sha256', data, keyPem)
    expect(verify('sha256', data, certPublicKey, signature)).toBe(true)
  })

  it('自签签名可自验证（证书 DER 结构自洽）', () => {
    const cert = new X509Certificate(certs.certPem)
    expect(cert.verify(cert.publicKey)).toBe(true)
  })
})

describe('真 TLS 自检（本地 https 服务 + 严格校验）', () => {
  let server: HttpsServer | null = null
  let port = 0

  beforeAll(async () => {
    server = createServer({ cert: readFileSync(certs.certPath), key: readFileSync(certs.keyPath) }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('secure')
    })
    port = await listen(server)
  })

  afterAll(async () => {
    const current = server
    server = null
    if (current !== null) {
      await new Promise<void>((resolve) => {
        current.close(() => {
          resolve()
        })
      })
    }
  })

  it('ca 指向生成的证书 → 严格校验通过，返回 200', async () => {
    const res = await httpsGet(port, certs.certPem)
    expect(res.status).toBe(200)
    expect(res.body).toBe('secure')
  })

  it('ca 指向桌面 rootCA.pem（同一份 PEM）→ 同样 200', async () => {
    const res = await httpsGet(port, readFileSync(certs.rootCaPath, 'utf8'))
    expect(res.status).toBe(200)
  })

  it('不带 ca（无信任锚）→ 自签证书必须被拒，且保留原始 code', async () => {
    const error = await httpsGet(port).then(
      () => null,
      (reason: Error & { code?: string }) => reason,
    )
    expect(error).not.toBeNull()
    // Node 24/OpenSSL 3：message 为 "self-signed certificate; ..."，code 为 DEPTH_ZERO_SELF_SIGNED_CERT
    expect(error?.message).toMatch(/self-signed|SELF_SIGNED|UNABLE_TO_VERIFY/i)
    expect(error?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
  })
})

describe('generateCerts 异常路径', () => {
  it('hosts 为空且检测不到 LAN → 抛 no-lan-address，且不写任何文件', async () => {
    const emptyDir = tempDir('dsh-certgen-out-')
    const error = await generateCerts({ hosts: [], outDir: emptyDir, desktopDir: tempDir('dsh-certgen-desk-') }).then(
      () => null,
      (reason: Error & { code?: string }) => reason,
    )
    expect(error).not.toBeNull()
    expect(error?.code).toBe('no-lan-address')
    expect(error?.message).toContain('no-lan-address')
    // 失败发生在“写文件”之前：输出目录里不应有 cert.pem/key.pem
    expect(readdirSync(emptyDir)).toEqual([])
  })

  it('hosts 含非法字符 → 抛 invalid-host（不生成半成品）', async () => {
    const error = await generateCerts({
      hosts: ['bad host'],
      outDir: tempDir('dsh-certgen-out-'),
      desktopDir: tempDir('dsh-certgen-desk-'),
    }).then(
      () => null,
      (reason: Error & { code?: string }) => reason,
    )
    expect(error?.code).toBe('invalid-host')
  })

  it('validDays 非正数 → 抛 invalid-valid-days', async () => {
    const error = await generateCerts({
      hosts: ['127.0.0.1'],
      outDir: tempDir('dsh-certgen-out-'),
      desktopDir: tempDir('dsh-certgen-desk-'),
      validDays: 0,
    }).then(
      () => null,
      (reason: Error & { code?: string }) => reason,
    )
    expect(error?.code).toBe('invalid-valid-days')
  })
})
