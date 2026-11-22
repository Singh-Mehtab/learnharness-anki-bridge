# FI-8: check generated cloze Text fields with Anki's own Python library on a
# scratch collection. Run with Anki's bundled Python, isolated:
#   <anki venv>/bin/python -I bench/cloze-anki-check.py fields.json
# Exit status 1 if any card does not render as one c1 blank with the expected
# question and answer.
import json, os, re, sys, tempfile
from anki.collection import Collection

def norm(html, side):
    html = re.sub(r"<style.*?</style>", "", html, flags=re.S)
    html = html.replace("<!-- -->", "")
    html = re.sub(r'<span class="cloze"[^>]*>(.*?)</span>', r"\1", html, flags=re.S)
    html = re.sub(r"(<br>\s*)+$", "", html.strip())
    return html.strip()

rows = json.load(open(sys.argv[1]))
col = Collection(os.path.join(tempfile.mkdtemp(), "check.anki2"))
model = col.models.by_name("Cloze")
deck = col.decks.id("Check")
failed = 0
for row in rows:
    if row["text"] is None:
        print(f"SKIP {row['id']}: validator problems: {row['problems']}")
        continue
    note = col.new_note(model)
    note["Text"] = row["text"]
    col.add_note(note, deck)
    cards = note.cards()
    problems = []
    if len(cards) != 1 or cards[0].ord != 0:
        problems.append(f"{len(cards)} cards")
    else:
        q = norm(cards[0].question(), "q")
        a = norm(cards[0].answer(), "a")
        # Inside MathJax Anki shows [...] raw; outside, inside a span. Both normalise to [...].
        if q != row["expectQ"]:
            problems.append(f"question\n    got:    {q}\n    expect: {row['expectQ']}")
        if a != row["expectA"]:
            problems.append(f"answer\n    got:    {a}\n    expect: {row['expectA']}")
    if problems:
        failed += 1
        print(f"FAIL {row['id']}\n  field: {row['text']}\n  " + "\n  ".join(problems))
    else:
        print(f"ok   {row['id']}")
print(f"{len(rows) - failed}/{len(rows)} ok")
sys.exit(1 if failed else 0)
