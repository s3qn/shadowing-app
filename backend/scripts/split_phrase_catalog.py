"""One-off migration: split the old phrase_catalog.json into backend/phrase_data/.
Kept for reference. Run from backend/: python scripts/split_phrase_catalog.py"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = ROOT / "phrase_catalog.json"
OUT = ROOT / "phrase_data"

CATEGORIES = [
    ("social", "Social", "חברה"),
    ("travel", "Travel", "נסיעות"),
    ("food", "Food", "אוכל"),
    ("shopping", "Shopping", "קניות"),
    ("daily-life", "Daily life", "חיי היום־יום"),
    ("care", "Help and care", "עזרה וטיפול"),
    ("work-study", "Work and study", "עבודה ולימודים"),
]

TOPIC_META = {
    "greetings": ("social", ["hello", "hi", "goodbye", "morning"], ["שלום", "ברכה"]),
    "about-me": ("social", ["introduce", "name", "myself", "meet"], ["היכרות", "שם"]),
    "small-talk": ("social", ["chat", "talk", "conversation", "weather"], ["שיחה", "צ'אט"]),
    "questions": ("daily-life", ["ask", "question", "what", "where"], ["שאלה", "לשאול"]),
    "eating-out": ("food", ["restaurant", "cafe", "order", "menu", "meal"], ["מסעדה", "הזמנה"]),
    "getting-around": ("travel", ["directions", "station", "train", "bus", "taxi"], ["כיוונים", "תחנה"]),
    "shopping": ("shop", ["shop", "buy", "store", "price", "pay"], ["לקנות", "חנות", "מחיר"]),
    "help": ("care", ["help", "emergency", "problem", "lost"], ["עזרה", "חירום"]),
}
TOPIC_META["shopping"] = ("shopping", *TOPIC_META["shopping"][1:])


def dump_lines(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = ",\n".join("  " + json.dumps(i, ensure_ascii=False) for i in items)
    path.write_text("[\n" + body + "\n]\n")


def main() -> None:
    old = json.loads(OLD.read_text())
    topics = []
    for t in old["topics"]:
        cat, kw, kwhe = TOPIC_META[t["id"]]
        topics.append({"id": t["id"], "category": cat, "title": t["title"],
                       "titleHe": t["titleHe"], "keywords": kw, "keywordsHe": kwhe})
    dump_lines(OUT / "topics.json", topics)
    cats = [{"id": i, "title": e, "titleHe": h, "order": n}
            for n, (i, e, h) in enumerate(CATEGORIES)]
    dump_lines(OUT / "categories.json", cats)
    for lang, by_topic in old["phrases"].items():
        for topic_id, items in by_topic.items():
            dump_lines(OUT / lang / f"{topic_id}.json", items)


if __name__ == "__main__":
    main()
