# Patches

Each `*.json` file here is an array of operations applied to the config set
after it loads, in filename order. They are host choices, not genuine data:
an empty directory is the genuine game, and anything applied is logged as
non-genuine.

```json
[{"file": "Characters", "section": "Character", "id": "slurms",
  "op": "merge", "value": {"briberyId": null}}]
```

- `op` is `set` (replace the row), `merge` (shallow field merge) or `delete`.
- Dict sections are addressed by key; list sections by the row's `id` field.
- An unknown file, section or id rejects the whole file and keeps the last
  good generation.

Changes take effect on the client's next cold launch, because `config` is only
fetched at cold boot.

`*.json` here is gitignored apart from `example.json`.
