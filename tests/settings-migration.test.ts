import { describe, expect, it } from 'vitest'
import { installModeFor, migrateBridgeMode, normalizeBridgeInputMode } from '../src/bridge-mode'

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
