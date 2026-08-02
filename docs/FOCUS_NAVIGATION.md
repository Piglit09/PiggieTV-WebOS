# Focus and remote navigation

## Principles

- Focus is explicit and component registered through `components/FocusableButton`.
- Arrow keys are translated to directional movement in `focus/FocusManager`.
- Enter/OK activates the focused node.
- Back navigation uses route history stack.

## Requirements covered

- Stable focus IDs (`focusId`).
- Visible focus ring in `global.css`.
- Directional fallback when no target exists in requested direction.
- Pointer interaction marks focus as pointer-driven.
- Focus remains on-screen components as rows are re-rendered.

## Test strategy

- Unit test `FocusManager` move and activate behavior.
- Manual test with remote:
  - Up/Down/Left/Right transitions across rows and cards
  - Return path from details/playback to prior card
