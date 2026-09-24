# -*- coding: utf-8 -*-
"""
桥接页面半（DOM 锚点）跨 DSH 版本 A/B 对照（本地开发工具，不进发布物）

为什么单独做这个：宿主半（tapIndex 注入、认证适配器、补丁层、profile）能用 HTTP + 文件系统取证；
但桥接的**框选注入 / 路径回跳 / [[wikilink]] / 焦点与选区协议**全部依赖渲染后的 DOM 锚点，
必须把页面跑起来才知道。为了让两边**只差 DSH 版本**：
  ① 把 ~/.dsh 的 sessions/storages 各复制一份到两个隔离 home（同数据）；
  ② 分别用「基线版本 bin.js」与「待验版本 bin.js」起服务；
  ③ 两边都点开**同一个会话**，逐项比对桥接真实用到的锚点与行为。

比对项（全部取自 src/bridge.ts 实际使用的选择器，不凭印象）：
  C1 桥接与引导标记        window.__DSH_OBSIDIAN_BRIDGE__ / __DSH_BOOT__ / embed token 长度
  C2 可编辑元素与 composer  [contenteditable="true"] 计数、首个可见的 tag/role/data-phase
  C3 data-phase 取值集合    脚本以 textarea[data-phase] 为旧形态兜底，phase 集合是判据
  C4 会话与消息渲染         侧栏条目数、消息节点数、是否出现「失败」类文案
  C5 路径锚点              带 title 且含路径分隔符的元素数（桥接靠 title/textContent 认路径）
  C6 [[wikilink]] 前提      正文里 "[[" 出现次数；注解器产出的 a.dsh-wikilink 数
  C7 填充协议可达性         宿主 postMessage dsh-fill-draft → 是否回 dsh-fill-ack
                            注意教训 #12：headless Chromium 里 Lexical 写入可能整体不生效，
                            此项只验「消息被接住 + 有回执」，写入效果必须真机 Electron 复验

用法：
  python scripts/bridge-ab-dom.py --a-bin "<基线 bin.js>" --b-bin "<新版 bin.js>"
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

TEMP = Path(os.environ["TEMP"])
SRC_HOME = Path.home() / ".dsh"
SESSION_DIRS = ("sessions", "storages")
EXTRA_FILES = ("settings.yaml", ".anonymous-user-id")


def log(m: str) -> None:
    print(m, flush=True)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def make_home(tag: str, repo: Path) -> Path:
    """隔离 home：会话数据两边同源（复制，不碰真实 ~/.dsh）。"""
    home = TEMP / f"dsh-ab-{tag}"
    if home.exists():
        shutil.rmtree(home, ignore_errors=True)
    home.mkdir(parents=True)
    for d in SESSION_DIRS:
        src = SRC_HOME / d
        if src.exists():
            subprocess.run(["robocopy", str(src), str(home / d), "/E", "/NFL", "/NDL", "/NJH", "/NJS"], check=False)
    for f in EXTRA_FILES:
        if (SRC_HOME / f).exists():
            shutil.copy2(SRC_HOME / f, home / f)
    r = subprocess.run(["node", "scripts/gen-bridge-into.mjs", str(home)], cwd=str(repo),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        log(f"FATAL gen-bridge-into({tag}) 失败：{(r.stderr or r.stdout)[:300]}")
        sys.exit(2)
    n = len(list((home / "sessions").rglob("session.jsonl.zstd"))) if (home / "sessions").exists() else 0
    log(f"[setup] home {tag} 会话文件数={n}")
    return home


def boot(bin_js: Path, home: Path):
    port = free_port()
    proc = subprocess.Popen(["node", str(bin_js), "web", "--port", str(port), "--no-open"],
                            env={**os.environ, "DSH_HOME": str(home)},
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace")
    out, deadline = "", time.time() + 150
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        out += line
        m = re.search(r"token=([A-Za-z0-9_.-]{20,})", out)
        if m:
            return proc, port, m.group(1)
    proc.kill()
    log(f"FATAL 起不来：{bin_js}\n{out[-400:]}")
    sys.exit(2)


PROBE = r"""() => {
  const vis = (e) => !!(e && e.offsetParent !== null);
  const eds = [...document.querySelectorAll('[contenteditable="true"]')];
  const comp = eds.find((e) => e.isContentEditable && vis(e)) || null;
  const titles = [...document.querySelectorAll('[title]')]
    .map((e) => e.getAttribute('title') || '')
    .filter((t) => /[\\/]/.test(t) && t.length > 3);
  const body = document.body.innerText || '';
  return {
    bridge: !!window.__DSH_OBSIDIAN_BRIDGE__,
    bootMarker: !!window.__DSH_BOOT__,
    embedTokenLen: (window.__DSH_EMBED_TOKEN__ || '').length,
    editableTotal: eds.length,
    editableVisible: eds.filter(vis).length,
    composer: comp ? {
      tag: comp.tagName.toLowerCase(),
      role: comp.getAttribute('role') || '',
      phase: comp.getAttribute('data-phase') || '',
      ce: String(comp.getAttribute('contenteditable')),
      ph: (comp.getAttribute('data-placeholder') || comp.getAttribute('placeholder') || '').slice(0, 24),
    } : null,
    legacyTextarea: !!document.querySelector('textarea[data-phase]') || !!document.querySelector('textarea'),
    phaseStates: [...new Set([...document.querySelectorAll('[data-phase]')].map((e) => e.getAttribute('data-phase')))].sort(),
    sidebarItems: document.querySelectorAll('[class*=session],[class*=conversation],[class*=thread]').length,
    bubbles: document.querySelectorAll('[class*=message],[class*=markdown],[class*=prose]').length,
    pathTitleEls: titles.length,
    pathTitleSample: titles[0] ? titles[0].slice(0, 60) : '',
    wikiTextHits: (body.match(/\[\[/g) || []).length,
    wikiLinkEls: document.querySelectorAll('a.dsh-wikilink').length,
    failTexts: ['上传失败', '失败'].filter((k) => body.includes(k)),
  };
}"""

FILL = r"""async () => {
  const MARK = 'AB-DOM-PROBE-MARKER';
  const got = new Promise((res) => {
    const h = (e) => { const d = e.data || {}; if (d.type === 'dsh-fill-ack') { window.removeEventListener('message', h); res({ack: true, ok: d.ok, had: d.had}); } };
    window.addEventListener('message', h);
    setTimeout(() => res({ack: false}), 4000);
  });
  window.postMessage({type: 'dsh-fill-draft', text: MARK + ' 第一行\n第二行'}, '*');
  const r = await got;
  const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter((e) => e.isContentEditable && e.offsetParent !== null);
  r.composerHasMark = eds.some((e) => (e.innerText || '').includes(MARK));
  return r;
}"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--a-bin', required=True, help='基线版本 bin.js')
    ap.add_argument('--b-bin', required=True, help='待验版本 bin.js')
    ap.add_argument('--title', default='清理c盘', help='两边共用的会话标题（用于点开同一会话做公平对照）')
    args = ap.parse_args()
    repo = Path(__file__).resolve().parent.parent
    a_bin, b_bin = Path(os.path.expandvars(args.a_bin)), Path(os.path.expandvars(args.b_bin))
    for p in (a_bin, b_bin):
        if not p.exists():
            log(f"FATAL 找不到 bin：{p}")
            sys.exit(2)

    ha, hb = make_home('a', repo), make_home('b', repo)
    pa, ta, ka = boot(a_bin, ha)
    pb, tb, kb = boot(b_bin, hb)
    log(f"[setup] A(基线) :{ta}   B(待验) :{tb}")

    results = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            for lab, port, tok in (('A', ta, ka), ('B', tb, kb)):
                pg = browser.new_page(viewport={'width': 1400, 'height': 950})
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)[:180]))
                pg.goto(f'http://127.0.0.1:{port}/?token={tok}&ob=1')
                pg.wait_for_timeout(7000)
                # 点开**同一个真实会话**（按标题文本匹配，不依赖类名——0.1.7 侧栏重构过类名）。
                # 两边同数据 ⇒ 同一会话，才叫公平对照。
                opened = pg.evaluate(
                    """(title) => {
                      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
                      const leaf = [...document.querySelectorAll('*')]
                        .filter(e => e.children.length === 0 && norm(e.innerText).startsWith(title));
                      if (leaf.length) {
                        let n = leaf[0];
                        for (let i = 0; i < 5 && n.parentElement; i++) {
                          if (n.onclick || n.getAttribute('role') === 'button' || n.tagName === 'A' || n.tagName === 'LI' || n.tagName === 'BUTTON') break;
                          n = n.parentElement;
                        }
                        n.click();
                        return 'clicked:' + norm(leaf[0].innerText).slice(0, 30);
                      }
                      const hero = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && norm(e.innerText) === '新会话');
                      if (hero.length) { hero[0].click(); return 'hero:新会话'; }
                      return 'nothing-matched';
                    }""",
                    args.title,
                )
                pg.wait_for_timeout(6000)
                st = pg.evaluate(PROBE)
                st['openedSession'] = opened
                st['fill'] = pg.evaluate(FILL)
                st['pageErrors'] = errs[:4]
                results[lab] = st
                pg.close()
            browser.close()
    finally:
        pa.kill()
        pb.kill()

    a, b = results['A'], results['B']
    log("\n===== 桥接页面半锚点 A/B（同数据，仅 DSH 版本不同）=====")
    keys = ['bridge', 'bootMarker', 'embedTokenLen', 'editableTotal', 'editableVisible', 'composer',
            'legacyTextarea', 'phaseStates', 'sidebarItems', 'bubbles', 'pathTitleEls', 'pathTitleSample',
            'wikiTextHits', 'wikiLinkEls', 'failTexts', 'openedSession', 'fill', 'pageErrors']
    diff = 0
    for k in keys:
        va, vb = a.get(k), b.get(k)
        same = va == vb
        diff += 0 if same else 1
        log(f"{'  ' if same else '★ '}{k:15} A={json.dumps(va, ensure_ascii=False)[:76]:76} B={json.dumps(vb, ensure_ascii=False)[:76]}")
    log(f"\n差异项 {diff}/{len(keys)}（fill 项受 headless Lexical 限制，见文件头注）")


if __name__ == '__main__':
    main()
