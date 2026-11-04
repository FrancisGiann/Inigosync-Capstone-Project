from __future__ import annotations

import os
import re
import zipfile
from pathlib import Path

source = Path(r"C:\Users\Kiko\OneDrive\Documents\Projects\InigoSync (Thesis)\.codex\presentation-build\candidate.pptx")
temporary = source.with_name("candidate.with-motion.pptx")

animated_titles = {
    1: "project-title",
    2: "slide-title-2",
    3: "slide-title-3",
    4: "slide-title-4",
    5: "slide-title-5",
    6: "slide-title-6",
    7: "slide-title-7",
    8: "slide-title-8",
    9: "slide-title-9",
    10: "qa-title",
}

timing_template = """<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="4" dur="400" fill="hold"/><p:spTgt spid="{shape_id}"/><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"""

with zipfile.ZipFile(source, "r") as zin, zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        match = re.fullmatch(r"ppt/slides/slide(\d+)\.xml", item.filename)
        if match:
            slide_number = int(match.group(1))
            xml = data.decode("utf-8")
            if "<p:transition" not in xml:
                transition = '<p:transition spd="med" advClick="1"><p:fade/></p:transition>'
                xml = xml.replace("</p:cSld>", "</p:cSld>" + transition, 1)
            if slide_number in animated_titles and "<p:timing" not in xml:
                name = re.escape(animated_titles[slide_number])
                shape = re.search(r'<p:cNvPr\b[^>]*\bid="(\d+)"[^>]*\bname="' + name + r'"', xml)
                if not shape:
                    raise RuntimeError(f"Could not find animated title on slide {slide_number}")
                timing = timing_template.format(shape_id=shape.group(1))
                xml = xml.replace("</p:transition>", "</p:transition>" + timing, 1)
            data = xml.encode("utf-8")
        zout.writestr(item, data)

os.replace(temporary, source)
print(f"Added fade transitions to 10 slides and title fade-ins to 10 slides: {source}")
