## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## Python environment

Activate the project's Conda environment before running Python commands:

```bash
conda activate meal
```

## Engineering principles

- Keep edits minimal. Delete obsolete code instead of layering compatibility paths.
- Modify existing functions in place. Do not create a new version of, or rename, a function.
- Do not over-engineering.
- Aim for simple, elegant implementations.
- Use `gh stack` to stacked PRs break large changes into a chain of small, reviewable pull requests that build on each other. 
- Prevent to do unnessesary tests as much as possible

## Project directories

- `foods_center/`: Stable, production-ready code for the food backend and its data.
- `prototype/`: Rapid implementations for exploring UI, UX, and business flows.
- `lab/`: Short-lived, hands-on experiments with AI, data, approaches, and theories.
