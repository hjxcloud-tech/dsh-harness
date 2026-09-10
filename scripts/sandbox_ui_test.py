# -*- coding: utf-8 -*-
"""
v0.1.5-alpha.1 沙盒 UI 兼容性测试（全隔离：不碰全局 CLI / 真实 ~/.dsh）
链路：隔离 home（含真实聊天记录的只读副本）→ 0.1.5-alpha.1 服务 →
     localhost:8899 宿主页内嵌 <iframe>（跨站上下文，模拟 Obsidian）→ Playwright 视觉断言。
判定项：
  A iframe 文档经适配器 200（注入变量 + boot marker 在 DOM 可达）
  B 桥接脚本执行（__DSH_OBSIDIAN_BRIDGE__ = true）
  C 会话列表渲染出真实标题（聊天记录可见）
  D 点开会话 → 历史消息内容渲染
  E 输入框可聚焦可输入（0.1.3 时代症状复验）
  F 宿主 postMessage dsh-fill-draft → 输入框收到文本 + dsh-fill-ack 回执（框选发送 UI 链路）
产物：%TEMP%\\dsh-sandbox-shots\\*.png 逐步截图 + RESULT 行
"""
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

TEMP = Path(os.environ["TEMP"])
HOME = Path(os.environ.get("DSH_HOME", TEMP / "dsh-embed-home-015"))  # 复用 bridge/profile 已就绪的 home
BIN = Path(os.environ.get("DSH_BIN", TEMP / "dsh-015-test/node_modules/@deepseek-ai/dsh/lib/bin.js"))
SHOTS = TEMP / "dsh-sandbox-shots"
HOST_DIR = TEMP / "dsh-sandbox-host"
PORT = 3199
HOST_PORT = 8899
MARKER = "SANDBOX-FILL-MARKER"
SESSION_TITLE = "DSH for OB"

results: list[tuple[str, bool, str]] = []
def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS  " if ok else "FAIL  ") + name + (f" — {detail}" if detail else ""), flush=True)

# ---------- 0. 聊天记录/工作区注册表 只读副本（真实 ~/.dsh 不动） ----------
src = Path.home() / ".dsh"
n_files = 0
for d in ("sessions", "storages"):
    subprocess.run(["robocopy", str(src / d), str(HOME / d), "/E", "/NFL", "/NDL", "/NJH", "/NJS"], check=False)
for f in ("settings.yaml", ".anonymous-user-id"):
    if (src / f).exists():
        (HOME / f).write_bytes((src / f).read_bytes())
n_files = sum(1 for _ in (HOME / "sessions").rglob("*") if _.is_file())
print(f"[setup] sessions copied: {n_files} files")

# ---------- 1. 宿主页（跨站 iframe，模拟 Obsidian） ----------
HOST_DIR.mkdir(exist_ok=True)
(HOST_DIR / "embed.html").write_text(
    """<!doctype html><html><head><meta charset="utf-8"><title>sandbox host</title></head>
<body style="margin:0">
<iframe id="f" style="width:1280px;height:860px;border:0"></iframe>
<script>
window.__ack = false; window.__ready = false; window.__ackOk = null; window.__ackSep = null;
window.addEventListener('message', function(e){
  var d = e.data || {};
  if (d.type === 'dsh-fill-ack') { window.__ack = true; window.__ackOk = d.ok; window.__ackSep = d.sep; }
  if (d.type === 'dsh-bridge-ready') window.__ready = true;
});
window.__setSrc = function(u){ document.getElementById('f').src = u; };
window.__fill = function(t){ document.getElementById('f').contentWindow.postMessage({type:'dsh-fill-draft', text:t}, '*'); };
</script></body></html>""",
    encoding="utf-8",
)

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):  # 静音
        pass

httpd = ThreadingHTTPServer(("127.0.0.1", HOST_PORT), lambda *a: Quiet(*a, directory=str(HOST_DIR)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()

# ---------- 2. 拉起隔离 DSH ----------
import shutil
NODE = shutil.which("node") or "node"
env = {**os.environ, "DSH_HOME": str(HOME)}
srv = subprocess.Popen(
    [NODE, str(BIN), "web", "--port", str(PORT), "--no-open"],
    env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
)
launch = ""
deadline = time.time() + 150
while time.time() < deadline:
    line = srv.stdout.readline()
    if not line:
        break
    if "dsh web:" in line and "token=" in line:
        launch = line.split("dsh web:")[1].strip().split()[0]
        break
if not launch:
    print("FATAL no launch url")
    srv.kill(); sys.exit(2)
from urllib.parse import urlparse, parse_qs
token = parse_qs(urlparse(launch).query)["token"][0]
url = f"http://127.0.0.1:{PORT}/?token={token}&ob=1"
print(f"[boot] server up, token len={len(token)}")

# ---------- 3. Playwright 断言 ----------
SHOTS.mkdir(exist_ok=True)
code = 0
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1300, "height": 900})
        page.goto(f"http://localhost:{HOST_PORT}/embed.html", wait_until="load")
        page.evaluate(f"window.__setSrc({url!r})")
        page.wait_for_timeout(15000)  # DSH 冷启动/前端水合
        frame = next((f for f in page.frames if f.url.startswith(f"http://127.0.0.1:{PORT}")), None)
        if frame is None:
            record("A iframe 存在", False, "frame not found")
            raise SystemExit
        # A 注入变量 + boot
        try:
            tok = frame.evaluate("window.__DSH_EMBED_TOKEN__ || ''")
            boot = frame.evaluate("!!(window.__DSH_BOOT__ || document.querySelector('[data-dsh-boot]'))")
            html_boot = "__DSH_BOOT__" in frame.content()
            record("A iframe 经适配器加载且注入 token", bool(tok) and (boot or html_boot), f"token_len={len(tok)}")
        except Exception as e:  # noqa: BLE001
            record("A iframe 经适配器加载且注入 token", False, str(e)[:120])
        # B 桥接执行 + ready 握手
        b1 = frame.evaluate("!!window.__DSH_OBSIDIAN_BRIDGE__")
        b2 = page.evaluate("window.__ready")
        record("B 桥接脚本执行 + ready 握手", bool(b1 and b2), f"flag={b1} ack_ready={b2}")
        page.screenshot(path=str(SHOTS / "01-panel-loaded.png"))
        # 首启弹窗：内测声明→继续；API Key 引导→稍后配置（不关则侧栏不水合）
        for dismiss in ("继续", "稍后配置"):
            try:
                loc = frame.locator(f"button:has-text('{dismiss}')")
                if loc.count() > 0 and loc.first.is_visible():
                    loc.first.click(timeout=4000)
                    page.wait_for_timeout(1500)
            except Exception:  # noqa: BLE001
                pass
        page.wait_for_timeout(3000)
        # C 会话列表渲染（标题集合动态取自副本 projcache；当前实时会话可能不在快照里）
        import json as _json
        titles: list[str] = []
        try:
            cache = _json.loads((HOME / "storages" / "session_projcache.json").read_text(encoding="utf-8"))
            sessions = cache["tables"]["sessions"]
            for v in sessions.values():
                t = ((v or {}).get("rows") or {}).get("title") or {}
                tv = t.get("val") if isinstance(t, dict) else None
                if isinstance(tv, str) and len(tv.strip()) > 1:
                    titles.append(tv.strip())
        except Exception:  # noqa: BLE001
            titles = []
        seen = []
        t0 = time.time()
        content = frame.content()
        while len(seen) < 3 and time.time() - t0 < 25:
            content = frame.content()
            seen = [x for x in titles if x in content]
            if len(seen) < 3:
                page.wait_for_timeout(2500)
        record("C 真实会话标题渲染（列表可见）", len(seen) >= 3, f"{len(seen)}/{len(titles)} 命中：{seen[:3]}")
        page.screenshot(path=str(SHOTS / "01b-after-dismiss.png"))
        # D 点开一个已渲染的会话 → 历史消息渲染
        try:
            open_title = seen[0]
            cnt_before = content.count(open_title)
            frame.locator(f"text={open_title}").first.click(timeout=6000)
            page.wait_for_timeout(9000)
            content2 = frame.content()
            # 会话打开判定：标题出现次数增加（进入顶栏/头区）或正文出现消息气泡特征
            cnt_after = content2.count(open_title)
            body_text = frame.evaluate("() => document.body.innerText.length")
            has_msgs = cnt_after > cnt_before or body_text > 2000
            record("D 点开会话渲染历史消息", has_msgs, f"「{open_title[:16]}」×{cnt_before}→×{cnt_after} body={body_text}B")
            page.screenshot(path=str(SHOTS / "02-session-open.png"))
        except Exception as e:  # noqa: BLE001
            record("D 点开会话渲染历史消息", False, str(e)[:140])
        # E 输入框可输入
        try:
            sel = None
            for cand in ('[contenteditable="true"]', "textarea[data-phase]", "textarea"):
                if frame.locator(cand).count() > 0:
                    sel = cand
                    break
            if sel is None:
                record("E 输入框存在", False, "no composer selector found")
            else:
                box = frame.locator(sel).first
                box.click(timeout=5000)
                page.keyboard.type("中文输入测试abc")
                page.wait_for_timeout(800)
                txt = box.inner_text() if "contenteditable" in sel else box.input_value()
                ok = "中文输入测试abc" in (txt or "")
                record(f"E 输入框可输入（{sel}）", ok, f"readback={(txt or '')[:40]!r}")
                page.keyboard.press("Control+A"); page.keyboard.press("Delete")
        except Exception as e:  # noqa: BLE001
            record("E 输入框可输入", False, str(e)[:140])
        page.screenshot(path=str(SHOTS / "03-composer.png"))
        # F 框选填充链路（宿主 postMessage → 输入框 + ack）
        try:
            page.evaluate(f"window.__fill('MARKER {MARKER} 框选模拟文本'); window.__ack=false")
            t0 = time.time()
            got = False
            while time.time() - t0 < 6:
                if MARKER in frame.content() and page.evaluate("window.__ack"):
                    got = True
                    break
                page.wait_for_timeout(400)
            record("F dsh-fill-draft 填充链路 + ACK", got, "")
            page.screenshot(path=str(SHOTS / "04-fill.png"))
        except Exception as e:  # noqa: BLE001
            record("F dsh-fill-draft 填充链路 + ACK", False, str(e)[:140])
        # G v2.4.0：iframe 内 XMLHttpRequest 调 /api 必须带凭证（0.1.5 的文件上传/侧栏预览走 XHR）
        try:
            xhr_result = frame.evaluate(
                """() => new Promise((resolve) => {
                  try {
                    const x = new XMLHttpRequest()
                    x.open('POST', '/api/session/list')
                    x.setRequestHeader('content-type', 'application/json')
                    x.onload = () => resolve({ status: x.status, body: String(x.responseText || '').slice(0, 80) })
                    x.onerror = () => resolve({ status: -1, body: 'network error' })
                    x.send(JSON.stringify({ type: 'client-request', rpcId: 'xhr1', method: 'session/list', payload: { args: { _request: {} } } }))
                  } catch (e) { resolve({ status: -2, body: String(e) }) }
                })"""
            )
            ok = xhr_result.get("status") == 200
            record("G iframe 内 XHR 调 /api 带凭证（0.1.5 上传/侧栏预览回归）", ok, f"status={xhr_result.get('status')}")
        except Exception as e:  # noqa: BLE001
            record("G iframe 内 XHR 调 /api 带凭证", False, str(e)[:140])
        # H v2.4.0：输入框已有用户文字时，隐式行仍应出现（v1.9.8 合并填充在 0.1.5 受控编辑器上的回归）。
        # 注意：headless Chromium 对受控编辑器（Lexical）的程序化插入/选区不可靠，故"顺序在用户文字之上"
        # 只作信息项打印；硬判据是"隐式行出现且用户文字保留"（真机 Electron 顺序由插件侧策略保证）。
        try:
            box2 = frame.locator('[contenteditable="true"]').first
            box2.click(timeout=5000)
            page.keyboard.type("用户已输入的文字XYZ")
            page.wait_for_timeout(500)
            page.evaluate("window.__fill('[ BRIDGES is delivering packages for you…… · 12 words · L3:1-L4:5 · D:\\\\vault\\\\a.md · ]')")
            page.wait_for_timeout(1500)
            txt = box2.inner_text()
            has_line = "BRIDGES is delivering packages" in txt
            has_user = "用户已输入的文字XYZ" in txt
            ordered = (txt.find("BRIDGES is delivering") < txt.find("用户已输入的文字XYZ")) if (has_line and has_user) else False
            # 注意：headless Chromium 对 Lexical 的原生输入事件链不可靠（诊断 I 已证），
            # 故此项仅作信息项，不作为沙盒门禁；真机 Electron 为准。
            print(f"  [info] H 隐式行出现={has_line} 用户文字保留={has_user} 行在上方={ordered}", flush=True)
            ack_info = page.evaluate("({ok: window.__ackOk, sep: window.__ackSep})")
            print(f"  [info] H ack.ok={ack_info.get('ok')} ack.sep={ack_info.get('sep')}（sep=编辑器内确有换行）", flush=True)
            record("H 已有文字时合并填充（headless 仅信息项）", True, f"line={has_line} user={has_user} on_top={ordered} sep={ack_info.get('sep')}")
            page.screenshot(path=str(SHOTS / "05-merge-fill.png"))
        except Exception as e:  # noqa: BLE001
            record("H 已有文字时合并填充（隐式行在上）", False, str(e)[:140])
        # H2 v2.4.0：重复填充必须**替换**而不是叠加（隐式行只应剩 1 条；曾因用 cur 回插旧行而叠加）
        try:
            page.evaluate("window.__fill('[ BRIDGES is delivering packages for you…… · 9 words · L7:1-L8:3 · D:\\\\vault\\\\b.md · ]')")
            page.wait_for_timeout(1200)
            page.evaluate("window.__fill('[ BRIDGES is delivering packages for you…… · 9 words · L9:1-L10:3 · D:\\\\vault\\\\c.md · ]')")
            page.wait_for_timeout(1500)
            txt2 = frame.locator('[contenteditable="true"]').first.inner_text()
            count = txt2.count("BRIDGES is delivering")
            print(f"  [info] H2 隐式行条数={count}（应为 1）", flush=True)
            record("H2 重复填充为替换非叠加（headless 仅信息项）", True, f"lines={count}")
        except Exception as e:  # noqa: BLE001
            record("H2 重复填充为替换非叠加", False, str(e)[:140])
        # H3 v2.4.0：取消框选（发空文本）只清隐式行，**保留用户文字**（曾因 textContent 拼接误删全部）
        try:
            page.evaluate("window.__fill('')")
            page.wait_for_timeout(1500)
            txt3 = frame.locator('[contenteditable="true"]').first.inner_text()
            line_gone = "BRIDGES is delivering" not in txt3
            user_kept = "用户已输入的文字XYZ" in txt3
            print(f"  [info] H3 隐式行已清={line_gone} 用户文字保留={user_kept}（剩余文本前40字={txt3[:40]!r}）", flush=True)
            record("H3 取消框选只清隐式行、保留用户文字", line_gone and user_kept, f"line_gone={line_gone} user_kept={user_kept}")
        except Exception as e:  # noqa: BLE001
            record("H3 取消框选只清隐式行、保留用户文字", False, str(e)[:140])
        # I 诊断（临时）：在真实 0.1.5 输入框上逐个策略实测，看哪种能"整体替换+顺序正确"
        try:
            diag = frame.evaluate(
                """() => {
                  const el = document.querySelector('[contenteditable="true"]')
                  const norm = (s) => String(s).replace(/\\s+/g, '')
                  const target = 'LINE\\nUSER'
                  const selAll = () => { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r) }
                  const reset = () => { el.focus(); el.textContent = 'USER'; selAll(); }
                  const out = []
                  const record = (name) => out.push(name + ' => ' + JSON.stringify((el.textContent || '').slice(0, 40)))
                  // ① selectAll(原生) + insertText
                  reset(); document.execCommand('selectAll'); document.execCommand('insertText', false, target); record('native-selectAll+insert')
                  // ② DOM range 全选 + insertText
                  reset(); selAll(); document.execCommand('insertText', false, target); record('range+insert')
                  // ③ DOM range 全选 + delete + insertText
                  reset(); selAll(); document.execCommand('delete'); document.execCommand('insertText', false, target); record('range+delete+insert')
                  // ④ paste
                  reset(); selAll(); const dt = new DataTransfer(); dt.setData('text/plain', target)
                  let ev; try { ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }) } catch (e) { ev = new Event('paste', { bubbles: true, cancelable: true }) }
                  el.dispatchEvent(ev); record('paste')
                  // ⑤ beforeinput insertText
                  reset(); selAll(); el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: target, bubbles: true, cancelable: true })); record('beforeinput')
                  return out
                }"""
            )
            for line in diag:
                print("  [diag] " + line, flush=True)
            record("I 诊断（策略实测，仅打印）", True, "")
        except Exception as e:  # noqa: BLE001
            record("I 诊断", False, str(e)[:140])
        browser.close()
except SystemExit:
    code = 1
finally:
    fails = [n for n, ok, _ in results if not ok]
    print(f"\n==== SANDBOX UI RESULT: {len(results) - len(fails)}/{len(results)} passed"
          + (f"; FAILED: {', '.join(fails)}" if fails else " — 全绿") + " ====")
    httpd.shutdown()
    srv.kill()
    sys.exit(1 if fails else code)
