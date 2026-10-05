<!-- Thanks! One change per pull request, please. For anything big, open an issue first so we can agree on the approach. -->

## What and why

<!-- What changes for the user, and why it's needed. Link the issue if there is one. -->

## How it was tested

<!-- What you ran, on which OS; real clusters or the mock UI (`npm run dev` in `ui/`). For UI changes: screenshots in the dark and the light theme. -->

## Checklist

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass (in `ui/`)
- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass
- [ ] New UI works from the keyboard and in both themes
- [ ] No real cluster names, hosts, tokens or other private data in code, tests or screenshots
