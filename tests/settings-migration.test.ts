import { describe, expect, it } from 'vitest'
import { installModeFor, migrateBridgeMode, normalizeBridgeInputMode } from '../src/bridge-mode'
import { DEFAULT_SERVICE_HOST, endpointFromSettings } from '../src/service-endpoint'

describe('migrateBridgeMode（旧布尔 → 三选项迁移）', () => {
  it('true → auto（旧开关开，默认自动发送）', () => {
    expect(migrateBridgeMode(true)).toBe('auto')
  })
  it('false → off（旧开关关，关闭桥接）', () => {
    expect(migrateBridgeMode(false)).toBe('off')
  })
  it('已是合法三选项 → null（不迁移不写盘）', () => {
    expect(migrateBridgeMode('auto')).toBeNull()
    expect(migrateBridgeMode('off')).toBeNull()
    expect(migrateBridgeMode('rightClick')).toBeNull()
  })
  it('未知/缺失值 → null（保持默认）', () => {
    expect(migrateBridgeMode(undefined)).toBeNull()
    expect(migrateBridgeMode('xxx')).toBeNull()
    expect(migrateBridgeMode(42)).toBeNull()
  })
})

describe('v2.9.0 新键（serviceHost / serviceScheme / tlsCertPath / tlsKeyPath）的默认值与脏值归一', () => {
  const base = { port: 3080 }

  it('旧 data.json 没有这些键 → 端点取默认值（回环 http，不带证书）', () => {
    expect(endpointFromSettings(base)).toEqual({ scheme: 'http', host: DEFAULT_SERVICE_HOST, port: 3080 })
  })

  it('serviceHost 脏值一律回默认 127.0.0.1（不把脏值带进探活/请求）', () => {
    const dirty = [null, undefined, '', '   ', 'http://127.0.0.1', '127.0.0.1:3080', '0.0.0.0', '::', 'fe80::1%12', 'some.host']
    for (const v of dirty) {
      expect(endpointFromSettings({ ...base, serviceHost: v as unknown as string }).host).toBe(DEFAULT_SERVICE_HOST)
    }
  })

  it('合法 host 归一：方括号去括号、大小写小写、两端空白 trim', () => {
    expect(endpointFromSettings({ ...base, serviceHost: '[::1]' }).host).toBe('::1')
    expect(endpointFromSettings({ ...base, serviceHost: 'LOCALHOST' }).host).toBe('localhost')
    expect(endpointFromSettings({ ...base, serviceHost: ' 192.168.1.5 ' }).host).toBe('192.168.1.5')
    expect(endpointFromSettings({ ...base, serviceHost: '[::FFFF:0:0]' }).host).toBe('::ffff:0:0')
  })

  it('serviceScheme 仅 https 生效；缺省 / 脏值 / 大小写 / 非字符串一律按 http', () => {
    expect(endpointFromSettings({ ...base, serviceScheme: undefined }).scheme).toBe('http')
    expect(endpointFromSettings({ ...base, serviceScheme: 'ftp' }).scheme).toBe('http')
    expect(endpointFromSettings({ ...base, serviceScheme: 'HTTP' }).scheme).toBe('http')
    expect(endpointFromSettings({ ...base, serviceScheme: 'HTTPS' }).scheme).toBe('https')
    expect(endpointFromSettings({ ...base, serviceScheme: 1 as unknown as string }).scheme).toBe('http')
  })

  it('TLS 证书路径 trim；仅 https 且非空才进端点（http 下不携带陈旧路径）', () => {
    expect(endpointFromSettings({ ...base, serviceScheme: 'http', tlsCertPath: ' C:\\certs\\a.pem ' })).toEqual({
      scheme: 'http',
      host: DEFAULT_SERVICE_HOST,
      port: 3080,
    })
    expect(endpointFromSettings({ ...base, serviceScheme: 'https', tlsCertPath: ' C:\\certs\\a.pem ' }).caCertPath).toBe('C:\\certs\\a.pem')
    expect(endpointFromSettings({ ...base, serviceScheme: 'https', tlsCertPath: '   ' }).caCertPath).toBeUndefined()
  })

  it('端口脏值夹紧 1..65535（旧行为不变）', () => {
    expect(endpointFromSettings({ port: 0 }).port).toBe(1)
    expect(endpointFromSettings({ port: 70000 }).port).toBe(65535)
    expect(endpointFromSettings({ port: Number.NaN }).port).toBe(3080)
  })
})

describe('v2.8.0 填充写入方式（bridgeInputMode）与其推导的条目形态', () => {
  it('归一：dom 保留；其余（缺省/脏值/旧 data.json 无该键）一律 auto', () => {
    expect(normalizeBridgeInputMode('dom')).toBe('dom')
    expect(normalizeBridgeInputMode('auto')).toBe('auto')
    expect(normalizeBridgeInputMode(undefined)).toBe('auto')
    expect(normalizeBridgeInputMode(null)).toBe('auto')
    expect(normalizeBridgeInputMode('package')).toBe('auto')
    expect(normalizeBridgeInputMode(0)).toBe('auto')
  })
  it('形态：auto → package（裸包名，装载器唯一认客户端半的形态）；dom → path（历史形态）', () => {
    expect(installModeFor('auto')).toBe('package')
    expect(installModeFor('dom')).toBe('path')
  })
})
