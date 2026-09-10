# -*- coding: utf-8 -*-
"""探针 2：弹窗处理后，看侧栏到底列了什么（工作区/会话/空态文案）。"""
import os
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

TEMP = Path(os.environ["TEMP"])
HOME = TEMP / "dsh-embed-home-015"
BIN = TEMP / "dsh-015-test/node_modules/@deepseek-ai/dsh/lib/bin.js"
PORT = 3199

env = {**os.environ, "DSH_HOME": str(HOME)}
srv = subprocess.Popen([shutil.which("node") or "node", str(BIN), "web", "--port", str(PORT), "--no-open"],
                       env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       encoding="utf-8", errors="replace")
launch = ""
t0 = time.time()
while time.time() - t0 < 150:
    line = srv.stdout.readline()
    if not line:
        break
    if "dsh web:" in line and "token=" in line:
        launch = line.split("dsh web:")[1].strip().split()[0]
        break
token = parse_qs(urlparse(launch).query)["token"][0]
url = f"http://127.0.0.1:{PORT}/?token={token}&ob=1"
print("[boot] ok", flush=True)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 860})
        pg.goto(url, wait_until="load")
        pg.wait_for_timeout(14000)
        for label in ("继续", "稍后配置"):
            try:
                loc = pg.locator(f"button:has-text('{label}')")
                if loc.count() > 0 and loc.first.is_visible():
                    loc.first.click(timeout=4000)
                    pg.wait_for_timeout(1500)
            except Exception:  # noqa: BLE001
                pass
        pg.wait_for_timeout(6000)
        info = pg.evaluate("""() => ({
          body: (document.body.innerText || '').slice(0, 2000),
        })""")
        print("==== BODY TEXT ====", flush=True)
        print(info["body"], flush=True)
        # 点开"工作区"标签再 dump 一次
        try:
            pg.locator("text=工作区").first.click(timeout=4000)
            pg.wait_for_timeout(4000)
            print("==== AFTER 工作区 click ====", flush=True)
            print(pg.evaluate("() => (document.body.innerText || '').slice(0, 1600)"), flush=True)
        except Exception as e:  # noqa: BLE001
            print("工作区 click fail:", str(e)[:120], flush=True)
        b.close()
finally:
    srv.kill()
