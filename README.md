# @synergenius/flow-weaver-pack-gitlab-ci

GitLab CI/CD export target for [Flow Weaver](https://github.com/synergenius-fw/flow-weaver).

Generates native `.gitlab-ci.yml` files from Flow Weaver CI/CD workflows. No runtime dependency — outputs pure GitLab CI YAML.

## Installation

```bash
npm install @synergenius/flow-weaver-pack-gitlab-ci
```

This package is a **marketplace pack** — once installed, Flow Weaver automatically discovers it via `createTargetRegistry()`.

## Usage

### CLI

```bash
# Export a CI/CD workflow as GitLab CI YAML
npx flow-weaver export my-pipeline.ts --target gitlab-ci
```

### Programmatic

```typescript
import { createTargetRegistry } from '@synergenius/flow-weaver/deployment';

const registry = await createTargetRegistry(process.cwd());
const gitlab = registry.get('gitlab-ci');

const artifacts = await gitlab.generate({
  sourceFile: 'my-pipeline.ts',
  workflowName: 'myPipeline',
  displayName: 'my-pipeline',
  outputDir: './dist/gitlab-ci',
});
```

## What it generates

- `.gitlab-ci.yml` — Native GitLab CI configuration
- `SECRETS_SETUP.md` — Documentation for required CI/CD variables

### Mapping

| Flow Weaver | GitLab CI |
|-------------|-----------|
| `[job: "name"]` annotation | Job with `stage:` |
| `@path` dependencies | Stage ordering |
| `@secret NAME` | `$NAME` variable |
| `@cache` | Native `cache:` keyword |
| `@artifact` | Native `artifacts:` keyword |
| `@trigger push` | `rules:` conditions |
| `@environment` | `environment:` with optional `when: manual` |

## Requirements

- `@synergenius/flow-weaver` >= 0.14.0

## License

See [LICENSE](./LICENSE).
