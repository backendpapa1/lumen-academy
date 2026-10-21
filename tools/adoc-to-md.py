"""Minimal AsciiDoc → Markdown for eval fixtures (Mastering Bitcoin chapters).
Keeps prose, headings, lists, code and tables-as-text; drops index terms,
anchors, image macros and attribute lines. Usage: adoc-to-md.py in.adoc out.md"""
import re
import sys

src = open(sys.argv[1], encoding="utf-8").read().splitlines()
out, in_code = [], False
for line in src:
    if line.strip() == "----":
        out.append("```")
        in_code = not in_code
        continue
    if in_code:
        out.append(line)
        continue
    if re.fullmatch(r"={4,}|\*{4,}|_{4,}|\|===|\+{4,}", line.strip()):
        continue  # sidebar/admonition/table delimiters
    if re.match(r"^\[(\[|role=|source|quote|NOTE|TIP|WARNING|cols|options|float|.*?#)", line.strip()) or line.startswith(":") or line.startswith("image::") or line.startswith("//"):
        continue
    m = re.match(r"^(=+)\s+(.*)", line)
    if m:
        out.append("#" * (len(m.group(1)) - 1) + " " + m.group(2))
        continue
    line = re.sub(r"\({3}.*?\){3}", "", line)                 # index terms
    line = re.sub(r"\[\[[^\]]*\]\]", "", line)                 # anchors
    line = re.sub(r"<<[^,>]+,\s*([^>]+)>>", r"\1", line)       # <<id,text>>
    line = re.sub(r"<<[^>]+>>", "", line)                      # <<id>>
    line = re.sub(r"footnote:\[([^\]]*)\]", r" (\1)", line)
    line = re.sub(r"\bhttps?://\S+\[([^\]]*)\]", r"\1", line)  # link[text]
    line = re.sub(r"^\.(?=[A-Z])", "**", line) + ("**" if re.match(r"^\.(?=[A-Z])", line) else "")
    line = re.sub(r"`\+(.*?)\+`", r"`\1`", line)
    line = re.sub(r"\+([^+\s][^+]*?)\+", r"\1", line)      # +passthrough+
    line = re.sub(r"~([^~\s]+)~", r"\1", line)               # ~subscript~
    line = re.sub(r"\^([^^\s]+)\^", r"^\1", line)           # ^superscript^
    line = re.sub(r"</?(pre|sub|sup|em|strong|code)[^>]*>", "", line)
    line = re.sub(r"\s+([.,;:])", r"\1", line) if re.search(r"\s[.,;:](\s|$)", line) else line
    line = re.sub(r"^(NOTE|TIP|WARNING):\s*", r"> ", line)
    out.append(line.rstrip())

text = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip() + "\n"
open(sys.argv[2], "w", encoding="utf-8").write(text)
