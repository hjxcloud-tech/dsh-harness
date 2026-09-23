# -*- coding: utf-8 -*-
"""
上传补丁端到端验证（本地开发工具，不进发布物；对照 v2.6.1 上传修复）

为什么必须端到端跑：v2.6.0 的补丁写得很"合理"，单测也全绿，但真机上传一直失败——
因为闸门条件 `this.name==='dsh-file-upload'` 在 Chromium 里恒不成立
（`new Worker(url,{name}).name` 实测读回 null）。这类"环境事实"只能靠真实浏览器验。

链路：隔离 DSH_HOME + 当前 src/bridge.ts 生成的桥接 → 起一个隔离 DSH 服务 →
     **localhost 宿主页内嵌跨站 iframe**（localhost 是安全上下文，Chrome 才允许它嵌环回子框架；
     用 127.0.0.1 或假域名会被 Private Network Access 静默拦截，连请求都不发）→
     在面板文档里按 DSH 的真实写法 `new Worker(blobUrl,{name:'dsh-file-upload'})`
     发一条上传形态消息，检查 worker 实际收到了什么。

判定：
  T1 面板文档里补丁已生效（构造包装在位）
  T2 具名 worker 的上传消息被注入 Bearer 头 + URL token（body 不动）
  T3 普通 worker（无 options、非上传 URL）不被改动
用法：python scripts/verify-upload.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
TEMP = Path(os.environ["TEMP"])


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def log(m: str) -> None:
    print(m, flush=True)


results: list[tuple[str, bool, str]] = []


def rec(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    log(("PASS  " if ok else "FAIL  ") + name + (f" — {detail}" if detail else ""))


APP_PORT = free_port()
HOST_PORT = free_port()
HOME = TEMP / f"dsh-upload-home-{int(time.time())}"
HOME.mkdir(parents=True, exist_ok=True)

# 1) 当前源码的桥接写进隔离 home
r = subprocess.run(["node", "scripts/gen-bridge-into.mjs", str(HOME)], cwd=str(REPO), capture_output=True, text=True, encoding="utf-8", errors="replace")
if r.returncode != 0:
    log("FATAL gen-bridge-into 失败：" + (r.stderr or r.stdout)[:400])
    sys.exit(2)
log("[setup] " + (r.stdout or "").strip().splitlines()[-1])

# 2) 起隔离 DSH（官方全局 CLI 的 bin.js，身份已核验的那一个）
env = {**os.environ, "DSH_HOME": str(HOME)}
GLOBAL_BIN = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
if not GLOBAL_BIN.exists():
    log(f"FATAL 找不到官方 CLI：{GLOBAL_BIN}")
    sys.exit(2)
proc = subprocess.Popen(
    ["node", str(GLOBAL_BIN), "web", "--port", str(APP_PORT), "--no-open"],
    env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
)
launch = ""
deadline = time.time() + 150
while time.time() < deadline:
    line = proc.stdout.readline()
    if not line:
        break
    if "dsh web:" in line and "token=" in line:
        launch = line.split("dsh web:")[1].strip().split()[0]
        break
if not launch:
    log("FATAL 隔离服务没起来")
    proc.kill()
    sys.exit(2)
TOKEN = re.search(r"token=([A-Za-z0-9_.\-]+)", launch).group(1)
log(f"[setup] 隔离服务 :{APP_PORT}（token {len(TOKEN)} 字符）")

# 3) 宿主页：必须走 localhost（安全上下文），否则 Chrome 拦掉环回子框架
HD = TEMP / "dsh-upload-host"
HD.mkdir(exist_ok=True)
(HD / "embed.html").write_text(
    """<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" style="width:1280px;height:860px;border:0"></iframe>
<script>window.__setSrc=u=>{document.getElementById('f').src=u};</script></body>""",
    encoding="utf-8",
)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


httpd = ThreadingHTTPServer(("127.0.0.1", HOST_PORT), lambda *a: Quiet(*a, directory=str(HD)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()

def worker_checks(target, origin: str) -> str:
    """在给定 frame/page 上跑 T1–T4；返回错误说明（None=已跑完）。"""
    st = target.evaluate("""() => ({
      bridge: !!window.__DSH_OBSIDIAN_BRIDGE__,
      inFrame: window.top !== window.self,
      ctorWrapped: !!window.Worker && !/native code/.test('' + window.Worker),
      tokenLen: (window.__DSH_EMBED_TOKEN__ || '').length
    })""")
    rec("T1 补丁已生效（Worker 构造被包装、桥接在跑、token 可读）",
        bool(st.get("bridge")) and bool(st.get("ctorWrapped")) and st.get("tokenLen", 0) > 0,
        json.dumps(st, ensure_ascii=False))

    got = target.evaluate("""async (origin) => {
      const src = 'self.onmessage=e=>self.postMessage({got:e.data})';
      const mkUrl = () => URL.createObjectURL(new Blob([src], {type:'text/javascript'}));
      const w = new window.Worker(mkUrl(), {name:'dsh-file-upload'});
      const r1 = await new Promise(res => { w.onmessage = e => res(e.data.got);
        w.postMessage({url: origin + '/api/session/uploadFileBinary?sessionId=s1&name=a.png', body:'BLOB', headers:{'content-type':'application/octet-stream'}}); });
      const w2 = new window.Worker(mkUrl());
      const r2 = await new Promise(res => { w2.onmessage = e => res(e.data.got); w2.postMessage({url: origin + '/api/session/list'}); });
      w.terminate(); w2.terminate();
      return { upload: r1, other: r2, nameReadBack: w.name === undefined ? 'undefined' : JSON.stringify(w.name) };
    }""", origin)
    u = got.get("upload") or {}
    hdrs = u.get("headers") or {}
    auth = str(hdrs.get("authorization") or "")
    rec("T2 上传消息被注入 Bearer 头 + URL token（body/原 headers 保留）",
        "token=" in str(u.get("url", "")) and auth.startswith("Bearer ") and u.get("body") == "BLOB"
        and hdrs.get("content-type") == "application/octet-stream",
        json.dumps({"url": str(u.get("url"))[-64:], "headers": hdrs, "worker.name": got.get("nameReadBack")}, ensure_ascii=False))
    o = got.get("other") or {}
    rec("T3 普通 worker 的 /api 消息不被改动",
        "token=" not in str(o.get("url", "")) and not o.get("headers"), json.dumps(o, ensure_ascii=False)[:130])

    # T4：让 worker 自己发一次真实上传（worker 内的 fetch 不受页面补丁影响，
    # 所以只有消息里被注进了凭据才可能过——无凭据时该路由实测 401，已另行独立验证过）
    real = target.evaluate("""async (origin) => {
      const blob = new Blob([new Uint8Array([1,2,3,4])], {type:'application/octet-stream'});
      const w = new window.Worker(URL.createObjectURL(new Blob([
        'self.onmessage=async e=>{const r=await fetch(e.data.url,{method:"POST",headers:e.data.headers,body:e.data.body});' +
        'self.postMessage({status:r.status,body:(await r.text()).slice(0,160)});}'], {type:'text/javascript'})), {name:'dsh-file-upload'});
      const out = await new Promise(res => { w.onmessage = ev => res(ev.data);
        w.postMessage({url: origin + '/api/session/uploadFileBinary?sessionId=session-diag&name=a.png', body: blob, headers:{'content-type':'application/octet-stream'}}); });
      w.terminate();
      return out;
    }""", origin)
    rec("T4 worker 用注入的凭据真实上传成功过认证（不再 401，进到业务层）",
        real.get("status") not in (401, 403, None),
        f"status={real.get('status')} body={str(real.get('body'))[:80]}")
    return None


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=True,
            args=["--allow-running-insecure-content",
                  "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults"],
        )
        page = browser.new_context(viewport={"width": 1300, "height": 900}, bypass_csp=True).new_page()
        page.goto(f"http://localhost:{HOST_PORT}/embed.html")
        page.evaluate("u => window.__setSrc(u)", f"http://127.0.0.1:{APP_PORT}/?token={TOKEN}&ob=1")
        frame = None
        for _ in range(40):
            time.sleep(0.5)
            for f in page.frames:
                if f.url.startswith(f"http://127.0.0.1:{APP_PORT}"):
                    frame = f
                    break
            if frame:
                break
        origin = f"http://127.0.0.1:{APP_PORT}"
        if frame is not None:
            page.wait_for_timeout(4000)
            rec("T0 跨站 iframe 已加载（与面板同构，含 top!==self 闸门）", True, frame.url[:80])
            worker_checks(frame, origin)
        else:
            # 本机 Chrome 拦掉了环回子框架（与面板无关的环境差异）：退化为顶层页验证，
            # 但先把「闸门条件本身」用 served HTML 坐实，避免"验了个不存在的东西"。
            log("[note] 跨站 iframe 被本机 Chrome 拦（frames=" + json.dumps([f.url[:60] for f in page.frames]) + "），改用顶层页验证注入逻辑")
            served = page.request.get(origin + f"/?token={TOKEN}&ob=1").text()
            gate_ok = "if(window.top!==window.self){var OWK=window.Worker;" in served
            rec("T0 服务页面里补丁段在位且带 top!==self 闸门（面板内必然执行）", gate_ok, f"served={len(served)}B")
            top = browser.new_page()
            top.goto(origin + f"/?token={TOKEN}&ob=1")
            top.wait_for_timeout(4000)
            # 顶层页里 `top!==self` 不成立，故把 served 片段原样 eval、只把闸门换成 true（其余一字不改）
            frag = served[served.index("try{if(window.top!==window.self){var OWK=window.Worker;"):served.index("var OW=window.WebSocket")]
            top.evaluate("src => (0,eval)(src)", "var ET=(window.__DSH_EMBED_TOKEN__||'');" + frag.replace("if(window.top!==window.self){", "if(true){"))
            log("[note] 已在顶层页强制启用同一段补丁做注入验证")
            worker_checks(top, origin)
        browser.close()
finally:
    httpd.shutdown()
    try:
        proc.kill()
    except Exception:
        pass

passed = sum(1 for _, ok, _ in results if ok)
log(f"\n{passed}/{len(results)} PASS")
sys.exit(0 if passed == len(results) else 1)
