"""Key parsing and forcing, for timelines and free-running plans. Run from the repo root: .venv/Scripts/python -m unittest discover tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import engine  # noqa: E402
import keys  # noqa: E402
import timeline  # noqa: E402
from abc_tools import parse_abc  # noqa: E402

A_MAJOR_SCORE = """X:1
T:
M:4/4
L:1/8
Q:1/4=120
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:A
% verse
V: Vocal
"A"c2e2a4|"D"f2a2d4|"E"e2g2B4|"A"A8|
V: Ins
A,8|D,8|E,8|A,8|
"""


def layout(**extra):
    return timeline.Timeline.parse({"bpm": 120, "sections": [{"label": "verse", "bars": 4}], **extra})


def forced_header(rails):
    text = ""
    while rails.header:
        forced = rails.next_forced()
        if forced is None:  # what the model would write: the note unit, or the key
            if rails.header[1:]:
                rails.feed("8\n")
                text += "8\n"
                continue
            return text, False
        text += forced
    return text, True


class ParseKey(unittest.TestCase):
    def test_spellings(self):
        cases = {"A": "A", "Em": "Em", "Bb": "Bb", "F#m": "F#m", "bb": "Bb", "a minor": "Am",
                 "C major": "C", "Cmaj": "C", " D  min ": "Dm", "Ebm": "Ebm"}
        for raw, key in cases.items():
            self.assertEqual(keys.parse_key(raw), key, raw)

    def test_auto(self):
        for raw in (None, "", "auto", "Auto"):
            self.assertIsNone(keys.parse_key(raw))

    def test_unsupported(self):
        for raw in ("H", "Fb", "E#", "A dorian", "Gbm", "BB", 7):
            with self.assertRaises(ValueError, msg=raw):
                keys.parse_key(raw)


class TimelineKey(unittest.TestCase):
    def test_default_is_auto(self):
        self.assertIsNone(layout().key)
        self.assertIsNone(layout().to_dict()["key"])

    def test_parse_and_round_trip(self):
        parsed = layout(key="f# minor")
        self.assertEqual(parsed.key, "F#m")
        self.assertEqual(timeline.Timeline.parse(parsed.to_dict()).key, "F#m")

    def test_invalid_key_rejected(self):
        with self.assertRaises(ValueError):
            layout(key="Q")

    def test_header_forces_key(self):
        text, done = forced_header(timeline.Rails(layout(key="A")))
        self.assertTrue(done)
        self.assertTrue(text.endswith("\nK:A\n"), text)
        self.assertEqual(timeline.Rails(layout(key="A")).header[-1][-4:], "K:A\n")

    def test_header_leaves_key_to_model_by_default(self):
        text, done = forced_header(timeline.Rails(layout()))
        self.assertFalse(done)
        self.assertTrue(text.endswith("\nK:"), text)

    def test_downstream_keeps_key(self):
        plan = layout(key="A")
        abc, info, _ = timeline.finish_score(A_MAJOR_SCORE, plan, keep_chords=True)
        self.assertNotIn("conversion_skipped", info)
        self.assertIn("\nK:A\n", abc)
        section = timeline.slice_score(abc, plan, 0, 4)
        self.assertIn("\nK:A\n", section)
        self.assertEqual(parse_abc(section).voices["Ins"].key, "A")


def rewrite_all(header, tokens):
    """Feed sampled tokens through a KeyHeader the way the planners do; returns the score text."""
    out = ""
    for token in tokens:
        kept, forced = header.rewrite(token)
        out += kept + forced
        if forced:
            break
    return out


class FreeRunningKey(unittest.TestCase):
    def test_key_replaces_model_choice(self):
        tokens = ["X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\n", "V: Vocal", "\n", "K", ":", "Em", "\n"]
        self.assertTrue(rewrite_all(keys.KeyHeader("D"), tokens).endswith("V: Vocal\nK:D\n"))

    def test_key_inside_one_token(self):
        tokens = ["Q:1/4=100", "\nK:Am\n%"]
        self.assertEqual(rewrite_all(keys.KeyHeader("G"), tokens), "Q:1/4=100\nK:G\n")

    def test_auto_leaves_text_alone(self):
        self.assertEqual(keys.KeyHeader(None).rewrite("\nK:Em\n"), ("\nK:Em\n", ""))

    def test_only_the_header_key(self):
        header = keys.KeyHeader("D")
        rewrite_all(header, ["\nK:", "Em\n"])
        self.assertEqual(header.rewrite("K:Bm\n"), ("K:Bm\n", ""))  # later lines are the model's


class RequestKey(unittest.TestCase):
    def params(self, **raw):
        return engine.normalize_params({"style": "pop", "lyrics": "[verse]\nla la", **raw})

    def test_vocal_song(self):
        self.assertEqual(self.params(key="g")["key"], "G")
        self.assertIsNone(self.params()["key"])
        self.assertIsNone(self.params(key="auto")["key"])

    def test_plain_instrumental(self):
        self.assertEqual(self.params(instrumental=True, key="D")["key"], "D")

    def test_timeline_key_and_top_level_key(self):
        layout = {"bpm": 120, "sections": [{"label": "verse", "bars": 4}]}
        top = self.params(instrumental=True, key="D", timeline=layout)
        self.assertEqual((top["key"], top["timeline"]["key"]), ("D", "D"))
        inner = self.params(instrumental=True, timeline={**layout, "key": "Bb"})
        self.assertEqual((inner["key"], inner["timeline"]["key"]), ("Bb", "Bb"))
        self.assertEqual(self.params(instrumental=True, key="bb", timeline={**layout, "key": "Bb"})["key"], "Bb")
        with self.assertRaises(ValueError):
            self.params(instrumental=True, key="D", timeline={**layout, "key": "Bb"})

    def test_key_needs_a_planned_score(self):
        for raw in ({"key": "D", "abc": A_MAJOR_SCORE}, {"key": "D", "cot": "off"}, {"key": "H"}):
            with self.assertRaises(ValueError, msg=raw):
                self.params(**raw)


if __name__ == "__main__":
    unittest.main()

