# Architecture diagram sources

[`trinitymatrix-architecture.mmd`](trinitymatrix-architecture.mmd) is the editable
Mermaid source for [`trinitymatrix-architecture.svg`](trinitymatrix-architecture.svg).
The SVG is embedded in the [architecture guide](../ARCHITECTURE.md), so it can be
viewed without a Mermaid renderer and reused in presentations.

Regenerate it with the Mermaid CLI:

```sh
npx --yes --package=@mermaid-js/mermaid-cli@12.2.0 mmdc \
  --input docs/diagrams/trinitymatrix-architecture.mmd \
  --output docs/diagrams/trinitymatrix-architecture.svg \
  --configFile docs/diagrams/mermaid.config.json \
  --backgroundColor white --size 1800
```

Keep the source and rendered image in the same commit. Check labels and arrows
after regeneration. This renderer is a documentation tool, not an application
dependency. Additional sequence diagrams live directly in `ARCHITECTURE.md` and
render in GitHub Markdown.
