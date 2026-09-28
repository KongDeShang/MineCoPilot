#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
产品说明.html  ->  产品说明.docx

为什么不用 pandoc / Word 直接打开 HTML：
  · pandoc 未安装，且会丢掉全部版式（表头底色、卡片、强调块全部变成纯文本）；
  · Word 解析 HTML 是遗留路径，会产出大量绝对定位的浮动框，反而更难改。
本脚本按本文档自己的标记结构（h2.sec / .call / .cards / .stats / .flow / .arch /
table / ul.feat）逐类映射到 Word 原生样式，产出「可编辑、可用导航窗格、
分页由 Word 自己管」的 docx。

分页策略（对应反馈的三个问题）：
  1) 每个大节（h2.sec）page_break_before —— 大节另起一页
  2) 封面单独一节，页边距 0 + 整页满版色块 —— 消除封面留白条
  3) 表格行 cantSplit + 表头行 tblHeader —— 行不被拆断，跨页自动重复表头

用法：python docs/tools/html2docx.py
"""
import copy
import json
import os
import re
import sys
from pathlib import Path

from lxml import html as LH
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# ---------- 调色板：与产品 tokens.css 同源 ----------
ACCENT      = '0B3A82'
ACCENT_DK   = '072057'
ACCENT_SOFT = 'E8EFFB'
ACCENT_LINE = 'C7D6EF'
SIGNAL      = '0BB4C4'
SIGNAL_INK  = '0A7079'
SIGNAL_SOFT = 'E3F7F9'
SIGNAL_LINE = 'A6E3E9'
EMERALD     = '12A06B'
EMERALD_SOFT= 'E7F7F0'
AMBER_SOFT  = 'FDF3DC'
DANGER      = 'E0413E'
DANGER_INK  = 'B33431'
DANGER_SOFT = 'FDECEC'
TEXT1       = '0A1326'
TEXT2       = '3D4B63'
TEXT3       = '57647A'
MUTE        = '8A95A7'
LINE        = 'E2E6EE'
BG_SOFT     = 'F7F9FC'
WHITE       = 'FFFFFF'

# 分页模式。默认连续排版：两个版本都渲染出来比对过 —— 每节强制另起一页会留下 5 个半空页
# （第 2 页一半是白的），而连续排版 19 页里只有末页偏短，且大节标题本身有 16pt 深蓝 + 通栏横线，
# 从半页开始并不显突兀。设 MANUAL_BREAK=1 可切回「每个大节另起一页」。
PAGE_BREAK = os.environ.get('MANUAL_BREAK', '0') == '1'

# 认不出来就被跳过的 div。收尾时打出来，免得又出现「内容悄悄少了」。
DROPPED = []

FONT = '微软雅黑'
MONO = 'Consolas'

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs' / '产品说明.html'
OUT = ROOT / 'docs' / '产品说明.docx'

# 封面上的版本号取自 package.json，不写死。
# 写死的代价很具体：改版本号时漏掉这一处，就会出现「安装包叫 1.2.0、
# 说明书封面印着 1.1.0」—— 而说明书正是要交给别人看的那一份。
# 同理，App.vue 侧栏那处版本号也是从 package.json 注入的（见其注释）。
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']


# ============================================================
# 低层工具
# ============================================================

def style_run(run, size=10.5, color=TEXT2, bold=False, italic=False, mono=False):
    f = run.font
    f.size = Pt(size)
    f.bold = bold
    f.italic = italic
    f.color.rgb = RGBColor.from_string(color)
    rPr = run._element.get_or_add_rPr()
    rf = rPr.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement('w:rFonts')
        rPr.insert(0, rf)
    ascii_font = MONO if mono else FONT
    rf.set(qn('w:ascii'), ascii_font)
    rf.set(qn('w:hAnsi'), ascii_font)
    rf.set(qn('w:eastAsia'), FONT)
    return run


_WS = re.compile(r'[ \t\r\n　]+')


def add_run(p, text, **kw):
    """写一个 run。文本节点里的换行与缩进**按 HTML 语义折叠成空格**。

    python-docx 的 Run.text 会把 "\\n" 直接写成 <w:br/>。而本手册的源码里
    `<br>` 后面都跟着一个真实换行（为了源码本身好读）：

        一台笔记本、…服务器——<br>
        完成从台账导入 → …

    于是 `inlines` 已经为 <br> 断了一次行，紧跟的 "\\n" 又断一次 —— 行距翻倍，
    行首还多出源码缩进那 4 个空格。结语「一句话」框里三行之间空出 73pt、
    封面副标题三行间距忽大忽小，根子都在这。换行在 HTML 里只是空白。
    """
    if not text:
        return None
    text = _WS.sub(' ', text)
    if not p.runs and text[:1] == ' ':
        text = text[1:]          # 段落开头的源码缩进，不是正文的空格
    if not text:
        return None
    return style_run(p.add_run(text), **kw)


def shade(element, fill):
    """段落或单元格底色。element 为 p._p 或 cell._tc 的 pPr/tcPr 宿主。"""
    pr = element
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill)
    pr.append(shd)


def shade_para(p, fill):
    shade(p._p.get_or_add_pPr(), fill)


def shade_cell(cell, fill):
    shade(cell._tc.get_or_add_tcPr(), fill)


def para_border(p, sides):
    """sides: {'bottom': (size_eighth_pt, color), 'left': (...)}"""
    pPr = p._p.get_or_add_pPr()
    pBdr = pPr.find(qn('w:pBdr'))
    if pBdr is None:
        pBdr = OxmlElement('w:pBdr')
        pPr.append(pBdr)
    for side in ('top', 'left', 'bottom', 'right'):
        if side in sides:
            sz, col = sides[side]
            el = OxmlElement(f'w:{side}')
            el.set(qn('w:val'), 'single')
            el.set(qn('w:sz'), str(sz))
            el.set(qn('w:space'), '6')
            el.set(qn('w:color'), col)
            pBdr.append(el)


def no_borders(table):
    tblPr = table._tbl.tblPr
    for old in tblPr.findall(qn('w:tblBorders')):
        tblPr.remove(old)
    b = OxmlElement('w:tblBorders')
    for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        e = OxmlElement(f'w:{side}')
        e.set(qn('w:val'), 'none')
        e.set(qn('w:sz'), '0')
        b.append(e)
    tblPr.append(b)


def table_borders(table, color=LINE, sz=6, top_color=None, bottom_color=None):
    """横线式表格：只留上下框 + 行分隔线，去掉全部竖线。
    默认的 Table Grid 四边加内竖线，44 张表排下来像电子表格，是整份文档显脏的主因。"""
    tblPr = table._tbl.tblPr
    for old in tblPr.findall(qn('w:tblBorders')):
        tblPr.remove(old)

    def mk(side, val, size, col):
        e = OxmlElement('w:' + side)
        e.set(qn('w:val'), val)
        e.set(qn('w:sz'), str(size))
        e.set(qn('w:space'), '0')
        e.set(qn('w:color'), col)
        return e

    b = OxmlElement('w:tblBorders')
    b.append(mk('top', 'single', sz, top_color or color))
    b.append(mk('left', 'none', 0, color))
    b.append(mk('bottom', 'single', sz, bottom_color or color))
    b.append(mk('right', 'none', 0, color))
    b.append(mk('insideH', 'single', sz, color))
    b.append(mk('insideV', 'none', 0, color))
    tblPr.append(b)


def force_width(table, twips, indent_twips=0, widths=None):
    """把表格钉死成指定宽度。python-docx 的 cell.width 只写 tcW，
    在 tblLayout=fixed 下会被 tblGrid 覆盖 —— 必须同时改 tblW 与 gridCol。

    widths 给定时按「每列各自的宽度」写 gridCol（总和应等于 twips）；
    不给则等分。流程块那种「方框宽、箭头窄」的列必须显式给，否则等分下去
    方框只剩 2.8cm，正文被拆成「…说成人/话」这种单字吊行。
    """
    tblPr = table._tbl.tblPr
    for tag in ('w:tblW', 'w:tblLayout', 'w:tblInd'):
        for old in tblPr.findall(qn(tag)):
            tblPr.remove(old)
    w = OxmlElement('w:tblW'); w.set(qn('w:w'), str(twips)); w.set(qn('w:type'), 'dxa')
    tblPr.append(w)
    lay = OxmlElement('w:tblLayout'); lay.set(qn('w:type'), 'fixed')
    tblPr.append(lay)
    # 注意：Word 的 tblInd 指的是「单元格文字起始位置」而非表格左边缘。
    # 置 0 会让整表左移一个左边距宽度（实测封面色块左移 1.8cm、文字被裁），
    # 所以要让色块贴住页边，这里必须填「正的左边距值」。
    ind = OxmlElement('w:tblInd'); ind.set(qn('w:w'), str(indent_twips)); ind.set(qn('w:type'), 'dxa')
    tblPr.append(ind)
    grid = table._tbl.find(qn('w:tblGrid'))
    if grid is not None:
        cols = grid.findall(qn('w:gridCol'))
        n = max(len(cols), 1)
        per = twips // n
        for i, c in enumerate(cols):
            if widths and i < len(widths):
                c.set(qn('w:w'), str(widths[i]))
            else:
                c.set(qn('w:w'), str(per if i < n - 1 else twips - per * (n - 1)))


def strip_cls(el, tag, token):
    """摘掉匹配的子元素，但把它的 tail 文本接回前一个节点（别把正文一起丢了）。"""
    for e in list(el.iter(tag)):
        if token in (e.get('class') or '').split():
            parent = e.getparent()
            idx = list(parent).index(e)
            if idx == 0:
                parent.text = (parent.text or '') + (e.tail or '')
            else:
                prev = parent[idx - 1]
                prev.tail = (prev.tail or '') + (e.tail or '')
            parent.remove(e)
            return True
    return False


def cell_margins(cell, top=0.12, left=0.20, bottom=0.12, right=0.20):
    tcPr = cell._tc.get_or_add_tcPr()
    for old in tcPr.findall(qn('w:tcMar')):
        tcPr.remove(old)
    m = OxmlElement('w:tcMar')
    for side, val in (('top', top), ('left', left), ('bottom', bottom), ('right', right)):
        e = OxmlElement(f'w:{side}')
        e.set(qn('w:w'), str(int(val * 567)))   # cm -> twips
        e.set(qn('w:type'), 'dxa')
        m.append(e)
    tcPr.append(m)


def row_cant_split(row):
    trPr = row._tr.get_or_add_trPr()
    trPr.append(OxmlElement('w:cantSplit'))


def row_as_header(row):
    trPr = row._tr.get_or_add_trPr()
    trPr.append(OxmlElement('w:tblHeader'))


def para(p, size=10.5, color=TEXT2, before=0, after=4, line=1.5,
         align=None, indent_left=None, keep_next=False, keep_lines=True):
    pf = p.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line
    if align is not None:
        pf.alignment = align
    if indent_left is not None:
        pf.left_indent = Cm(indent_left)
    if keep_next:
        pf.keep_with_next = True
    if keep_lines:
        pf.keep_together = True
    return p


# ============================================================
# 行内内容：把 HTML 的行内标签变成 Word run 序列
# ============================================================

def inlines(p, el, size=10.5, color=TEXT2, bold=False, italic=False, mono=False):
    if el.text:
        add_run(p, el.text, size=size, color=color, bold=bold, italic=italic, mono=mono)
    for ch in el:
        tag = ch.tag.lower() if isinstance(ch.tag, str) else ''
        if tag == 'br':
            p.add_run().add_break()
            # 硬断行之后就是行首了，源码那点缩进在 HTML 里会被折叠掉，
            # 不能当成正文的空格留在行首（否则每行都缩进两个字）。
            ch.tail = (ch.tail or '').lstrip()
        elif tag in ('b', 'strong'):
            inlines(p, ch, size, TEXT1, True, italic, mono)
        elif tag == 'code':
            add_run(p, ch.text or '', size=size - 0.5, color=ACCENT, bold=False,
                    italic=False, mono=True)
            if ch.tail:
                add_run(p, ch.tail, size=size, color=color, bold=bold,
                        italic=italic, mono=mono)
            continue
        elif tag == 'small':
            inlines(p, ch, size - 1.0, MUTE, bold, italic, mono)
        elif tag == 'span':
            cls = ch.get('class') or ''
            if 'n' == cls.strip():
                add_run(p, (ch.text or '') + '　', size=size, color=SIGNAL_INK, bold=True)
                if ch.tail:
                    add_run(p, ch.tail, size=size, color=color, bold=bold,
                            italic=italic, mono=mono)
                continue
            inlines(p, ch, size, color, bold, italic, mono)
        else:
            inlines(p, ch, size, color, bold, italic, mono)
        if ch.tail:
            add_run(p, ch.tail, size=size, color=color, bold=bold,
                    italic=italic, mono=mono)
    return p


def findall_cls(el, tag, token):
    """按 class 令牌查找全部匹配。

    ElementPath 的 `[@class="box"]` 是**字符串全等**，`class="box acc"` 一个都命不中。
    架构图里 15 个 box 有 10 个带修饰类（acc/em/red/sig），于是 ② 知识检索、④ 出口校验、
    ⑤ 落盘三层的方框整层消失，只剩标题条——HTML 与产物对账时才查出来。
    """
    return [ch for ch in el.iter(tag) if token in (ch.get('class') or '').split()]


def find_cls(el, tag, token):
    """按 class 令牌查找首个匹配（class="n sig" 这类多类名要能命中 n）。"""
    found = findall_cls(el, tag, token)
    return found[0] if found else None


# ============================================================
# 各类块级元素
# ============================================================

def apply_heading_style(doc, p, level):
    """套上真正的 Word 标题样式，导航窗格才能拉出大纲。

    外观不受影响：style_run 把字体/字号/颜色/粗体全写成直接格式，
    para() 也把段间距、行距、keep_with_next 都写死在段落级，样式的默认值压不过来。
    """
    p.style = doc.styles[f'Heading {level}']
    return p


def add_heading1(doc, el):
    """大节标题：底部双线"""
    p = doc.add_paragraph()
    apply_heading_style(doc, p, 1)
    para(p, size=16, color=ACCENT_DK, before=0 if PAGE_BREAK else 20,
         after=8, line=1.22, keep_next=True)
    p.paragraph_format.page_break_before = PAGE_BREAK
    inlines(p, el, size=16, color=ACCENT_DK, bold=True)
    for r in p.runs:
        r.font.bold = True
        r.font.color.rgb = RGBColor.from_string(ACCENT_DK)
    para_border(p, {'bottom': (18, ACCENT)})
    return p


def add_heading(doc, el, level):
    sizes = {2: 13, 3: 11}
    colors = {2: ACCENT, 3: TEXT1}
    p = doc.add_paragraph()
    apply_heading_style(doc, p, level)
    para(p, size=sizes[level], color=colors[level], before=9 if level == 2 else 6,
         after=3, line=1.32, keep_next=True)
    inlines(p, el, size=sizes[level], color=colors[level], bold=True)
    for r in p.runs:
        r.font.bold = True
    return p


def add_para(doc, el, cls='', keep_next=False):
    style_cls = (el.get('class') or '') + ' ' + cls
    if 'sec-lead' in style_cls:
        # 印刷版正文 11px、.sec-lead 14px，是**比正文大**的导语。
        # 原先映射成 9pt（比正文 10pt 还小），层级被弄反了，读起来像图注。
        size, color = 11, TEXT3
    elif 'lead' in style_cls:
        size, color = 10.5, TEXT1
    else:
        size, color = 10, TEXT2
    p = doc.add_paragraph()
    para(p, size=size, color=color, after=3, line=1.42, keep_next=keep_next)
    inlines(p, el, size=size, color=color)
    return p


def add_feat_list(doc, el):
    """ul.feat -> 项目符号列表（用小方块符号，配色与页面一致）"""
    for li in el.findall('li'):
        p = doc.add_paragraph()
        para(p, after=2, line=1.38, indent_left=0.55)
        p.paragraph_format.first_line_indent = Cm(-0.33)
        add_run(p, '▪  ', size=10, color=SIGNAL, bold=True)
        inlines(p, li, size=10, color=TEXT2)


CALL_STYLE = {
    '':      (ACCENT_SOFT, ACCENT,   'ACCENT'),
    'sig':   (SIGNAL_SOFT, SIGNAL_INK, 'SIGNAL'),
    'warn':  (AMBER_SOFT,  '8A6210',  'AMBER'),
    'red':   (DANGER_SOFT, DANGER_INK, 'DANGER'),
}


def add_call(doc, el):
    cls = (el.get('class') or '').replace('call', '').strip()
    fill, title_color, bar = CALL_STYLE.get(cls, CALL_STYLE[''])
    big = 'big' in (el.get('class') or '')

    t = doc.add_table(rows=1, cols=1)
    t.autofit = False
    no_borders(t)
    # 提示框整块不许拆。原先没拴住，末页那个「一句话」被拦腰截断，
    # 后半截两行孤零零地落到第 19 页上，就是「末页留白条」的来源。
    row_cant_split(t.rows[0])
    cell = t.cell(0, 0)
    cell.width = Cm(16.6)
    shade_cell(cell, fill)
    cell_margins(cell, top=0.14, left=0.35, bottom=0.14, right=0.3)
    # 正文栏宽正好 16.6cm（页边距 2.2×2）。tblInd 必须填「左边距」198 twips，
    # 留 0 会让整个色块左移一个左边距宽度，跟上下正文的左边线对不齐。
    force_width(t, 9411, indent_twips=198)

    # 左侧色条：用单元格左边框模拟
    tcPr = cell._tc.get_or_add_tcPr()
    b = OxmlElement('w:tcBorders')
    e = OxmlElement('w:left')
    e.set(qn('w:val'), 'single')
    e.set(qn('w:sz'), '24')
    e.set(qn('w:color'), bar)
    b.append(e)
    tcPr.append(b)

    first = cell.paragraphs[0]
    title = find_cls(el, "div", "t")
    body_els = [c for c in el if c.tag == 'p']
    if title is not None:
        para(first, size=9, color=title_color, after=3, line=1.3)
        add_run(first, (title.text or '').strip(), size=9, color=title_color, bold=True)
        target = cell.add_paragraph()
    else:
        target = first
    for i, pe in enumerate(body_els):
        if i:
            target = cell.add_paragraph()
        sz = 11.5 if big else 10
        para(target, size=sz, color=TEXT1, after=2, line=1.42)
        inlines(target, pe, size=sz, color=TEXT1, bold=big)
    # 去掉表格后多余空段
    return t


def add_colophon(doc, el):
    """落款块：一条细分隔线 + 三行小字（署名 / 版权 / 相关文档）。

    这块原先被分发逻辑**整块丢掉**——`<div>` 没有 class 时既不是 call 也不是
    cards，又没有 else 分支，于是整块消失。产物里查不到这几行字，
    就是在这里断的。子 `<div>` 是通用遍历的，所以源 HTML 里增减一行不用改这里。
    """
    line = doc.add_paragraph()
    para(line, size=6, after=0, line=1.0, before=12)
    para_border(line, {'top': (6, LINE)})

    for i, ch in enumerate([c for c in el if c.tag == 'div']):
        # HTML 是缩进排版的，<div> 里那段换行 + 空格会被 lxml 当成正文，
        # 直接写进 docx 就变成「相关文档」那一行的额外左缩进。先压掉。
        if ch.text:
            ch.text = ' '.join(ch.text.split())
        q = doc.add_paragraph()
        para(q, size=9, color=TEXT3, before=5 if i == 0 else 0, after=0, line=1.5)
        inlines(q, ch, size=9, color=TEXT3)
    return line


def add_cards(doc, el):
    cards = findall_cls(el, 'div', 'card')
    cols = 3
    rows = (len(cards) + cols - 1) // cols
    t = doc.add_table(rows=rows, cols=cols)
    t.autofit = False
    table_borders(t, color=ACCENT_LINE)
    for i, c in enumerate(cards):
        cell = t.cell(i // cols, i % cols)
        cell.width = Cm(5.5)
        shade_cell(cell, BG_SOFT)
        cell_margins(cell, top=0.16, left=0.22, bottom=0.16, right=0.18)
        p0 = cell.paragraphs[0]
        para(p0, size=8.5, after=2, line=1.25)
        k = find_cls(c, 'div', 'k')
        add_run(p0, (k.text or '').strip() if k is not None else '',
                size=8.5, color=SIGNAL_INK, bold=True)
        p1 = cell.add_paragraph()
        para(p1, size=9.5, color=TEXT1, after=0, line=1.4)
        v = find_cls(c, 'div', 'v')
        if v is not None:
            inlines(p1, v, size=9.5, color=TEXT1)
    for r in t.rows:
        row_cant_split(r)
    return t


def add_stats(doc, el):
    stats = findall_cls(el, 'div', 'stat')
    t = doc.add_table(rows=1, cols=len(stats))
    t.autofit = False
    table_borders(t, color=ACCENT_LINE)
    for i, s in enumerate(stats):
        cell = t.cell(0, i)
        cell.width = Cm(16.6 / max(len(stats), 1))
        shade_cell(cell, BG_SOFT)
        cell_margins(cell, top=0.18, left=0.1, bottom=0.18, right=0.1)
        p0 = cell.paragraphs[0]
        para(p0, size=17, after=1, line=1.1, align=WD_ALIGN_PARAGRAPH.CENTER)
        num = find_cls(s, 'div', 'n')
        ncls = (num.get('class') or '')
        ncolor = SIGNAL_INK if 'sig' in ncls else (EMERALD if 'em' in ncls else ACCENT)
        if num is not None:
            inlines(p0, num, size=17, color=ncolor, bold=True)
            for r in p0.runs:
                r.font.bold = True
        p1 = cell.add_paragraph()
        para(p1, size=8.5, color=TEXT3, after=0, line=1.35,
             align=WD_ALIGN_PARAGRAPH.CENTER)
        lbl = find_cls(s, 'div', 'l')
        if lbl is not None:
            inlines(p1, lbl, size=8.5, color=TEXT3)
    row_cant_split(t.rows[0])
    return t


def add_flow(doc, el):
    steps = findall_cls(el, 'div', 'step')
    n_step = max(len(steps), 1)
    cells = len(steps) * 2 - 1
    t = doc.add_table(rows=1, cols=cells)
    t.autofit = False
    no_borders(t)

    # 列宽必须显式钉死：不钉的话箭头列被 → 字号撑宽，方框只剩约 2.8cm，
    # 「只把结论说成人话」会被拆成「…说成人 / 话」——单字吊在行尾。
    TOTAL = 9411            # 16.6cm，正文栏宽
    ARW = 250               # 箭头列 0.44cm
    n_arw = n_step - 1
    box = (TOTAL - ARW * n_arw) // n_step
    widths = []
    for i in range(n_step):
        widths.append(box)
        if i < n_arw:
            widths.append(ARW)
    force_width(t, TOTAL, indent_twips=198, widths=widths)

    for i, s in enumerate(steps):
        c = t.cell(0, i * 2)
        c.width = Cm(16.6 / n_step)
        shade_cell(c, BG_SOFT)
        cell_margins(c, top=0.12, left=0.08, bottom=0.12, right=0.08)
        tcPr = c._tc.get_or_add_tcPr()
        b = OxmlElement('w:tcBorders')
        for side, sz, col in (('top', 6, LINE), ('left', 6, LINE),
                              ('bottom', 6, LINE), ('right', 6, LINE)):
            e = OxmlElement(f'w:{side}')
            e.set(qn('w:val'), 'single')
            e.set(qn('w:sz'), str(sz))
            e.set(qn('w:color'), col)
            b.append(e)
        tcPr.append(b)

        # .n（确定性 / 叙述 / 闸门 / 兜底）在 HTML 里是 display:block，独占一行。
        # 之前 find_cls 查的是 div（实际是 span）永远查不到，于是它被 inlines
        # 当内联 span 处理，跟正文挤在同一行。
        body = copy.deepcopy(s)
        ns = find_cls(s, 'span', 'n')
        p0 = c.paragraphs[0]
        para(p0, size=9, after=1, line=1.15, align=WD_ALIGN_PARAGRAPH.CENTER)
        if ns is not None:
            add_run(p0, (ns.text or '').strip(), size=9, color=SIGNAL_INK, bold=True)
            strip_cls(body, 'span', 'n')
        p1 = c.add_paragraph()
        para(p1, size=9.5, color=TEXT1, after=0, line=1.3,
             align=WD_ALIGN_PARAGRAPH.CENTER)
        inlines(p1, body, size=9.5, color=TEXT1)
        if i < len(steps) - 1:
            ac = t.cell(0, i * 2 + 1)
            ac.width = Cm(0.44)
            ap = ac.paragraphs[0]
            cell_margins(ac, 0.02, 0.02, 0.02, 0.02)
            para(ap, size=12, after=0, line=1.2, align=WD_ALIGN_PARAGRAPH.CENTER)
            add_run(ap, '→', size=12, color=MUTE, bold=True)
    row_cant_split(t.rows[0])
    return t


def add_arch(doc, el):
    layers = findall_cls(el, 'div', 'layer')
    outer = doc.add_table(rows=len(layers), cols=1)
    outer.autofit = False
    table_borders(outer, color=ACCENT_LINE)
    for i, lay in enumerate(layers):
        cell = outer.cell(i, 0)
        cell.width = Cm(16.6)
        cell_margins(cell, top=0.16, left=0.22, bottom=0.16, right=0.22)
        style = (lay.get('style') or '')
        fill = None
        if 'danger-soft' in style:
            fill = DANGER_SOFT
        elif 'emerald-soft' in style:
            fill = EMERALD_SOFT
        elif 'bg-soft' in style:
            fill = BG_SOFT
        if fill:
            shade_cell(cell, fill)
        lt = find_cls(lay, 'div', 'lt')
        p0 = cell.paragraphs[0]
        para(p0, size=9, after=4, line=1.25)
        tcolor = DANGER_INK if fill == DANGER_SOFT else (EMERALD if fill == EMERALD_SOFT else ACCENT)
        add_run(p0, (lt.text or '').strip() if lt is not None else '',
                size=9, color=tcolor, bold=True)
        boxes = findall_cls(lay, 'div', 'box')
        if not boxes:
            continue
        inner = cell.add_table(rows=1, cols=len(boxes))
        inner.autofit = False
        for j, bx in enumerate(boxes):
            ic = inner.cell(0, j)
            ic.width = Cm(16.0 / len(boxes))
            cell_margins(ic, top=0.10, left=0.10, bottom=0.10, right=0.10)
            bcls = (bx.get('class') or '')
            if 'sig' in bcls:
                buf, bcol = SIGNAL_SOFT, SIGNAL_INK
            elif 'acc' in bcls:
                buf, bcol = ACCENT_SOFT, ACCENT
            elif 'em' in bcls:
                buf, bcol = EMERALD_SOFT, '0B6B48'
            elif 'red' in bcls:
                buf, bcol = DANGER_SOFT, DANGER_INK
            else:
                buf, bcol = BG_SOFT, TEXT1
            shade_cell(ic, buf)
            tcPr = ic._tc.get_or_add_tcPr()
            bd = OxmlElement('w:tcBorders')
            for side in ('top', 'left', 'bottom', 'right'):
                e = OxmlElement(f'w:{side}')
                e.set(qn('w:val'), 'single')
                e.set(qn('w:sz'), '6')
                e.set(qn('w:color'), LINE)
                bd.append(e)
            tcPr.append(bd)
            ip = ic.paragraphs[0]
            para(ip, size=8.5, after=0, line=1.3, align=WD_ALIGN_PARAGRAPH.CENTER)
            inlines(ip, bx, size=8.5, color=bcol)
        row_cant_split(inner.rows[0])
        row_cant_split(outer.rows[i])
    return outer


def add_figure(doc, el):
    """<figure><img src=…><figcaption>…</figcaption></figure> → 通栏图 + 居中小号题注。

    图宽钉死正文栏宽 16.6cm（=21cm 页宽 - 左右各 2.2cm 边距）。题注另起一段、
    居中对齐但左对齐读起来更顺——这里用居中，与图的轴线一致。
    图和题注都 keep_together，且图 keep_with_next，避免题注被分页甩到下一页。
    """
    img = el.find('img')
    cap = el.find('figcaption')
    if img is None:
        DROPPED.append('figure(没有 img)')
        return
    src = (img.get('src') or '').strip()
    if not src:
        DROPPED.append('figure(img 没有 src)')
        return
    path = (SRC.parent / src).resolve()
    if not path.exists():
        # 图丢了必须报出来 —— 静默少一张图，比少一段文字更难发现
        DROPPED.append(f'figure(图文件不存在: {src})')
        return

    pic = doc.add_paragraph()
    para(pic, before=3, after=1, line=1.0, align=WD_ALIGN_PARAGRAPH.CENTER)
    pic.paragraph_format.keep_with_next = True
    pic.add_run().add_picture(str(path), width=Cm(16.6))

    if cap is not None:
        cp = doc.add_paragraph()
        # 段距一压再压是为了让「图 + 题注」这一块正好塞进一页的下半栏：
        # 块高 ≈ 10.37(图) + 0.2(段距) + 0.7(题注) + 0.15 ≈ 11.4cm，
        # 半栏可用 12.7cm。之前 after=8/line=1.2 时块高 12.6cm，
        # 差一点点挤不进去，Word 整块推到下一页 —— p08 因此空了一半。
        # 题注左对齐而不是居中：两行以上的题注居中会把末行甩成孤零零的一截，
        # 左对齐读起来才像正文的一部分。
        para(cp, before=0, after=4, line=1.15, align=WD_ALIGN_PARAGRAPH.LEFT)
        inlines(cp, cap, size=8.5, color=TEXT3)


def add_table(doc, el):
    ths = el.findall('.//thead//th')
    trs = el.findall('.//tbody//tr')
    ncols = len(ths) if ths else (len(trs[0].findall('td')) if trs else 0)
    if not ncols:
        return None
    t = doc.add_table(rows=0, cols=ncols)
    t.autofit = False
    table_borders(t, color=LINE, top_color=ACCENT, bottom_color=ACCENT)
    total = 16.6

    # 列宽：优先读 th 的 width:xx%
    widths = []
    for th in ths:
        st = th.get('style') or ''
        w = None
        if 'width:' in st:
            try:
                w = float(st.split('width:')[1].split('%')[0].strip())
            except ValueError:
                w = None
        widths.append(w)
    known = sum(w for w in widths if w)
    unknown = [i for i, w in enumerate(widths) if not w]
    if unknown and known < 100:
        share = (100 - known) / len(unknown)
        for i in unknown:
            widths[i] = share
    elif not any(widths):
        widths = [100 / ncols] * ncols

    if ths:
        hr = t.add_row()
        row_as_header(hr)
        row_cant_split(hr)
        for i, th in enumerate(ths):
            c = hr.cells[i]
            c.width = Cm(total * widths[i] / 100)
            shade_cell(c, ACCENT)
            cell_margins(c, top=0.09, left=0.16, bottom=0.09, right=0.16)
            p0 = c.paragraphs[0]
            para(p0, size=8.5, color=WHITE, after=0, line=1.28)
            inlines(p0, th, size=8.5, color=WHITE, bold=True)
            for r in p0.runs:
                r.font.bold = True

    for ri, tr in enumerate(trs):
        tds = tr.findall('td')
        row = t.add_row()
        row_cant_split(row)
        for i, td in enumerate(tds[:ncols]):
            c = row.cells[i]
            c.width = Cm(total * widths[i] / 100)
            if ri % 2 == 1:
                shade_cell(c, BG_SOFT)
            cell_margins(c, top=0.08, left=0.16, bottom=0.08, right=0.16)
            p0 = c.paragraphs[0]
            para(p0, size=8.5, color=TEXT2, after=0, line=1.32)
            inlines(p0, td, size=8.5, color=TEXT2)
            first = td.find('td')
            if td.find('b') is not None:
                for r in p0.runs:
                    if r.font.bold:
                        r.font.color.rgb = RGBColor.from_string(TEXT1)

    # 表尾防孤行：拴住「倒数第二行 + 最后一行」。
    # 只有 ≤3 行的极小表才整表不拆 —— 4~5 行的表若整表 keep-together，
    # 实测会被整体推到次页，反而在页底挤出空白页（曾出现近乎全空的 p15）。
    if len(t.rows) >= 2:
        span = range(len(t.rows) - 1) if len(trs) <= 3 else [len(t.rows) - 2]
        for ri in span:
            for c in t.rows[ri].cells:
                for pp in c.paragraphs:
                    pp.paragraph_format.keep_with_next = True
    return t


# ============================================================
# 封面
# ============================================================

def build_cover(doc, sec):
    """整页满版封面：页边距 0 + 一张填满 A4 的深蓝单元格。"""
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    for a in ('top_margin', 'bottom_margin', 'left_margin', 'right_margin'):
        setattr(sec, a, Cm(0))

    t = doc.add_table(rows=1, cols=1)
    t.autofit = False
    no_borders(t)
    force_width(t, 11906, indent_twips=1021)   # 整宽 21cm + 左缩进=左边距 1.8cm
    row = t.rows[0]
    row.height = Cm(29.7)
    row.height_rule = WD_ROW_HEIGHT_RULE.EXACTLY
    row_cant_split(row)
    c = t.cell(0, 0)
    c.width = Cm(21)
    shade_cell(c, ACCENT_DK)
    cell_margins(c, top=0.0, left=1.8, bottom=0.0, right=1.8)

    def blank(n_pt):
        p = c.add_paragraph()
        para(p, size=n_pt, after=0, line=1.0)
        return p

    blank(88)
    p = c.add_paragraph()
    para(p, size=10, after=0, line=1.0)
    add_run(p, 'M I N E C O   P I L O T', size=10, color='7DE8F2', bold=True)

    p = c.add_paragraph()
    para(p, before=22, after=0, line=1.0)
    add_run(p, '产品说明书', size=10, color='7DE8F2')

    p = c.add_paragraph()
    para(p, before=16, after=0, line=1.15)
    add_run(p, '矿山智工', size=40, color=WHITE, bold=True)

    p = c.add_paragraph()
    para(p, before=6, after=0, line=1.3)
    add_run(p, '设备健康智能体 · Counselor for Machines', size=12, color='A9C6EE')

    p = c.add_paragraph()
    para(p, before=16, after=0, line=1.0)
    para_border(p, {'bottom': (18, '7DE8F2')})
    p.runs and None
    add_run(p, ' ', size=2, color=ACCENT_DK)

    p = c.add_paragraph()
    para(p, before=22, after=0, line=1.6)
    add_run(p, '不联网、不调云端大模型，', size=13, color='DBE7F8')
    p.add_run().add_break()
    add_run(p, '在一台笔记本上完成矿山设备全生命周期运维的', size=13, color='DBE7F8')
    p.add_run().add_break()
    add_run(p, '本地 AI 工作台', size=13, color=WHITE, bold=True)
    add_run(p, '。', size=13, color='DBE7F8')

    p = c.add_paragraph()
    para(p, before=26, after=0, line=1.75)
    add_run(p, '当前版本　', size=10, color='BCD2EF')
    add_run(p, f'v{VERSION}', size=10, color=WHITE, bold=True)
    p.add_run().add_break()
    add_run(p, '产品形态　', size=10, color='BCD2EF')
    add_run(p, 'Windows 桌面版（Electron）· 单机离线', size=10, color=WHITE, bold=True)
    p.add_run().add_break()
    add_run(p, '核心理念　', size=10, color='BCD2EF')
    add_run(p, '规则引擎出数字，本地大模型只说人话', size=10, color=WHITE, bold=True)
    p.add_run().add_break()
    add_run(p, '运行要求　', size=10, color='BCD2EF')
    add_run(p, '无 GPU · 无服务器 · 无网络', size=10, color=WHITE, bold=True)

    p = c.add_paragraph()
    para(p, before=30, after=0, line=1.7)
    add_run(p, '开发者：孔德尚（石家庄铁道大学）', size=9, color='8FB0DC')
    p.add_run().add_break()
    add_run(p, '版权所有 © 2026 石家庄铁道大学 孔德尚，保留所有权利', size=9, color='8FB0DC')
    p.add_run().add_break()
    add_run(p, '2026 年 9 月', size=9, color='8FB0DC')


def build_footer(section):
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    para(p, size=8, color=MUTE, after=0, line=1.0)
    pf = p.paragraph_format
    # 左：文档名  右：页码
    tabs = pf.tab_stops
    tabs.add_tab_stop(Cm(16.6), WD_ALIGN_PARAGRAPH.RIGHT)
    add_run(p, '矿山智工 · 产品说明书', size=8, color=MUTE)
    add_run(p, '\t', size=8, color=MUTE)
    r = p.add_run()
    style_run(r, size=8, color=MUTE)
    f1 = OxmlElement('w:fldChar'); f1.set(qn('w:fldCharType'), 'begin')
    it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = 'PAGE'
    f2 = OxmlElement('w:fldChar'); f2.set(qn('w:fldCharType'), 'end')
    r._r.append(f1); r._r.append(it); r._r.append(f2)


# ============================================================
# 主流程
# ============================================================

def main():
    if not SRC.exists():
        sys.exit(f'找不到源文件：{SRC}')
    doc = Document()

    # 基础样式
    normal = doc.styles['Normal']
    normal.font.name = FONT
    normal.font.size = Pt(10)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)

    # 第一节 = 封面（页边距 0）
    cover_sec = doc.sections[0]
    build_cover(doc, cover_sec)

    # 第二节 = 正文（正常 A4 页边距）
    body_sec = doc.add_section(WD_SECTION.NEW_PAGE)
    body_sec.page_width, body_sec.page_height = Cm(21), Cm(29.7)
    body_sec.top_margin = Cm(2.2)
    body_sec.bottom_margin = Cm(2.0)
    body_sec.left_margin = Cm(2.2)
    body_sec.right_margin = Cm(2.2)
    body_sec.footer_distance = Cm(1.1)
    build_footer(body_sec)

    tree = LH.parse(str(SRC)).getroot()
    body = tree.find('body')

    # 视觉块：紧跟其后的那一块是「被引导句指着的图」。引导句若留在上一页、
    # 块被推到下一页，读起来就是一句话被腰斩——p04 顶上那个光秃秃的流程块
    # 就是这么来的。这几类块的前一句要钉住跟着走。
    GLUE = ('flow', 'arch', 'stats', 'cards')

    first_h1 = True
    for section in body.findall('section'):
        if 'cover' in (section.get('class') or ''):
            continue
        kids = list(section)
        for idx, el in enumerate(kids):
            tag = el.tag if isinstance(el.tag, str) else ''
            cls = el.get('class') or ''
            # 下一个兄弟是这几类 div 之一，就把它和这一句焊在一页上。
            nxt = kids[idx + 1] if idx + 1 < len(kids) else None
            ncls = ((nxt.get('class') or '').split()
                    if nxt is not None and isinstance(nxt.tag, str) and nxt.tag == 'div'
                    else [])
            glue = any(k in ncls for k in GLUE)
            if tag == 'h2':
                p = add_heading1(doc, el)
                if first_h1:
                    p.paragraph_format.page_break_before = False
                    first_h1 = False
                # class 带 newpage 的大节强制另起一页。用在「前置内容 → 正文」
                # 这种分界上：Word 的 keepNext 跨不过表格边界（XML 里 keepNext
                # 写进去了也没用），光靠它的话卡片块会自己溜到下一页，标题
                # 孤零零留在页底。
                if 'newpage' in cls.split():
                    p.paragraph_format.page_break_before = True
            elif tag == 'h3':
                add_heading(doc, el, 2)
            elif tag == 'h4':
                add_heading(doc, el, 3)
            elif tag == 'p':
                add_para(doc, el, cls, keep_next=glue)
            elif tag == 'ul':
                add_feat_list(doc, el)
            elif tag == 'table':
                add_table(doc, el)
            elif tag == 'figure':
                add_figure(doc, el)
            elif tag == 'div':
                # 导语：6 处里有 4 处写成 <div class="sec-lead">，而 sec-lead 的分支
                # 只在 add_para 里（那条路径只有 <p> 走得到），于是这 4 条导语
                # 一直在静默丢失。
                if 'sec-lead' in cls:
                    add_para(doc, el, cls, keep_next=glue)
                elif 'call' in cls:
                    add_call(doc, el)
                elif 'cards' in cls:
                    add_cards(doc, el)
                elif 'stats' in cls:
                    add_stats(doc, el)
                elif 'flow' in cls:
                    add_flow(doc, el)
                elif 'arch' in cls:
                    add_arch(doc, el)
                elif 'colophon' in cls:
                    add_colophon(doc, el)
                else:
                    # 别再静默丢内容了：把没认出来的 div 报出来。
                    DROPPED.append(cls or (el.get('style') or '')[:48])
            if tag in ('table', 'div'):
                sp = doc.add_paragraph()
                para(sp, size=2, after=0, line=1.0)

    # 尾部空段要清掉：正文结束时的占位段（表后间隔）会被顶出新的一页，
    # 排出来就是一张只剩页脚的白纸。
    body = doc.element.body
    sectPr = body.find(qn('w:sectPr'))
    while True:
        kids = [c for c in body if c.tag != qn('w:sectPr')]
        if not kids:
            break
        last = kids[-1]
        if last.tag != qn('w:p'):
            break
        if ''.join(last.itertext()).strip():
            break
        body.remove(last)

    doc.save(str(OUT))
    print(f'已生成：{OUT}')
    if DROPPED:
        print(f'!! 有 {len(DROPPED)} 个未识别的 div 被跳过：')
        for d in DROPPED:
            print('   ', d)


if __name__ == '__main__':
    main()
