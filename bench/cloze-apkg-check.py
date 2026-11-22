# FI-8: import a .apkg into a scratch collection with Anki's own library and print
# each note's type, card count, question and answer. Run isolated with Anki's Python:
#   <anki venv>/bin/python -I bench/cloze-apkg-check.py file.apkg
import os, re, sys, tempfile
from anki.collection import Collection, ImportAnkiPackageRequest
from anki.import_export_pb2 import ImportAnkiPackageOptions

col = Collection(os.path.join(tempfile.mkdtemp(), "check.anki2"))
col.import_anki_package(ImportAnkiPackageRequest(package_path=sys.argv[1], options=ImportAnkiPackageOptions(with_scheduling=False)))
strip = lambda h: re.sub(r"\s+", " ", re.sub(r"<style.*?</style>", "", h, flags=re.S)).strip()
failed = 0
for nid in sorted(col.find_notes("")):
    note = col.get_note(nid)
    model = note.note_type()
    cards = note.cards()
    kind = "cloze" if model["type"] == 1 else "basic"
    print(f"{model['name']} ({kind}), {len(cards)} card(s), tags {note.tags}")
    if len(cards) != 1: failed += 1
    for c in cards:
        print("  Q:", strip(c.question())[:220]); print("  A:", strip(c.answer())[:260])
print("FAIL" if failed else "ok")
sys.exit(1 if failed else 0)
