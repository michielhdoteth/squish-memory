import os, sys

todo_path = sys.argv[1]
with open(todo_path) as f:
    lines = f.readlines()

out = []
for i, line in enumerate(lines):
    if i == 0:
        out.append("pick " + line.split(None, 1)[1] if line.strip() else line)
    else:
        out.append("squash " + line.split(None, 1)[1] if line.strip() else line)

with open(todo_path, "w") as f:
    f.writelines(out)
