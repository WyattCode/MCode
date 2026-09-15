---
name: modern-python-toolchain
description: Set up and run Python projects with uv, ruff and pyright. Use when starting a new Python project, a task needs Python and the project has no pyproject.toml yet, dependencies need adding or locking, or the user asks for linting, formatting, type checking or a virtual environment.
aliases:
  - python-setup
---

# Python with uv, ruff and pyright

## Check what is there

- `uv --version`, `python --version` (on Windows `py -0` lists installed Pythons).
- In an existing project, read `pyproject.toml`, any `requirements*.txt`,
  `uv.lock`, `poetry.lock` or `setup.cfg` first, and keep the tool it already
  uses unless the user wants to move.

If uv is missing, ask before installing it. The official installers are
`powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
on Windows and `curl -LsSf https://astral.sh/uv/install.sh | sh` elsewhere; show
the command and let the user choose.

## New project

```
uv init my-project            # or `uv init` inside an existing folder
cd my-project
uv add requests               # runtime dependency
uv add --dev ruff pyright pytest
uv run python main.py
```

uv creates `.venv` and `uv.lock`; commit the lock file, not the venv.

## Everyday commands

- Run anything in the project environment: `uv run <command>`.
- Add or remove: `uv add pkg`, `uv remove pkg`; upgrade one: `uv lock --upgrade-package pkg`.
- Recreate the environment from the lock: `uv sync`.
- Pin the Python version: `uv python pin 3.12`.

## Lint, format, type-check, test

```
uv run ruff check --fix .
uv run ruff format .
uv run pyright
uv run pytest
```

Configure them in `pyproject.toml`:

```
[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.pyright]
typeCheckingMode = "standard"
```

Run all four before saying Python work is done, and report what each said.

## Moving from requirements.txt

`uv add -r requirements.txt` imports the list into pyproject.toml; check the
versions it resolved, then remove the old file only if the user agrees.
