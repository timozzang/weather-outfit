#!/usr/bin/env python3
"""Replace __KMA_KEY__ in config.js with $KMA_SERVICE_KEY (never prints the key)."""
import os, sys, json
k = os.environ.get("KMA_SERVICE_KEY", "").strip()
if not k: sys.exit("KMA_SERVICE_KEY not set")
s = open("config.js").read()
if "__KMA_KEY__" not in s: sys.exit("placeholder not found (already injected?)")
open("config.js", "w").write(s.replace('"__KMA_KEY__"', json.dumps(k)))
print("config.js: key injected")
