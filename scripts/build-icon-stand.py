#!/usr/bin/env python3
"""Build a self-contained icon stand: no dev server, no external requests.

The Vite dev server kept being reaped, so the stand inlines everything it needs
(the Merriweather italic face and the reference PNG) as data URIs and opens
straight off disk.
"""
import base64
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
OUT = ROOT / "couplet-icon-stand.html"

font_b64 = base64.b64encode(
    (ROOT / "src/assets/fonts/Merriweather-BoldItalic.woff2").read_bytes()
).decode()
ref_b64 = base64.b64encode((ROOT / "site/ref-icon.png").read_bytes()).decode()

# Values copied verbatim from src/lib/theme/*.css.
#   tile = --bg-base, amp = --color-heading, car = --color-cursor,
#   grad = --heading-grad-1 where the theme defines one.
# classic light/dark set --color-cursor to the text colour, so a caret painted
# from it vanishes into the ampersand; those two fall back to --color-link.
THEMES = [
    ("light", "#fafaf9", "#292524", "#2563eb", None, "каретка из --color-link"),
    ("dark", "#191724", "#c4a7e7", "#9ccfd8", None, "каретка из --color-link"),
    ("aurora-light", "#efeeec", "#5566ec", "#e0509f",
     "linear-gradient(100deg,#d6438f 0%,#7f5ce0 32%,#12849f 64%,#5566ec 100%)", "градиент"),
    ("aurora-dark", "#171629", "#8f9ff5", "#f78cc7",
     "linear-gradient(100deg,#f78cc7 0%,#b48cf0 30%,#7edff2 62%,#8f9ff5 100%)", "градиент"),
    ("blueprint-light", "#f4f2e9", "#123a7a", "#c0492b", None, "≈ твой исходник"),
    ("blueprint-dark", "#0c2b52", "#ffffff", "#ff7a59", None, ""),
    ("phosphor-light", "#e9f0e4", "#0f5c2e", "#9a5b00", None, ""),
    ("phosphor-dark", "#061008", "#c9ffd8", "#ffcf6b",
     "linear-gradient(100deg,#ffcf6b 0%,#b8f0a8 38%,#c9ffd8 100%)", "градиент"),
]


def icon(tile, amp, car, grad, size_var="lg"):
    style = f"--tile:{tile};--amp:{amp};--caret:{car}"
    if grad:
        style += f";--ampGrad:{grad};--ampClip:text;--ampFill:transparent"
    return (
        f'<span class="icon icon--{size_var}" style="{style}">'
        f'<span class="caret"></span><span class="amp">&amp;</span></span>'
    )


cells = []
for name, tile, amp, car, grad, note in THEMES:
    cells.append(
        f'<div class="cell">{icon(tile, amp, car, grad)}'
        f'<div class="name">{name}</div>'
        f'<div class="note">{note}</div></div>'
    )

small = "".join(icon(t, a, c, g, "sm") for _, t, a, c, g, _ in THEMES)
dock = "".join(icon(t, a, c, g, "dk") for _, t, a, c, g, _ in THEMES)
blueprint = next(t for t in THEMES if t[0] == "blueprint-light")

HTML = f"""<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>couplet — иконка следует за темой</title>
<style>
@font-face {{
  font-family: 'MW'; font-style: italic; font-weight: 700; font-display: block;
  src: url(data:font/woff2;base64,{font_b64}) format('woff2');
}}
* {{ box-sizing: border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f6f6f8; color: #17171c; margin: 0; padding: 40px 46px 90px; }}
body.dark {{ background: #0d0d11; color: #e9e9f0; }}
h1 {{ font-family: MW, Georgia, serif; font-style: italic; font-weight: 700;
  font-size: 30px; margin: 0 0 8px; }}
p.sub {{ font-size: 13.5px; line-height: 1.6; opacity: .62; max-width: 780px; margin: 0 0 4px; }}
h2 {{ font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase;
  opacity: .42; margin: 40px 0 18px; font-weight: 700; }}
button {{ font: inherit; font-size: 13px; padding: 7px 15px; border-radius: 8px;
  cursor: pointer; border: 1px solid rgba(128,128,128,.38); background: transparent;
  color: inherit; margin: 22px 0 0; }}
code {{ font-family: ui-monospace, SFMono-Regular, monospace; font-size: .92em;
  background: rgba(128,128,128,.14); padding: 1px 5px; border-radius: 4px; }}

.icon {{ position: relative; overflow: hidden; display: inline-flex;
  align-items: center; justify-content: center; background: var(--tile);
  border-radius: calc(var(--s) * 0.225); width: var(--s); height: var(--s);
  box-shadow: 0 1px 2px rgba(0,0,0,.16), 0 8px 22px rgba(0,0,0,.10); vertical-align: middle; }}
.icon--lg {{ --s: 128px; }}
.icon--sm {{ --s: 48px; box-shadow: 0 1px 3px rgba(0,0,0,.2); }}
.icon--dk {{ --s: 26px; box-shadow: 0 1px 2px rgba(0,0,0,.22); }}
.icon .caret {{ position: absolute; z-index: 0; background: var(--caret);
  width: calc(var(--s) * 0.135); height: calc(var(--s) * 0.64);
  border-radius: calc(var(--s) * 0.0675);
  left: 64%; top: 49%; transform: translate(-50%, -50%); }}
.icon .amp {{ position: relative; z-index: 1; font-family: MW, Georgia, serif;
  font-style: italic; font-weight: 700; line-height: 1;
  font-size: calc(var(--s) * 0.72); color: var(--amp);
  background: var(--ampGrad, none);
  -webkit-background-clip: var(--ampClip, border-box); background-clip: var(--ampClip, border-box);
  -webkit-text-fill-color: var(--ampFill, currentColor);
  margin-right: calc(var(--s) * 0.22); margin-top: calc(var(--s) * -0.04); }}

.grid {{ display: grid; grid-template-columns: repeat(4, max-content); gap: 34px 38px; }}
.cell {{ text-align: center; max-width: 150px; }}
.name {{ font-family: ui-monospace, monospace; font-size: 11.5px; opacity: .62; margin-top: 10px; }}
.note {{ font-size: 11px; opacity: .45; margin-top: 3px; line-height: 1.4; }}
.row {{ display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }}
.refbox {{ display: flex; gap: 30px; align-items: center; flex-wrap: wrap; }}
.refbox img {{ width: 128px; height: 128px; }}
.refnote {{ font-size: 13px; line-height: 1.62; opacity: .72; max-width: 430px; }}
</style></head>
<body>
<h1>couplet — иконка следует за темой</h1>
<p class="sub">Силуэт зафиксирован: амперсанд и каретка за ним. Меняются только плитка,
цвет амперсанда, цвет каретки и наличие градиента — всё берётся из токенов
соответствующей темы в <code>src/lib/theme/</code>. Файл автономный: шрифт и картинка
вшиты, ни сервера, ни сети не требуется.</p>
<button id="t" type="button">Тёмный фон страницы</button>

<h2>Твой исходник рядом с генерацией</h2>
<div class="refbox">
  <img src="data:image/png;base64,{ref_b64}" alt="исходная иконка" />
  {icon(blueprint[1], blueprint[2], blueprint[3], None)}
  <p class="refnote">Слева твой исходник, справа <code>blueprint-light</code> из токенов темы.
  Палитра совпадает почти один в один. Расходится глиф: у тебя каллиграфический амперсанд
  с завитком, чей терминал ложится поверх планки; здесь — курсивный Merriweather из бандла,
  и планка встала рядом, а не переплелась. Это чинится только твоим SVG.</p>
</div>

<h2>Все восемь тем — 128px</h2>
<div class="grid">{''.join(cells)}</div>

<h2>48px</h2>
<div class="row">{small}</div>

<h2>26px — размер в строке меню</h2>
<div class="row">{dock}</div>

<script>
document.getElementById('t').addEventListener('click', function () {{
  document.body.classList.toggle('dark');
}});
</script>
</body></html>
"""

OUT.write_text(HTML, encoding="utf-8")
print(f"{OUT}  {OUT.stat().st_size // 1024} KB")
