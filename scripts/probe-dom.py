# -*- coding: utf-8 -*-
"""一次性 DOM 探针：看沙盒 iframe 里 DSH 前端到底渲染了什么界面。"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

TEMP = Path(os.environ["TEMP"])
HOME = TEMP / "dsh-embed-home-015"
BIN = TEMP / "dsh-015-test/node_modules/@deepseek-ai/dsh/lib/bin.js"
PORT = 3199
HOST_PORT = 8898

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
print("[boot] ok")

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page()
        pg.goto(url, wait_until="load")  # 直接顶层打开（省掉宿主层，先看纯前端）
        pg.wait_for_timeout(15000)
        info = pg.evaluate("""() => {
          const vis = (el) => el && el.offsetParent !== null;
          const txt = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis).map(e => (e.innerText || '').trim().slice(0, 60)).slice(0, 12);
          return {
            title: document.title,
            bodyHead: (document.body.innerText || '').slice(0, 1500),
            bodyLen: (document.body.innerText || '').length,
            ce: document.querySelectorAll('[contenteditable="true"]').length,
            ta: document.querySelectorAll('textarea').length,
            inputs: document.querySelectorAll('input').length,
            buttons: txt('button'),
            headings: txt('h1,h2,h3,h4,[class*=title]'),
          }
        }""")
        for k, v in info.items():
            print(f"== {k} ==")
            print(v if not isinstance(v, str) else v[:1500])
        b.close()
finally:
    srv.kill()
