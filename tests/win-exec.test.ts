import { describe, expect, it } from 'vitest'
import { execKey, resolveExec } from '../src/win-exec'

describe('resolveExec（Windows .cmd shim 包装）', () => {
  it('win32 下 npm 系命令经 cmd.exe /d /s /c 包装', () => {
    expect(resolveExec('win32', 'npm', ['install', '-g', 'x'])).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'install', '-g', 'x'],
    })
    expect(resolveExec('win32', 'npx', ['--yes', 'dsh-fix']).args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(resolveExec('win32', 'pnpm', ['-v']).args[3]).toBe('pnpm')
    expect(resolveExec('win32', 'dsh-fix', ['doctor']).command).toBe('cmd.exe')
    expect(resolveExec('win32', 'dsh', ['web']).command).toBe('cmd.exe')
    expect(resolveExec('win32', 'dsh-doctor', ['scan']).command).toBe('cmd.exe')
  })

  it('win32 下真二进制（git/winget/powershell.exe）不包装', () => {
    expect(resolveExec('win32', 'git', ['clone', 'x'])).toEqual({ command: 'git', args: ['clone', 'x'] })
    expect(resolveExec('win32', 'winget', ['install']).command).toBe('winget')
    expect(resolveExec('win32', 'powershell.exe', ['-NoProfile']).command).toBe('powershell.exe')
    expect(resolveExec('win32', 'taskkill', ['/F']).command).toBe('taskkill')
  })

  it('posix 一律不包装', () => {
    expect(resolveExec('posix', 'npm', ['-v'])).toEqual({ command: 'npm', args: ['-v'] })
    expect(resolveExec('darwin', 'dsh-fix', ['safe']).command).toBe('dsh-fix')
  })
})

describe('execKey（还原语义参数串）', () => {
  it('剥离 cmd.exe 包装后等价于原参数串', () => {
    expect(execKey('cmd.exe', ['/d', '/s', '/c', 'npm', 'install', '-g', 'x'])).toBe('install -g x')
    expect(execKey('npm', ['install', '-g', 'x'])).toBe('install -g x')
  })

  it('非包装调用原样返回', () => {
    expect(execKey('git', ['clone', '--depth', '1', 'url', 'dir'])).toBe('clone --depth 1 url dir')
  })
})
