#!/usr/bin/env python3
"""Print one function definition, verbatim, from a production migration file:
from 'create or replace function public.<name>(' to the end of its dollar-quoted
body ($$ or $tag$), including the terminating semicolon."""
import re, sys
path, name = sys.argv[1], sys.argv[2]
src = open(path).read()
start = src.index(f"create or replace function public.{name}(")
tag = re.compile(r"\$[A-Za-z_]*\$").search(src, start)
end = src.index(tag.group(0), tag.end())
semi = src.index(";", end)
print(src[start:semi + 1])
