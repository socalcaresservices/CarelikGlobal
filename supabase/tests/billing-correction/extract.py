#!/usr/bin/env python3
"""Print one function definition, verbatim, from a production migration file:
from 'create or replace function public.<name>(' to the end of its $$ body."""
import re, sys
path, name = sys.argv[1], sys.argv[2]
src = open(path).read()
start = src.index(f"create or replace function public.{name}(")
body = src.index("$$", start)
end = src.index("$$", body + 2)
semi = src.index(";", end)
print(src[start:semi + 1])
