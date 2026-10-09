# Bundled application fonts

WHARF bundles its existing Figtree and JetBrains Mono variable fonts so production
builds do not depend on Google Fonts network responses. Next.js serves these
assets locally through `next/font/local`.

Original font files from the Google Fonts repository:

- [Figtree](https://github.com/google/fonts/tree/main/ofl/figtree)
- [JetBrains Mono](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono)

Both fonts use the SIL Open Font License 1.1. Their original license and copyright
notices are included in `Figtree-OFL.txt` and `JetBrainsMono-OFL.txt`.
