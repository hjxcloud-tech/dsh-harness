import { describe, expect, it } from 'vitest'
import { migrateBridgeMode } from '../src/bridge-mode'

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
