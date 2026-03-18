# Contributing to EgoLens

Thanks for your interest in contributing! Here's how to get started.

## Development

```bash
git clone https://github.com/egolens/egolens.git
cd egolens
npm install
npm run dev
```

The dev server runs at `http://localhost:5173`. Drop a dataset folder into the browser to load data.

## Project Structure

```
src/
├── adapters/        # Dataset-specific logic (Waymo, nuScenes, AV2)
├── components/      # React components (LidarViewer, CameraPanel, Timeline)
├── stores/          # Zustand state management
├── workers/         # Web Workers for Parquet I/O and LiDAR conversion
├── utils/           # Shared utilities (parquet, range image math, etc.)
└── types/           # TypeScript type definitions
```

## Before Submitting a PR

1. **Type-check**: `npm run build` (runs `tsc -b` then Vite build)
2. **Lint**: `npm run lint`
3. **Test**: `npm test`

All three should pass cleanly.

## Guidelines

- Keep changes focused — one feature or fix per PR
- Write descriptive commit messages (what and why, not just what)
- Add tests for new utilities or data processing logic
- Don't commit dataset files, credentials, or `.env` files

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Browser and OS info
- Dataset type (Waymo / nuScenes / AV2) if relevant

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
