# Find ledger entry headings that were SWALLOWED INTO PROSE.
#
# docs/overnight/ledger.md is append-at-top and written concurrently by several
# sessions. A write that splices on the SUBSTRING "### " rather than a line-start
# "^### " lands mid-sentence: the new entry's heading ends up inside another
# line (so it has no heading of its own) and the host sentence's tail becomes a
# bogus heading. Nothing is deleted and the heading COUNT GOES UP, so the
# ledger-guard's set/count checks both pass while the file is damaged.
#
# Happened 2026-08-13 (697dd86b), which cut the ledger's own clock-trap header in
# half by splicing on the `### <date>` that header quotes as a format example —
# plus three earlier instances on 2026-08-11 that are still live in the file.
#
# ⚠ THE OBVIOUS RULE DOES NOT WORK. "Flag a mid-line `### <date>` not preceded by
# a backtick" misses 697dd86b exactly, because that splice landed immediately
# AFTER the header's quoting backtick. What actually distinguishes a deliberate
# prose CITATION of a heading from a swallowed one is a CLOSED code span: a
# backtick immediately before AND a closing backtick after, on the same line.
#
# Usage:
#   awk -f scripts/find-swallowed-ledger-headings.awk docs/overnight/ledger.md
#     → prints the count (0 when clean)
#   awk -v show=1 -f ... → prints "<line>: <text>" for each offender instead
{
  line = $0
  if (match(line, /### [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/) && RSTART > 1) {
    before = substr(line, RSTART - 1, 1)
    rest = substr(line, RSTART + RLENGTH)
    cited = (before == "`" && index(rest, "`") > 0)
    if (!cited) {
      n++
      if (show) printf "%d: %.200s\n", NR, line
    }
  }
}
END { if (!show) print n + 0 }
