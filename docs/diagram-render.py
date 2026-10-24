#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 BPMN 的 DI 坐标画成 PNG（给 PDF 用）。

和 scripts/bpmn2svg.js 读的是同一份坐标，只是输出位图。
只依赖 Pillow + 系统自带微软雅黑，不装任何东西。

用法：
    python docs/diagram-render.py <in.bpmn> <out.png> [缩放]
"""

import re
import sys
import os
from PIL import Image, ImageDraw, ImageFont

FONT_REG = r"C:\Windows\Fonts\msyh.ttc"

INK = (29, 33, 41)
FLOW = (78, 89, 105)
GRAY = (134, 144, 156)
WHITE = (255, 255, 255)


def f(size):
    try:
        return ImageFont.truetype(FONT_REG, size)
    except Exception:
        return ImageFont.load_default()


def unesc(s):
    """BPMN 的 name 属性带 XML 实体（&gt; 之类），显示前要还原"""
    if not s:
        return ""
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


def read_elements(xml):
    out = {}
    for m in re.finditer(
        r"<bpmn:(userTask|serviceTask|startEvent|endEvent|exclusiveGateway|parallelGateway|inclusiveGateway|boundaryEvent)\b([^>]*)>",
        xml,
    ):
        typ, attrs = m.group(1), m.group(2)
        eid = re.search(r'\bid="([^"]+)"', attrs)
        name = re.search(r'\bname="([^"]+)"', attrs)
        if eid:
            out[eid.group(1)] = {"type": typ, "name": unesc(name.group(1)) if name else ""}
    return out


def read_shapes(xml):
    out = {}
    for m in re.finditer(
        r'<bpmndi:BPMNShape\b[^>]*bpmnElement="([^"]+)"[^>]*>[\s\S]*?'
        r'<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"',
        xml,
    ):
        out[m.group(1)] = dict(x=float(m.group(2)), y=float(m.group(3)),
                               w=float(m.group(4)), h=float(m.group(5)))
    return out


def read_edges(xml):
    out = []
    for m in re.finditer(r'<bpmndi:BPMNEdge\b[^>]*bpmnElement="([^"]+)"[^>]*>([\s\S]*?)</bpmndi:BPMNEdge>', xml):
        pts = [(float(a), float(b)) for a, b in
               re.findall(r'<di:waypoint x="([-\d.]+)" y="([-\d.]+)"', m.group(2))]
        lb = re.search(
            r'<bpmndi:BPMNLabel>[\s\S]*?<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"',
            m.group(2))
        box = (float(lb.group(1)), float(lb.group(2)), float(lb.group(3)), float(lb.group(4))) if lb else None
        out.append({"id": m.group(1), "pts": pts, "label": box})
    return out


def read_flow_names(xml):
    out = {}
    for m in re.finditer(r"<bpmn:sequenceFlow\b([^>]*)>", xml):
        attrs = m.group(1)
        fid = re.search(r'\bid="([^"]+)"', attrs)
        nm = re.search(r'\bname="([^"]+)"', attrs)
        if fid:
            out[fid.group(1)] = unesc(nm.group(1)) if nm else ""
    return out


def path_midpoint(pts):
    """按折线长度取中点：回边（驳回）的标签才会落在绕行段上，而不是压住正向箭头"""
    if len(pts) < 2:
        return pts[0] if pts else (0, 0)
    import math
    total = 0.0
    segs = []
    for i in range(1, len(pts)):
        d = math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        segs.append(d)
        total += d
    if total == 0:
        return pts[0]
    half = total / 2
    acc = 0.0
    for i, d in enumerate(segs):
        if acc + d >= half:
            t = (half - acc) / d if d else 0
            x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t
            y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
            return (x, y)
        acc += d
    return pts[-1]


def arrow(draw, pts, scale):
    if len(pts) < 2:
        return
    (x1, y1), (x2, y2) = pts[-2], pts[-1]
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    ln, wd = 9 * scale, 4.5 * scale
    p1 = (x2 - ln * math.cos(ang) + wd * math.sin(ang), y2 - ln * math.sin(ang) - wd * math.cos(ang))
    p2 = (x2 - ln * math.cos(ang) - wd * math.sin(ang), y2 - ln * math.sin(ang) + wd * math.cos(ang))
    draw.polygon([(x2, y2), p1, p2], fill=FLOW)


def render(xml, out_png, scale=2.0):
    els = read_elements(xml)
    shapes = read_shapes(xml)
    edges = read_edges(xml)
    flow_names = read_flow_names(xml)

    xs, ys = [], []
    for s in shapes.values():
        xs += [s["x"], s["x"] + s["w"]]
        ys += [s["y"], s["y"] + s["h"]]
    for e in edges:
        for p in e["pts"]:
            xs.append(p[0]); ys.append(p[1])
    if not xs:
        xs, ys = [0, 400], [0, 200]

    pad = 30
    min_x, min_y = min(xs) - pad, min(ys) - pad
    max_x, max_y = max(xs) + pad, max(ys) + pad
    W = int((max_x - min_x) * scale)
    H = int((max_y - min_y) * scale)
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)

    def sx(x):
        return (x - min_x) * scale

    def sy(y):
        return (y - min_y) * scale

    # 连线
    for e in edges:
        pts = [(sx(x), sy(y)) for x, y in e["pts"]]
        if len(pts) >= 2:
            d.line(pts, fill=FLOW, width=max(1, int(1.4 * scale)))
            arrow(d, pts, scale)
        nm = flow_names.get(e["id"], "")
        if nm:
            box = e["label"]
            if box:
                tx, ty = sx(box[0] + box[2] / 2), sy(box[1] + box[3] / 2)
            else:
                mx, my = path_midpoint(e["pts"])
                tx, ty = sx(mx), sy(my) - 8 * scale
            fnt = f(int(11 * scale))
            tw = d.textlength(nm, font=fnt)
            d.text((tx - tw / 2, ty - 6 * scale), nm, font=fnt, fill=GRAY)

    # 节点
    for eid, s in shapes.items():
        el = els.get(eid, {})
        x, y = sx(s["x"]), sy(s["y"])
        w, h = s["w"] * scale, s["h"] * scale
        cx, cy = x + w / 2, y + h / 2
        typ = el.get("type", "")
        name = el.get("name", "")

        if typ == "boundaryEvent":
            r = w / 2
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE, outline=INK, width=max(2, int(2 * scale)))
            r2 = r * 0.62
            d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=INK, width=max(1, int(1.4 * scale)))
            if name:
                fnt = f(int(10 * scale))
                tw = d.textlength(name, font=fnt)
                d.text((cx - tw / 2, y + h + 2 * scale), name, font=fnt, fill=GRAY)
        elif typ in ("startEvent", "endEvent"):
            r = w / 2
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE, outline=INK,
                      width=max(2, int((3.5 if typ == "endEvent" else 2) * scale)))
            if name:
                fnt = f(int(11 * scale))
                tw = d.textlength(name, font=fnt)
                d.text((cx - tw / 2, y + h + 4 * scale), name, font=fnt, fill=GRAY)
        elif typ.endswith("Gateway"):
            d.polygon([(cx, y), (x + w, cy), (cx, y + h), (x, cy)], fill=WHITE, outline=INK,
                      width=max(1, int(1.6 * scale)))
            k = 7 * scale
            d.line([(cx - k, cy), (cx + k, cy)], fill=INK, width=max(2, int(2.2 * scale)))
            d.line([(cx, cy - k), (cx, cy + k)], fill=INK, width=max(2, int(2.2 * scale)))
            if name:
                fnt = f(int(11 * scale))
                tw = d.textlength(name, font=fnt)
                d.text((cx - tw / 2, y + h + 4 * scale), name, font=fnt, fill=GRAY)
        else:
            d.rounded_rectangle([x, y, x + w, y + h], radius=int(8 * scale), fill=WHITE,
                                outline=INK, width=max(1, int(1.4 * scale)))
            if name:
                fnt = f(int(12 * scale))
                tw = d.textlength(name, font=fnt)
                th = 12 * scale
                d.text((cx - tw / 2, cy - th / 2), name, font=fnt, fill=INK)

    img.save(out_png, "PNG")
    return out_png, (W, H)


def main():
    if len(sys.argv) < 3:
        print("用法: python docs/diagram-render.py <in.bpmn> <out.png> [缩放]")
        sys.exit(2)
    in_file, out_png = sys.argv[1], sys.argv[2]
    scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
    with open(in_file, "r", encoding="utf-8") as fh:
        xml = fh.read()
    out_dir = os.path.dirname(os.path.abspath(out_png))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    p, size = render(xml, out_png, scale)
    print("已输出: %s  (%dx%d)" % (p, size[0], size[1]))


if __name__ == "__main__":
    main()
